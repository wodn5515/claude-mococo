import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { TeamsConfig, TeamConfig, EnvConfig } from '../types.js';

const LOOP_INTERVAL_MS = 60_000;

type InvocationTrigger = (team: TeamConfig, channelId: string, systemMessage: string) => void;

// ---------------------------------------------------------------------------
// Shared utility — run haiku via claude CLI
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
// Inbox channel parser — group messages by channelId
// ---------------------------------------------------------------------------

function parseInboxChannels(content: string): Map<string, string[]> {
  const channels = new Map<string, string[]>();
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    // Format: [2025-02-10 09:46 #ch:123456789] Sender: message
    const match = line.match(/^\[([^\]]*?)\s+#ch:(\d+)\]\s+(.*)$/);
    if (match) {
      const channelId = match[2];
      const rest = `[${match[1]}] ${match[3]}`; // reconstruct without #ch: for readability
      if (!channels.has(channelId)) channels.set(channelId, []);
      channels.get(channelId)!.push(rest);
    } else {
      // Fallback: no channelId — group under 'unknown'
      if (!channels.has('unknown')) channels.set('unknown', []);
      channels.get('unknown')!.push(line);
    }
  }
  return channels;
}

// ---------------------------------------------------------------------------
// Leader autonomous loop — haiku evaluates inbox → dispatch teams
// ---------------------------------------------------------------------------

