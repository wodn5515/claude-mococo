import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runHaiku } from '../utils/haiku.js';
import type { TeamsConfig, TeamConfig } from '../types.js';

const SCAN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

type InvocationTrigger = (team: TeamConfig, channelId: string, systemMessage: string) => void;

const SCANNABLE_EXTENSIONS = new Set(['.ts', '.js', '.py', '.json', '.md']);
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);
const EXCLUDED_PATTERNS = [/\.lock$/];
const EXCLUDED_REPOS = new Set(['atom.io']);

// ---------------------------------------------------------------------------
// Git helper -- run git command via spawn
// ---------------------------------------------------------------------------

const MAX_GIT_OUTPUT_BYTES = 1024 * 1024; // 1MB limit

interface GitResult {
  output: string;
  truncated: boolean;
  stderr: string;
}

const MAX_STDERR_BYTES = 4096;
const TIMEOUT_MS = 30_000;

function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`git timed out after ${TIMEOUT_MS}ms (cmd: git ${args.join(' ')})`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      stdout += chunk.toString();
      if (stdout.length > MAX_GIT_OUTPUT_BYTES) {
        stdout = stdout.slice(0, MAX_GIT_OUTPUT_BYTES);
        truncated = true;
        console.warn(`[improvement-scanner] git output truncated at ${MAX_GIT_OUTPUT_BYTES} bytes (cmd: git ${args.join(' ')}). Killing child process`);
        child.kill('SIGTERM');
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += chunk.toString();
        if (stderr.length > MAX_STDERR_BYTES) {
          stderr = stderr.slice(0, MAX_STDERR_BYTES);
        }
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (truncated) {
        if (stderr) console.warn(`[improvement-scanner] git stderr: ${stderr.slice(0, 200)}`);
        resolve({ output: stdout.trim(), truncated, stderr });
      } else if (code === 0) {
        resolve({ output: stdout.trim(), truncated, stderr });
      } else {
        reject(new Error(`git exited with code ${code}: ${stderr.slice(0, 300)}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// scanRepoFiles -- list recently changed files, sorted by change frequency
// Strategy: recent N commits → changed files → deduplicate → sort by frequency
// ---------------------------------------------------------------------------

const RECENT_COMMITS_COUNT = 15; // Analyze last 15 commits (출력 크기 감소로 truncation 재시도 최소화)

interface FileEntry {
  filePath: string;       // relative path within repo
  changeCount: number;    // how many times changed in recent commits
  lastModified: number;   // unix timestamp of most recent change
}

function isScannableFile(filePath: string): boolean {
  const ext = path.extname(filePath);
  if (!SCANNABLE_EXTENSIONS.has(ext)) return false;
  if (EXCLUDED_PATTERNS.some(p => p.test(filePath))) return false;

  const parts = filePath.split(path.sep);
  return !parts.some(part => EXCLUDED_DIRS.has(part));
}

async function scanRepoFiles(repoPath: string): Promise<FileEntry[]> {
  // Get files changed in recent N commits with timestamps
  // git log -N --format="%at" --name-only --diff-filter=ACMR
  // truncation 발생 시 더 적은 커밋 수로 재시도
  let output = '';
  let commitCount = RECENT_COMMITS_COUNT;
  const MIN_COMMITS = 5;

  while (commitCount >= MIN_COMMITS) {
    try {
      const result = await runGit(
        ['log', `-${commitCount}`, '--format=%at', '--name-only', '--diff-filter=ACMR', '--no-renames'],
        repoPath,
      );
      if (result.truncated && commitCount > MIN_COMMITS) {
        const reduced = Math.max(MIN_COMMITS, Math.floor(commitCount / 2));
        console.warn(`[improvement-scanner] Output truncated with ${commitCount} commits, retrying with ${reduced}`);
        commitCount = reduced;
        continue;
      }
      output = result.output;
      break;
    } catch {
      return [];
    }
  }

  if (!output) return [];

  // Track change frequency and latest timestamp per file
  const fileStats = new Map<string, { changeCount: number; lastModified: number }>();
  let currentTimestamp = 0;

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^\d+$/.test(trimmed)) {
      currentTimestamp = parseInt(trimmed, 10);
      continue;
    }

    const filePath = trimmed;
    if (!isScannableFile(filePath)) continue;
    if (currentTimestamp === 0) continue; // skip files before first timestamp

    const existing = fileStats.get(filePath);
    if (existing) {
      existing.changeCount++;
      if (currentTimestamp > existing.lastModified) {
        existing.lastModified = currentTimestamp;
      }
    } else {
      fileStats.set(filePath, { changeCount: 1, lastModified: currentTimestamp });
    }
  }

  // Convert to array, verify existence, sort by change frequency (descending)
  const entries: FileEntry[] = [];
  for (const [filePath, stats] of fileStats) {
    const fullPath = path.join(repoPath, filePath);
    try {
      fs.accessSync(fullPath, fs.constants.R_OK);
      entries.push({ filePath, changeCount: stats.changeCount, lastModified: stats.lastModified });
    } catch {
      // File was deleted; skip
    }
  }

  // Most frequently changed files first (hotspots)
  entries.sort((a, b) => b.changeCount - a.changeCount || b.lastModified - a.lastModified);
  return entries;
}

// ---------------------------------------------------------------------------
// buildScanPrompt -- construct Haiku analysis prompt
// ---------------------------------------------------------------------------

interface IssueItem {
  file: string;
  repo: string;
  type: 'refactoring' | 'security' | 'error-risk' | 'performance' | 'code-quality';
  severity: 'high' | 'medium' | 'low';
  description: string;
  suggestion: string;
}

function buildScanPrompt(
  repoName: string,
  files: { filePath: string; content: string }[],
  existingIssues?: IssueItem[],
): string {
  // 파일 경로와 내용을 JSON.stringify로 인코딩하여 프롬프트 인젝션 방지
  const fileEntries = files
    .map(f => `### ${JSON.stringify(f.filePath).slice(1, -1)}\n\`\`\`\n${f.content.replace(/```/g, '` ` `')}\n\`\`\``)
    .join('\n\n');

  const safeRepoName = JSON.stringify(repoName).slice(1, -1);

  // 기존 이슈 목록을 프롬프트에 포함 — 이미 보고된 이슈는 재보고 방지
  let existingIssuesSection = '';
  if (existingIssues && existingIssues.length > 0) {
    const repoIssues = existingIssues.filter(i => i.repo === repoName);
    if (repoIssues.length > 0) {
      const issueList = repoIssues
        .map(i => `- [${i.severity}] ${i.file}: ${i.type} — ${i.description.slice(0, 100)}`)
        .join('\n');
      existingIssuesSection = `

## Previously Reported Issues (DO NOT re-report these)
The following issues have already been reported. Do NOT include them again unless the code has fundamentally changed in a way that makes the previous report inaccurate.
${issueList}
`;
    }
  }

  return `You are a senior code reviewer analyzing files from the "${safeRepoName}" repository.
These files have been frequently modified recently and are potential hotspots that may need attention.

## Files to Analyze

${fileEntries}
${existingIssuesSection}
## Analysis Criteria
For each file, check for:
1. **refactoring** -- code that is overly complex, duplicated, or hard to maintain
2. **security** -- potential security vulnerabilities (hardcoded secrets, injection risks, etc.)
3. **error-risk** -- missing error handling, potential runtime errors, edge cases
4. **performance** -- inefficient algorithms, unnecessary I/O, memory leaks
5. **code-quality** -- poor naming, missing types, inconsistent patterns, dead code

## Output Rules
- Output ONLY a valid JSON array (no markdown fencing, no explanation)
- Each element must follow this exact schema:
\`\`\`
{
  "file": "relative/path/to/file.ts",
  "repo": "${safeRepoName}",
  "type": "refactoring|security|error-risk|performance|code-quality",
  "severity": "high|medium|low",
  "description": "문제 설명 (Korean)",
  "suggestion": "권장 해결 방안 (Korean)"
}
\`\`\`
- Only report **NEW** genuine issues worth fixing. Do NOT fabricate issues.
- Do NOT re-report previously reported issues unless the underlying code has significantly changed.
- If a file ends with a "truncated" comment, do NOT report it as incomplete or broken — the code continues beyond what is shown.
- If no new issues are found, return an empty array: []`;
}

// ---------------------------------------------------------------------------
// improvementLoop -- main scan logic
// ---------------------------------------------------------------------------

async function improvementLoop(config: TeamsConfig): Promise<void> {
  const ws = config.workspacePath;
  const reposDir = path.resolve(ws, 'repos');

  let repoDirs: string[];
  try {
    repoDirs = fs.readdirSync(reposDir).filter(name => {
      if (EXCLUDED_REPOS.has(name)) return false;
      const fullPath = path.join(reposDir, name);
      try {
        return fs.statSync(fullPath).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    console.warn('[improvement-scanner] repos directory not found, skipping scan');
    return;
  }

  if (repoDirs.length === 0) {
    console.log('[improvement-scanner] No repos found, skipping scan');
    return;
  }

  // Load existing issues for merge and duplicate prevention
  const inboxDir = path.resolve(ws, '.mococo/inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  const outputPath = path.resolve(inboxDir, 'improvement.json');

  interface PersistedIssue extends IssueItem {
    detectedAt: string;
  }

  let existingIssues: PersistedIssue[] = [];
  try {
    const raw = fs.readFileSync(outputPath, 'utf-8');
    const data = JSON.parse(raw) as { issues?: PersistedIssue[] };
    if (data.issues && Array.isArray(data.issues)) {
      existingIssues = data.issues;
    }
  } catch {
    // No existing file or parse error — start fresh
  }

  // Build lookup for existing issues (to preserve detectedAt timestamps)
  const existingByKey = new Map<string, PersistedIssue>();
  for (const issue of existingIssues) {
    existingByKey.set(issueKey(issue), issue);
  }

  const newlyDetected: IssueItem[] = [];

  for (const repoName of repoDirs) {
    const repoPath = path.join(reposDir, repoName);

    // Check if it's a git repo
    try {
      fs.accessSync(path.join(repoPath, '.git'), fs.constants.R_OK);
    } catch {
      continue; // Not a git repo, skip
    }

    console.log(`[improvement-scanner] Scanning ${repoName}...`);

    try {
      const files = await scanRepoFiles(repoPath);
      if (files.length === 0) continue;

      // Take top 15 most frequently changed files (hotspots)
      const targetFiles = files.slice(0, 15);

      // Read each file (up to MAX_LINES_PER_FILE lines to avoid token overflow)
      const MAX_LINES_PER_FILE = 300;
      const fileContents: { filePath: string; content: string }[] = [];
      const readPromises = targetFiles.map(async (entry) => {
        try {
          const fullPath = path.join(repoPath, entry.filePath);
          const raw = await fs.promises.readFile(fullPath, 'utf-8');
          const lines = raw.split('\n');
          const truncated = lines.length > MAX_LINES_PER_FILE;
          const content = lines.slice(0, MAX_LINES_PER_FILE).join('\n')
            + (truncated ? `\n// ... (truncated: ${lines.length - MAX_LINES_PER_FILE} more lines)` : '');
          return { filePath: entry.filePath, content };
        } catch {
          return null;
        }
      });
      const results = await Promise.all(readPromises);
      for (const r of results) {
        if (r) fileContents.push(r);
      }

      if (fileContents.length === 0) continue;

      // Pass existing issues to Haiku to prevent re-reporting
      const prompt = buildScanPrompt(repoName, fileContents, existingIssues);
      const output = await runHaiku(prompt);

      // Parse JSON output from Haiku
      const parsed = parseHaikuOutput(output);
      if (parsed.length === 0 && output.trim().length > 0) {
        console.warn(`[improvement-scanner] Haiku output for ${repoName} could not be parsed (${output.length} chars)`);
      }
      newlyDetected.push(...parsed);

    } catch (err) {
      console.error(`[improvement-scanner] Error scanning ${repoName}: ${err}`);
    }
  }

  // Merge: preserve existing issues that are re-detected, add new ones, remove resolved
  const now = new Date().toISOString();
  const mergedIssues: PersistedIssue[] = [];
  const newlyDetectedKeys = new Set<string>();

  for (const issue of newlyDetected) {
    const key = issueKey(issue);
    newlyDetectedKeys.add(key);

    const existing = existingByKey.get(key);
    if (existing) {
      // Re-detected — preserve original detectedAt
      mergedIssues.push(existing);
    } else {
      // Genuinely new issue
      mergedIssues.push({ ...issue, detectedAt: now });
    }
  }

  // Log resolved issues (existed before but not re-detected)
  const resolvedCount = existingIssues.filter(i => !newlyDetectedKeys.has(issueKey(i))).length;
  if (resolvedCount > 0) {
    console.log(`[improvement-scanner] ${resolvedCount} issue(s) resolved (auto-removed)`);
  }

  const result = {
    lastScanAt: now,
    issues: mergedIssues,
  };

  // Atomic write: write to temp file then rename to prevent data corruption
  const tmpPath = `${outputPath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(result, null, 2));
    fs.renameSync(tmpPath, outputPath);
  } catch (err) {
    console.error(`[improvement-scanner] Failed to write improvement.json: ${err}`);
    // Clean up temp file if rename failed
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return;
  }
  const newCount = newlyDetected.filter(i => !existingByKey.has(issueKey(i))).length;
  const keptCount = mergedIssues.length - newCount;
  console.log(`[improvement-scanner] Scan complete: ${mergedIssues.length} issue(s) total (${keptCount} existing, ${newCount} new, ${resolvedCount} resolved) across ${repoDirs.length} repo(s)`);
}

// ---------------------------------------------------------------------------
// parseHaikuOutput -- safely parse JSON from Haiku response
// ---------------------------------------------------------------------------

function parseHaikuOutput(output: string): IssueItem[] {
  // Try to extract JSON array from response (handle markdown fencing)
  let jsonStr = output.trim();

  // Strip markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Find the JSON array boundaries
  const startIdx = jsonStr.indexOf('[');
  const endIdx = jsonStr.lastIndexOf(']');
  if (startIdx === -1 || endIdx === -1) return [];

  jsonStr = jsonStr.slice(startIdx, endIdx + 1);

  try {
    const parsed: unknown = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];

    const validTypes = new Set(['refactoring', 'security', 'error-risk', 'performance', 'code-quality']);
    const validSeverities = new Set(['high', 'medium', 'low']);

    return parsed.filter((item): item is IssueItem => {
      if (typeof item !== 'object' || item === null) return false;
      const obj = item as Record<string, unknown>;
      return (
        typeof obj.file === 'string' &&
        typeof obj.repo === 'string' &&
        typeof obj.type === 'string' && validTypes.has(obj.type) &&
        typeof obj.severity === 'string' && validSeverities.has(obj.severity) &&
        typeof obj.description === 'string' &&
        typeof obj.suggestion === 'string'
      );
    });
  } catch {
    console.warn('[improvement-scanner] Failed to parse Haiku JSON output');
    return [];
  }
}

// ---------------------------------------------------------------------------
// notifyLeaderOfNewIssues -- event-driven leader notification after scan
// ---------------------------------------------------------------------------

const MAX_TRACKED_ISSUE_KEYS = 500;
let previousIssueKeys = new Set<string>();

// 중복 알림 차단: 마지막 알림 후 최소 대기 시간 (2시간)
const NOTIFICATION_COOLDOWN_MS = 2 * 60 * 60 * 1000;
let lastNotificationTime = 0;

function issueKey(issue: { file: string; repo: string; type: string; description: string }): string {
  return `${issue.repo}::${issue.file}::${issue.type}::${issue.description}`;
}

/**
 * Check improvement.json for new issues and notify leader.
 * Called once after each scan completes (event-driven, not polling).
 */
function notifyLeaderOfNewIssues(
  config: TeamsConfig,
  triggerInvocation: InvocationTrigger,
  improvementChannelId?: string,
): void {
  const ws = config.workspacePath;
  const improvementPath = path.resolve(ws, '.mococo/inbox/improvement.json');

  try {
    const raw = fs.readFileSync(improvementPath, 'utf-8');
    const data = JSON.parse(raw) as {
      lastScanAt: string;
      issues: { file: string; repo: string; type: string; severity: string; description: string; suggestion: string; detectedAt: string }[];
    };

    if (!data.issues || !Array.isArray(data.issues)) return;

    // Find new issues not seen before
    const currentKeys = new Set<string>();
    const newIssues: typeof data.issues = [];

    for (const issue of data.issues) {
      const key = issueKey(issue);
      currentKeys.add(key);
      if (!previousIssueKeys.has(key)) {
        newIssues.push(issue);
      }
    }

    // Update tracked keys (cap size to prevent memory growth)
    if (currentKeys.size > MAX_TRACKED_ISSUE_KEYS) {
      const keysArray = [...currentKeys];
      previousIssueKeys = new Set(keysArray.slice(keysArray.length - MAX_TRACKED_ISSUE_KEYS));
    } else {
      previousIssueKeys = currentKeys;
    }

    if (newIssues.length === 0) {
      console.log('[improvement-monitor] No new issues detected');
      return;
    }

    // 중복 알림 차단: 마지막 알림 후 최소 대기 시간 경과 확인
    const now = Date.now();
    const timeSinceLastNotification = now - lastNotificationTime;
    if (lastNotificationTime > 0 && timeSinceLastNotification < NOTIFICATION_COOLDOWN_MS) {
      const remainingMinutes = Math.ceil((NOTIFICATION_COOLDOWN_MS - timeSinceLastNotification) / 60_000);
      console.log(`[improvement-monitor] ${newIssues.length} new issue(s) detected — notification suppressed (cooldown: ${remainingMinutes}분 남음)`);
      return;
    }

    // Find leader team
    const leaderTeam = Object.values(config.teams).find(t => t.isLeader);
    if (!leaderTeam) return;

    // Notify leader of new issues
    if (!improvementChannelId) {
      // No channel configured — rely on leaderHeartbeat reading improvement.json directly
      console.log(`[improvement-monitor] ${newIssues.length} new issue(s) detected (no channelId — leaderHeartbeat will pick up from improvement.json)`);
    } else {
      const systemMessage = `[개선사항 발견] ${newIssues.length}개 코드 개선 항목 — 검토 및 작업 배정 필요`;
      console.log(`[improvement-monitor] ${systemMessage}`);
      triggerInvocation(leaderTeam, improvementChannelId, systemMessage);
      lastNotificationTime = now; // 알림 발송 시각 기록
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Only log if file exists but is malformed (not ENOENT)
    if (!errMsg.includes('ENOENT')) {
      console.warn(`[improvement-monitor] Error reading improvement.json: ${errMsg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point -- start improvement scanner
// ---------------------------------------------------------------------------

export function startImprovementScanner(
  config: TeamsConfig,
  triggerInvocation: InvocationTrigger,
  improvementChannelId?: string,
): void {
  console.log('[improvement-scanner] Started (interval: 30min, event-driven notify)');

  // Initialize previous issue keys from existing file
  const improvementPath = path.resolve(config.workspacePath, '.mococo/inbox/improvement.json');
  try {
    const raw = fs.readFileSync(improvementPath, 'utf-8');
    const data = JSON.parse(raw) as { issues?: { file: string; repo: string; type: string; description: string }[] };
    if (data.issues && Array.isArray(data.issues)) {
      for (const issue of data.issues) {
        previousIssueKeys.add(issueKey(issue));
      }
    }
  } catch {
    // No existing file, start clean
  }

  // Guard against overlapping scans
  let scanRunning = false;

  // Scan → notify leader (event-driven: notify runs immediately after scan completes)
  async function runScanAndNotify(): Promise<void> {
    if (scanRunning) {
      console.warn('[improvement-scanner] Previous scan still running, skipping');
      return;
    }
    scanRunning = true;
    try {
      await improvementLoop(config);
      notifyLeaderOfNewIssues(config, triggerInvocation, improvementChannelId);
    } finally {
      scanRunning = false;
    }
  }

  // Recursive setTimeout instead of setInterval to prevent overlapping
  function scheduleNextScan(): void {
    setTimeout(() => {
      runScanAndNotify()
        .catch(err => console.error(`[improvement-scanner] Unhandled error: ${err}`))
        .finally(() => scheduleNextScan());
    }, SCAN_INTERVAL_MS);
  }

  // Run first scan after 2 minutes (let system settle), then schedule recurring
  setTimeout(() => {
    runScanAndNotify()
      .catch(err => console.error(`[improvement-scanner] Unhandled error: ${err}`))
      .finally(() => scheduleNextScan());
  }, 2 * 60_000);
}
