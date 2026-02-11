import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { TeamsConfig, TeamConfig } from '../types.js';

const SCAN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MONITOR_INTERVAL_MS = 60_000;       // 60 seconds

type InvocationTrigger = (team: TeamConfig, channelId: string, systemMessage: string) => void;

const SCANNABLE_EXTENSIONS = new Set(['.ts', '.js', '.py', '.json', '.md']);
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);
const EXCLUDED_PATTERNS = [/\.lock$/];

// ---------------------------------------------------------------------------
// Shared utility -- run haiku via claude CLI
// ---------------------------------------------------------------------------

function runHaiku(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '-p',
      '--model', 'haiku',
      '--max-turns', '1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    child.stdin.write(prompt);
    child.stdin.end();

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Git helper -- run git command via spawn
// ---------------------------------------------------------------------------

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`git exited with code ${code}: ${stderr.slice(0, 300)}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// scanRepoFiles -- list files sorted by oldest modification first
// ---------------------------------------------------------------------------

interface FileEntry {
  filePath: string;     // relative path within repo
  lastModified: number; // unix timestamp
}

function isScannableFile(filePath: string): boolean {
  const ext = path.extname(filePath);
  if (!SCANNABLE_EXTENSIONS.has(ext)) return false;
  if (EXCLUDED_PATTERNS.some(p => p.test(filePath))) return false;

  const parts = filePath.split(path.sep);
  return !parts.some(part => EXCLUDED_DIRS.has(part));
}

async function scanRepoFiles(repoPath: string): Promise<FileEntry[]> {
  // Get all tracked files with their last commit timestamp
  // Using: git log --all --format="%at" --name-only --diff-filter=ACMR
  // Then parse to get the most recent timestamp per file
  let output: string;
  try {
    output = await runGit(
      ['log', '--all', '--format=%at', '--name-only', '--diff-filter=ACMR'],
      repoPath,
    );
  } catch {
    return [];
  }

  if (!output) return [];

  const fileTimestamps = new Map<string, number>();
  let currentTimestamp = 0;

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Lines that are pure numbers are timestamps
    if (/^\d+$/.test(trimmed)) {
      currentTimestamp = parseInt(trimmed, 10);
      continue;
    }

    // Otherwise it's a file path
    const filePath = trimmed;
    if (!isScannableFile(filePath)) continue;

    // Keep the most recent timestamp per file
    const existing = fileTimestamps.get(filePath);
    if (!existing || currentTimestamp > existing) {
      fileTimestamps.set(filePath, currentTimestamp);
    }
  }

  // Convert to array and sort by oldest first
  const entries: FileEntry[] = [];
  for (const [filePath, lastModified] of fileTimestamps) {
    // Verify file still exists on disk
    const fullPath = path.join(repoPath, filePath);
    try {
      fs.accessSync(fullPath, fs.constants.R_OK);
      entries.push({ filePath, lastModified });
    } catch {
      // File was deleted; skip
    }
  }

  entries.sort((a, b) => a.lastModified - b.lastModified);
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

function buildScanPrompt(repoName: string, files: { filePath: string; content: string }[]): string {
  const fileEntries = files
    .map(f => `### ${f.filePath}\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');

  return `You are a senior code reviewer analyzing files from the "${repoName}" repository.
These files have not been modified recently and may need attention.

## Files to Analyze

${fileEntries}

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
  "repo": "${repoName}",
  "type": "refactoring|security|error-risk|performance|code-quality",
  "severity": "high|medium|low",
  "description": "문제 설명 (Korean)",
  "suggestion": "권장 해결 방안 (Korean)"
}
\`\`\`
- Only report genuine issues worth fixing. Do NOT fabricate issues.
- If no issues are found, return an empty array: []`;
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

  const allIssues: IssueItem[] = [];

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

      // Take top 20 oldest-modified files
      const targetFiles = files.slice(0, 20);

      // Read first 100 lines of each file
      const fileContents: { filePath: string; content: string }[] = [];
      for (const entry of targetFiles) {
        try {
          const fullPath = path.join(repoPath, entry.filePath);
          const raw = fs.readFileSync(fullPath, 'utf-8');
          const first100 = raw.split('\n').slice(0, 100).join('\n');
          fileContents.push({ filePath: entry.filePath, content: first100 });
        } catch {
          // File unreadable, skip
        }
      }

      if (fileContents.length === 0) continue;

      const prompt = buildScanPrompt(repoName, fileContents);
      const output = await runHaiku(prompt);

      // Parse JSON output from Haiku
      const parsed = parseHaikuOutput(output);
      allIssues.push(...parsed);

    } catch (err) {
      console.error(`[improvement-scanner] Error scanning ${repoName}: ${err}`);
    }
  }

  // Save results to improvement.json
  const inboxDir = path.resolve(ws, '.mococo/inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  const outputPath = path.resolve(inboxDir, 'improvement.json');

  const now = new Date().toISOString();
  const result = {
    lastScanAt: now,
    issues: allIssues.map(issue => ({
      ...issue,
      detectedAt: now,
    })),
  };

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(`[improvement-scanner] Scan complete: ${allIssues.length} issue(s) found across ${repoDirs.length} repo(s)`);
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
// improvementMonitorLoop -- leader notification on new issues
// ---------------------------------------------------------------------------

let previousIssueKeys = new Set<string>();

function issueKey(issue: { file: string; repo: string; type: string; description: string }): string {
  return `${issue.repo}::${issue.file}::${issue.type}::${issue.description}`;
}

export function improvementMonitorLoop(
  config: TeamsConfig,
  triggerInvocation: InvocationTrigger,
  improvementChannelId?: string,
): void {
  console.log('[improvement-monitor] Started (interval: 60s)');

  const ws = config.workspacePath;
  const improvementPath = path.resolve(ws, '.mococo/inbox/improvement.json');

  // Initialize previous keys from existing file if present
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

  setInterval(() => {
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

      // Update tracked keys
      previousIssueKeys = currentKeys;

      if (newIssues.length === 0) return;

      // Find leader team
      const leaderTeam = Object.values(config.teams).find(t => t.isLeader);
      if (!leaderTeam) return;

      // Write summary to leader inbox for leader loop to pick up
      if (!improvementChannelId) {
        const inboxDir = path.resolve(ws, '.mococo/inbox');
        fs.mkdirSync(inboxDir, { recursive: true });
        const leaderInbox = path.resolve(inboxDir, `${leaderTeam.id}.md`);
        const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');

        const highCount = newIssues.filter(i => i.severity === 'high').length;
        const summary = newIssues.slice(0, 5).map(i =>
          `  - [${i.severity}] ${i.repo}/${i.file}: ${i.description}`
        ).join('\n');

        const entry = `[${ts} #ch:system] improvement-scanner: ${newIssues.length}개 코드 개선 항목 발견 (high: ${highCount})\n${summary}\n`;
        fs.appendFileSync(leaderInbox, entry);
        console.log(`[improvement-monitor] Wrote ${newIssues.length} new issue(s) to leader inbox`);
      } else {
        const systemMessage = `[개선사항 발견] ${newIssues.length}개 코드 개선 항목 — 검토 및 작업 배정 필요`;
        console.log(`[improvement-monitor] ${systemMessage}`);
        triggerInvocation(leaderTeam, improvementChannelId, systemMessage);
      }
    } catch {
      // File doesn't exist or is malformed; silently continue
    }
  }, MONITOR_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Main entry point -- start improvement scanner
// ---------------------------------------------------------------------------

export function startImprovementScanner(
  config: TeamsConfig,
  triggerInvocation: InvocationTrigger,
  improvementChannelId?: string,
): void {
  console.log('[improvement-scanner] Started (interval: 30min)');

  // Run first scan after 2 minutes (let system settle)
  setTimeout(() => {
    improvementLoop(config).catch(err => {
      console.error(`[improvement-scanner] Unhandled error: ${err}`);
    });

    setInterval(() => {
      improvementLoop(config).catch(err => {
        console.error(`[improvement-scanner] Unhandled error: ${err}`);
      });
    }, SCAN_INTERVAL_MS);
  }, 2 * 60_000);

  // Start monitoring loop for leader notification
  improvementMonitorLoop(config, triggerInvocation, improvementChannelId);
}