function buildTeamRoleSummary(team: TeamConfig, workspacePath: string): string {
  try {
    const promptPath = path.resolve(workspacePath, team.prompt);
    const content = fs.readFileSync(promptPath, 'utf-8');
    const first30 = content.split('\n').slice(0, 30).join('\n');
    // Extract a one-line role from the first 30 lines
    const roleMatch = first30.match(/(?:역할|role|담당)[：:]\s*(.+)/i)
      || first30.match(/^#\s+(.+)/m);
    return roleMatch ? roleMatch[1].trim() : team.name;
  } catch {
    return team.name;
  }
}

function buildDispatchPrompt(
  teams: TeamConfig[],
  channelMessages: Map<string, string[]>,
  workspacePath: string,
): string {
  const teamList = teams
    .filter(t => !t.isLeader)
    .map(t => `- ${t.id}: ${t.name} — ${buildTeamRoleSummary(t, workspacePath)}`)
    .join('\n');

  let channelSections = '';
  for (const [channelId, messages] of channelMessages) {
    if (channelId === 'unknown') continue;
    channelSections += `\n### Channel #${channelId}\n${messages.join('\n')}\n`;
  }

  return `You are the leader coordinator evaluating conversations for your team.

## Team Members
${teamList}

## New Messages (by channel)
${channelSections || '(no messages)'}

## Rules
- 각 팀의 전문 분야에 맞는 대화가 있으면 해당 팀 호출
- 이미 해결된 대화, 단순 인사, 이미 invoke된 팀에 대해서는 호출 불필요
- 여러 팀을 같은 채널에 호출 가능
- 호출이 필요 없으면 NONE

Output format:
DISPATCH: teamId,channelId,이유 (한 줄에 하나)
DISPATCH: teamId,channelId,이유
(없으면 한 줄: DISPATCH: NONE)
SUMMARY: 리더용 inbox 요약 (한국어 bullet list, 500자 이내)`;
}

interface DispatchResult {
  dispatches: { teamId: string; channelId: string; reason: string }[];
  summary: string;
}

function parseDispatchResult(output: string): DispatchResult {
  const dispatches: { teamId: string; channelId: string; reason: string }[] = [];
  let summary = '';

  const lines = output.split('\n');
  for (const line of lines) {
    const dispatchMatch = line.match(/^DISPATCH:\s*(\S+)\s*,\s*(\S+)\s*,\s*(.+)$/);
    if (dispatchMatch && dispatchMatch[1] !== 'NONE') {
      dispatches.push({
        teamId: dispatchMatch[1],
        channelId: dispatchMatch[2],
        reason: dispatchMatch[3].trim(),
      });
    }

    const summaryMatch = line.match(/^SUMMARY:\s*(.+)$/);
    if (summaryMatch) {
      summary = summaryMatch[1].trim();
    }
  }

  // Multi-line SUMMARY: collect everything after the SUMMARY line
  const summaryIdx = lines.findIndex(l => l.startsWith('SUMMARY:'));
  if (summaryIdx >= 0) {
    const rest = lines.slice(summaryIdx + 1).join('\n').trim();
    if (rest) {
      summary = summary ? `${summary}\n${rest}` : rest;
    }
  }

  return { dispatches, summary };
}

async function leaderLoop(
  config: TeamsConfig,
  triggerInvocation: InvocationTrigger,
): Promise<void> {
  const leaderTeam = Object.values(config.teams).find(t => t.isLeader);
  if (!leaderTeam) return;

  const ws = config.workspacePath;
  const inboxPath = path.resolve(ws, '.mococo/inbox', `${leaderTeam.id}.md`);

  let inboxContent: string;
  try {
    inboxContent = fs.readFileSync(inboxPath, 'utf-8').trim();
  } catch {
    return; // No inbox file
  }

  if (!inboxContent) return;

  // Parse channels from inbox
  const channelMessages = parseInboxChannels(inboxContent);
  if (channelMessages.size === 0) return;

  const allTeams = Object.values(config.teams);
  const prompt = buildDispatchPrompt(allTeams, channelMessages, ws);

  console.log('[leader-loop] Evaluating inbox with haiku...');

  try {
    const output = await runHaiku(prompt);
    const result = parseDispatchResult(output);

    // Execute dispatches
    for (const dispatch of result.dispatches) {
      const team = config.teams[dispatch.teamId];
      if (!team) {
        console.warn(`[leader-loop] Unknown team: ${dispatch.teamId}`);
        continue;
      }

      console.log(`[leader-loop] Dispatching ${team.name} → channel ${dispatch.channelId} (${dispatch.reason})`);
      triggerInvocation(team, dispatch.channelId, `[리더 자율 판단] ${dispatch.reason}`);
    }

    // Save summary to leader's short-term memory
    if (result.summary) {
      const memoryDir = path.resolve(ws, '.mococo/memory', leaderTeam.id);
      fs.mkdirSync(memoryDir, { recursive: true });
      const shortTermPath = path.resolve(memoryDir, 'short-term.md');

      let existing = '';
      try {
        existing = fs.readFileSync(shortTermPath, 'utf-8').trim();
      } catch {}

      const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const updated = existing
        ? `${existing}\n\n## Inbox Summary (${ts})\n${result.summary}`
        : `## Inbox Summary (${ts})\n${result.summary}`;
      fs.writeFileSync(shortTermPath, updated);
    }

    // Clear leader inbox
    try { fs.unlinkSync(inboxPath); } catch {}

    if (result.dispatches.length > 0) {
      console.log(`[leader-loop] Dispatched ${result.dispatches.length} team(s)`);
    } else {
      console.log('[leader-loop] No dispatch needed');
    }
  } catch (err) {
    console.error(`[leader-loop] Error: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Team pending task loop — check short-term memory for 대기 항목
// ---------------------------------------------------------------------------

interface PendingTask {
  channelId: string;
  reason: string;
}

function findPendingTasks(shortTermContent: string): PendingTask[] {
  const tasks: PendingTask[] = [];

  // Find the "### 대기 항목" section
  const sectionMatch = shortTermContent.match(/###\s*대기\s*항목\s*\n([\s\S]*?)(?=\n###|\n##|$)/);
  if (!sectionMatch) return tasks;

  const section = sectionMatch[1];
  // Extract items with #ch:channelId
  const lines = section.split('\n');
  for (const line of lines) {
    const chMatch = line.match(/#ch:(\d+)/);
    if (chMatch) {
      const channelId = chMatch[1];
      // Clean reason: remove the channel marker and bullet points
      const reason = line.replace(/#ch:\d+/, '').replace(/^[\s\-*]+/, '').trim();
      if (reason) {
        tasks.push({ channelId, reason });
      }
    }
  }

  return tasks;
}

async function pendingTaskLoop(
  config: TeamsConfig,
  triggerInvocation: InvocationTrigger,
): Promise<void> {
  const ws = config.workspacePath;

  for (const team of Object.values(config.teams)) {
    if (team.isLeader) continue;

    // Read short-term memory
    const shortTermPath = path.resolve(ws, '.mococo/memory', team.id, 'short-term.md');
    let shortTerm: string;
    try {
      shortTerm = fs.readFileSync(shortTermPath, 'utf-8').trim();
    } catch {
      continue;
    }

    if (!shortTerm) continue;

    const pendingTasks = findPendingTasks(shortTerm);
    if (pendingTasks.length === 0) continue;

    // Trigger invocation for the first pending task
    const task = pendingTasks[0];
    console.log(`[pending-task] ${team.name} has pending work → channel ${task.channelId} (${task.reason})`);
    triggerInvocation(team, task.channelId, `[자율실행] 미완료 작업 확인: ${task.reason}`);
  }
}

// ---------------------------------------------------------------------------
// Main entry point — start both loops
// ---------------------------------------------------------------------------

export function startInboxCompactor(
  config: TeamsConfig,
  env: EnvConfig,
  triggerInvocation: InvocationTrigger,
): void {
  console.log('[inbox-compactor] Started leader loop + pending task loop (interval: 60s)');

  setInterval(() => {
    // Leader autonomous loop
    leaderLoop(config, triggerInvocation).catch(err => {
      console.error(`[leader-loop] Unhandled error: ${err}`);
    });

    // Team pending task loop
    pendingTaskLoop(config, triggerInvocation).catch(err => {
      console.error(`[pending-task] Unhandled error: ${err}`);
    });
  }, LOOP_INTERVAL_MS);
}
