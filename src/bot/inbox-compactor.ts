import fs from 'node:fs';
import path from 'node:path';
import { runHaiku } from '../utils/haiku.js';
import { isBusy, isQueued } from '../teams/concurrency.js';
import { ledger } from '../teams/dispatch-ledger.js';
import { addMessage } from '../teams/context.js';
import { newChain } from './client.js';
import type { TeamsConfig, TeamConfig, EnvConfig, ConversationMessage, ChainContext } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PENDING_TASK_INTERVAL_MS = 60_000;
const DEBOUNCE_MS = 2_000;
const HEARTBEAT_MS = 10 * 60_000;       // 10 minutes
const FOLLOW_UP_MS = 2 * 60_000;         // 2 minutes
const DAILY_DIGEST_MS = 24 * 60 * 60_000; // 24 hours

type InvocationHandler = (
  team: TeamConfig,
  triggerMsg: ConversationMessage,
  channelId: string,
  config: TeamsConfig,
  env: EnvConfig,
  chain: ChainContext,
) => void;

// ---------------------------------------------------------------------------
// Mutex for leader heartbeat (prevent concurrent execution)
// ---------------------------------------------------------------------------

let heartbeatRunning = false;

// ---------------------------------------------------------------------------
// Leader heartbeat — haiku triage → leader self-invoke
// ---------------------------------------------------------------------------

function buildTriagePrompt(
  inbox: string,
  unresolvedCount: number,
  improvementReport: string | null,
): string {
  return `You are a triage assistant. Decide if the leader coordinator needs to be woken up.

## Leader Inbox
${inbox || '(empty)'}

## Unresolved Dispatches
${unresolvedCount > 0 ? `${unresolvedCount} team(s) have not reported back yet.` : '(none)'}

## Improvement Report
${improvementReport || '(none)'}

## Rules
- New human messages → INVOKE
- Team reports/delegation requests → INVOKE
- Unresolved dispatches (5min+) → INVOKE
- High severity improvement issues → INVOKE (include issue details in reason)
- Medium/low only improvement issues → NO (다음 정기 리뷰에서 처리)
- Empty inbox + no unresolved + no high issues → NO

Output ONE line:
INVOKE: (reason summary in Korean, 1 line)
or
NO`;
}

async function leaderHeartbeat(
  config: TeamsConfig,
  env: EnvConfig,
  triggerInvocation: InvocationHandler,
): Promise<void> {
  if (heartbeatRunning) return;
  heartbeatRunning = true;

  try {
    const leaderTeam = Object.values(config.teams).find(t => t.isLeader);
    if (!leaderTeam) return;
    if (isBusy(leaderTeam.id) || isQueued(leaderTeam.id)) return;

    const ws = config.workspacePath;
    const inboxPath = path.resolve(ws, '.mococo/inbox', `${leaderTeam.id}.md`);

    // Gather context
    let inbox = '';
    try { inbox = fs.readFileSync(inboxPath, 'utf-8').trim(); } catch {}

    const unresolved = ledger.getUnresolved(5 * 60_000); // 5min+

    let improvementReport: string | null = null;
    try {
      const raw = fs.readFileSync(path.resolve(ws, '.mococo/inbox/improvement.json'), 'utf-8');
      const data = JSON.parse(raw);
      const issues: { file: string; repo: string; type: string; severity: string; description: string }[] = data.issues ?? [];
      const high = issues.filter(i => i.severity === 'high');
      const medium = issues.filter(i => i.severity === 'medium');
      const low = issues.filter(i => i.severity === 'low');

      if (issues.length > 0) {
        const lines: string[] = [];
        lines.push(`총 ${issues.length}건 (high: ${high.length}, medium: ${medium.length}, low: ${low.length})`);
        if (high.length > 0) {
          lines.push('--- high ---');
          for (const i of high) {
            lines.push(`- [${i.type}] ${i.repo}/${i.file}: ${i.description}`);
          }
        }
        if (medium.length > 0) {
          lines.push('--- medium ---');
          for (const i of medium) {
            lines.push(`- [${i.type}] ${i.repo}/${i.file}: ${i.description}`);
          }
        }
        if (low.length > 0) {
          lines.push(`--- low ${low.length}건 (정기 리뷰 대상) ---`);
        }
        improvementReport = lines.join('\n');
      }
    } catch {}

    // Nothing to evaluate
    if (!inbox && unresolved.length === 0 && !improvementReport) return;

    // Haiku triage
    const triagePrompt = buildTriagePrompt(inbox, unresolved.length, improvementReport);
    const triageResult = await runHaiku(triagePrompt);

    if (triageResult.startsWith('NO')) {
      console.log('[heartbeat] Haiku triage: no leader intervention needed');
      return;
    }

    // Extract reason from "INVOKE: reason"
    const reason = triageResult.replace(/^INVOKE:\s*/, '').trim() || 'inbox 확인 필요';

    console.log(`[heartbeat] Invoking leader: ${reason}`);

    const channelId = env.workChannelId;
    if (!channelId) {
      console.warn('[heartbeat] No workChannelId configured, cannot invoke leader');
      return;
    }

    const systemMsg: ConversationMessage = {
      teamId: 'system',
      teamName: 'System',
      content: `[자율 판단] ${reason}`,
      timestamp: new Date(),
      mentions: [leaderTeam.id],
    };
    addMessage(channelId, systemMsg);
    triggerInvocation(leaderTeam, systemMsg, channelId, config, env, newChain());
    // Inbox is cleared inside handleTeamInvocation after buildTeamPrompt reads it
  } catch (err) {
    console.error(`[heartbeat] Error: ${err}`);
  } finally {
    heartbeatRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Follow-up loop — check dispatch ledger for unreported work
// ---------------------------------------------------------------------------

async function followUpLoop(
  config: TeamsConfig,
  env: EnvConfig,
  triggerInvocation: InvocationHandler,
): Promise<void> {
  const unresolved = ledger.getUnresolved();

  for (const record of unresolved) {
    const team = config.teams[record.toTeam];
    if (!team) continue;

    const elapsedMin = (Date.now() - record.dispatchedAt) / 60_000;

    // Still working → wait
    if (isBusy(team.id)) continue;

    // Just finished → give it a moment
    if (elapsedMin < 5) continue;

    // Already queued → don't pile on
    if (isQueued(team.id)) continue;

    if (elapsedMin < 15) {
      // 5-15 min: nudge the team to report
      console.log(`[follow-up] Nudging ${team.name} to report (${Math.round(elapsedMin)}min since dispatch)`);
      const nudgeMsg: ConversationMessage = {
        teamId: 'system',
        teamName: 'System',
        content: `[보고 요청] 이전 작업 결과를 보고해주세요. 작업 내용: ${record.reason}`,
        timestamp: new Date(),
        mentions: [team.id],
      };
      addMessage(record.channelId, nudgeMsg);
      triggerInvocation(team, nudgeMsg, record.channelId, config, env, newChain());
      break; // One nudge per cycle
    } else {
      // 15min+: notify leader
      const leader = Object.values(config.teams).find(t => t.isLeader);
      if (leader && !isBusy(leader.id) && !isQueued(leader.id)) {
        console.log(`[follow-up] Alerting leader: ${team.name} unreported for ${Math.round(elapsedMin)}min`);
        const alertMsg: ConversationMessage = {
          teamId: 'system',
          teamName: 'System',
          content: `[미보고 알림] ${team.name}가 ${Math.round(elapsedMin)}분째 보고하지 않음. 작업: ${record.reason}`,
          timestamp: new Date(),
          mentions: [leader.id],
        };
        if (env.workChannelId) {
          addMessage(env.workChannelId, alertMsg);
          triggerInvocation(leader, alertMsg, env.workChannelId, config, env, newChain());
        }
      }
      // Expire very old records (60min+)
      if (elapsedMin > 60) {
        record.resolved = true;
        record.resolvedAt = Date.now();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Daily digest — leader summarizes for human
// ---------------------------------------------------------------------------

async function dailyDigest(
  config: TeamsConfig,
  env: EnvConfig,
  triggerInvocation: InvocationHandler,
): Promise<void> {
  const leader = Object.values(config.teams).find(t => t.isLeader);
  if (!leader) return;
  if (!env.workChannelId) return;

  const digestMsg: ConversationMessage = {
    teamId: 'system',
    teamName: 'System',
    content: `[일일 보고] 지난 24시간 활동을 정리해서 회장님께 보고하세요. 완료 작업, 미해소 건, 발견된 이슈를 요약하세요. 반드시 회장님을 태그하세요.`,
    timestamp: new Date(),
    mentions: [leader.id],
  };
  addMessage(env.workChannelId, digestMsg);
  triggerInvocation(leader, digestMsg, env.workChannelId, config, env, newChain());
}

// ---------------------------------------------------------------------------
// Pending task loop — check short-term memory for 대기 항목
// ---------------------------------------------------------------------------

interface PendingTask {
  channelId: string;
  reason: string;
}

function shouldSkipTask(taskLine: string): boolean {
  if (/\[BLOCKED\]/i.test(taskLine)) return true;
  if (/\[SCHEDULED:(\d{4}-\d{2}-\d{2}|tomorrow)\]/i.test(taskLine)) {
    const match = taskLine.match(/\[SCHEDULED:(\d{4}-\d{2}-\d{2}|tomorrow)\]/i);
    if (match) {
      const value = match[1].toLowerCase();
      if (value === 'tomorrow') return true;
      const scheduledDate = new Date(value);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (scheduledDate > today) return true;
    }
  }
  return false;
}

function findPendingTasks(shortTermContent: string): PendingTask[] {
  const tasks: PendingTask[] = [];
  const sectionMatch = shortTermContent.match(/###\s*대기\s*항목\s*\n([\s\S]*?)(?=\n###|\n##|$)/);
  if (!sectionMatch) return tasks;

  const section = sectionMatch[1];
  const lines = section.split('\n');
  for (const line of lines) {
    if (shouldSkipTask(line)) continue;

    const chMatch = line.match(/#ch:(\d+)/);
    if (chMatch) {
      const channelId = chMatch[1];
      const reason = line
        .replace(/#ch:\d+/, '')
        .replace(/\[READY\]/gi, '')
        .replace(/^[\s\-*]+/, '')
        .trim();
      if (reason) {
        tasks.push({ channelId, reason });
      }
    }
  }
  return tasks;
}

async function pendingTaskLoop(
  config: TeamsConfig,
  env: EnvConfig,
  triggerInvocation: InvocationHandler,
): Promise<void> {
  const ws = config.workspacePath;
  let invoked = 0;
  const MAX_INVOCATIONS_PER_CYCLE = 2; // Limit concurrent invocations per cycle

  for (const team of Object.values(config.teams)) {
    if (team.isLeader) continue;
    if (isBusy(team.id) || isQueued(team.id)) continue;
    if (invoked >= MAX_INVOCATIONS_PER_CYCLE) break;

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

    const task = pendingTasks[0];
    console.log(`[pending-task] ${team.name} has pending work → channel ${task.channelId} (${task.reason})`);

    const triggerMsg: ConversationMessage = {
      teamId: 'system',
      teamName: 'System',
      content: `[자율실행] 미완료 작업 확인: ${task.reason}`,
      timestamp: new Date(),
      mentions: [team.id],
    };
    addMessage(task.channelId, triggerMsg);
    triggerInvocation(team, triggerMsg, task.channelId, config, env, newChain());
    invoked++;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function startInboxCompactor(
  config: TeamsConfig,
  env: EnvConfig,
  triggerInvocation: InvocationHandler,
): void {
  console.log('[inbox-compactor] Started: fs.watch(immediate) + heartbeat(10m/fallback) + follow-up(2m) + pending(60s) + digest(24h)');

  const leaderTeam = Object.values(config.teams).find(t => t.isLeader);
  if (!leaderTeam) {
    console.warn('[inbox-compactor] No leader team found');
    return;
  }

  const ws = config.workspacePath;
  const inboxDir = path.resolve(ws, '.mococo/inbox');
  fs.mkdirSync(inboxDir, { recursive: true });

  let debounceTimer: NodeJS.Timeout | null = null;

  const executeHeartbeat = () => {
    leaderHeartbeat(config, env, triggerInvocation).catch(err => {
      console.error(`[heartbeat] Unhandled error: ${err}`);
    });
  };

  // fs.watch for immediate inbox change detection — A안: bypass haiku triage
  const immediateLeaderInvoke = () => {
    if (isBusy(leaderTeam.id) || isQueued(leaderTeam.id)) {
      console.log('[inbox-compactor] Leader busy/queued, skipping immediate invoke');
      return;
    }

    const inboxPath = path.resolve(ws, '.mococo/inbox', `${leaderTeam.id}.md`);
    let inbox = '';
    try { inbox = fs.readFileSync(inboxPath, 'utf-8').trim(); } catch {}
    if (!inbox) return;

    console.log('[inbox-compactor] Inbox changed → immediate leader invoke (no triage)');

    const channelId = env.workChannelId;
    if (!channelId) return;

    const systemMsg: ConversationMessage = {
      teamId: 'system',
      teamName: 'System',
      content: `[자율 판단] inbox 변경 감지 — 즉시 확인`,
      timestamp: new Date(),
      mentions: [leaderTeam.id],
    };
    addMessage(channelId, systemMsg);
    triggerInvocation(leaderTeam, systemMsg, channelId, config, env, newChain());
  };

  try {
    fs.watch(inboxDir, (eventType, filename) => {
      if (filename !== `${leaderTeam.id}.md`) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        immediateLeaderInvoke();
      }, DEBOUNCE_MS);
    });
    console.log(`[inbox-compactor] Watching ${inboxDir} for changes (A안: immediate dispatch)`);
  } catch (err) {
    console.error(`[inbox-compactor] Failed to watch inbox directory: ${err}`);
  }

  // Leader heartbeat: periodic check every 10 minutes
  setInterval(executeHeartbeat, HEARTBEAT_MS);

  // Follow-up loop: check dispatch ledger every 2 minutes
  setInterval(() => {
    followUpLoop(config, env, triggerInvocation).catch(err => {
      console.error(`[follow-up] Unhandled error: ${err}`);
    });
  }, FOLLOW_UP_MS);

  // Pending task loop: every 60 seconds
  setInterval(() => {
    pendingTaskLoop(config, env, triggerInvocation).catch(err => {
      console.error(`[pending-task] Unhandled error: ${err}`);
    });
  }, PENDING_TASK_INTERVAL_MS);

  // Daily digest: every 24 hours (first run after 1 hour)
  setTimeout(() => {
    dailyDigest(config, env, triggerInvocation).catch(err => {
      console.error(`[daily-digest] Unhandled error: ${err}`);
    });
    setInterval(() => {
      dailyDigest(config, env, triggerInvocation).catch(err => {
        console.error(`[daily-digest] Unhandled error: ${err}`);
      });
    }, DAILY_DIGEST_MS);
  }, 60 * 60_000);
}
