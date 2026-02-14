import fs from 'node:fs';
import path from 'node:path';
import { runHaiku } from '../utils/haiku.js';
import { isBusy, isQueued } from '../teams/concurrency.js';
import { ledger } from '../teams/dispatch-ledger.js';
import { addMessage } from '../teams/context.js';
import { newChain, sendAsTeam } from './client.js';
import type { TeamsConfig, TeamConfig, EnvConfig, ConversationMessage, ChainContext } from '../types.js';

/** Check if a team is currently busy or queued (not available for new work). */
function isOccupied(teamId: string): boolean {
  return isBusy(teamId) || isQueued(teamId);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PENDING_TASK_INTERVAL_MS = 60_000;
const DEBOUNCE_MS = 2_000;
const HEARTBEAT_MS = 10 * 60_000;       // 10 minutes
const FOLLOW_UP_MS = 2 * 60_000;         // 2 minutes
const DAILY_DIGEST_MS = 24 * 60 * 60_000; // 24 hours
const PENDING_TASK_COOLDOWN_MS = 2 * 60 * 60_000; // 2 hours cooldown per team
const HR_EVAL_MS = 2 * 60 * 60_000; // 2 hours

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

// Cooldown tracker for pending task loop — tracks last invoke time per team
const pendingTaskCooldowns = new Map<string, number>();

// Nudge counter for follow-up loop — tracks how many nudges sent per dispatch record
const nudgeCounts = new Map<string, number>();
const MAX_NUDGES_PER_RECORD = 2;

// Cooldown tracker for follow-up loop — tracks last nudge time per team
const followUpCooldowns = new Map<string, number>();
const FOLLOW_UP_COOLDOWN_MS = 30 * 60_000; // 30 minutes cooldown per team

function isFollowUpOnCooldown(teamId: string): boolean {
  const lastNudge = followUpCooldowns.get(teamId);
  if (!lastNudge) return false;
  return Date.now() - lastNudge < FOLLOW_UP_COOLDOWN_MS;
}

function setFollowUpCooldown(teamId: string): void {
  followUpCooldowns.set(teamId, Date.now());
}

function isPendingTaskOnCooldown(teamId: string): boolean {
  const lastInvoke = pendingTaskCooldowns.get(teamId);
  if (!lastInvoke) return false;
  return Date.now() - lastInvoke < PENDING_TASK_COOLDOWN_MS;
}

function setPendingTaskCooldown(teamId: string): void {
  pendingTaskCooldowns.set(teamId, Date.now());
}

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
    if (isOccupied(leaderTeam.id)) return;

    const ws = config.workspacePath;
    const inboxPath = path.resolve(ws, '.mococo/inbox', `${leaderTeam.id}.md`);

    // Gather context
    let inbox = '';
    try { inbox = fs.readFileSync(inboxPath, 'utf-8').trim(); } catch {}

    const unresolved = ledger.getUnresolved(5 * 60_000); // 5min+

    let improvementReport: string | null = null;
    try {
      const improvementPath = path.resolve(ws, '.mococo/inbox/improvement.json');
      const raw = fs.readFileSync(improvementPath, 'utf-8');
      if (!raw.trim()) throw Object.assign(new Error('Empty file'), { code: 'EMPTY' });
      let data: any;
      try {
        data = JSON.parse(raw);
      } catch (parseErr) {
        console.warn(`[heartbeat] Corrupted improvement.json, recreating: ${parseErr}`);
        const emptyData = JSON.stringify({ issues: [] }, null, 2);
        const tmpPath = improvementPath + '.tmp';
        try {
          fs.writeFileSync(tmpPath, emptyData);
          fs.renameSync(tmpPath, improvementPath);
        } catch { try { fs.unlinkSync(tmpPath); } catch {} }
        data = { issues: [] };
      }
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
    } catch (err: unknown) {
      // ENOENT is expected — improvement.json may not exist yet
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        // silent: file does not exist yet, normal scenario
      } else {
        console.warn(`[heartbeat] Failed to parse improvement.json: ${err}`);
      }
    }

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

    const channelId = env.workChannelId || env.memberTrackingChannelId;
    if (!channelId) {
      console.warn('[heartbeat] No workChannelId or memberTrackingChannelId configured, cannot invoke leader');
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
    await sendAsTeam(channelId, leaderTeam, `📋 ${systemMsg.content}`).catch(err => console.warn('[inbox-compactor] sendAsTeam failed:', err instanceof Error ? err.message : err));
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
    if (record.resolved) continue; // guard against race condition
    const team = config.teams[record.toTeam];
    if (!team) continue;

    const elapsedMin = (Date.now() - record.dispatchedAt) / 60_000;

    // Still working → wait
    if (isBusy(team.id)) continue;

    // Just finished → give it a moment
    if (elapsedMin < 5) continue;

    // Already queued → don't pile on
    if (isQueued(team.id)) continue;

    // Cooldown check — don't nudge same team too frequently
    if (isFollowUpOnCooldown(team.id)) continue;

    // Check nudge count — auto-resolve if exceeded max nudges
    const currentNudges = nudgeCounts.get(record.id) ?? 0;
    if (currentNudges >= MAX_NUDGES_PER_RECORD) {
      console.log(`[follow-up] Max nudges (${MAX_NUDGES_PER_RECORD}) reached for ${team.name}, auto-resolving record`);
      ledger.resolveById(record.id);
      nudgeCounts.delete(record.id);
      continue;
    }

    if (elapsedMin < 15) {
      // triggerInvocation 직전 최종 상태 체크 (race condition 방지)
      if (isOccupied(team.id)) continue;

      // 5-15 min: nudge the team to report
      console.log(`[follow-up] Nudging ${team.name} to report (${Math.round(elapsedMin)}min since dispatch, nudge ${currentNudges + 1}/${MAX_NUDGES_PER_RECORD})`);
      const nudgeMsg: ConversationMessage = {
        teamId: 'system',
        teamName: 'System',
        content: `[보고 요청] 이전 작업 결과를 보고해주세요. 작업 내용: ${record.reason}`,
        timestamp: new Date(),
        mentions: [team.id],
      };
      const nudgeLeader = Object.values(config.teams).find(t => t.isLeader);
      addMessage(record.channelId, nudgeMsg);
      if (nudgeLeader) await sendAsTeam(record.channelId, nudgeLeader, `📋 ${nudgeMsg.content}`).catch(err => console.warn('[inbox-compactor] sendAsTeam failed:', err instanceof Error ? err.message : err));
      triggerInvocation(team, nudgeMsg, record.channelId, config, env, newChain());
      nudgeCounts.set(record.id, currentNudges + 1);
      setFollowUpCooldown(team.id);
      break; // One nudge per cycle
    } else {
      // 15min+: notify leader ONCE, then auto-resolve to prevent infinite loop
      const leader = Object.values(config.teams).find(t => t.isLeader);
      // triggerInvocation 직전 최종 상태 체크 (race condition 방지)
      if (leader && !isOccupied(leader.id)) {
        console.log(`[follow-up] Alerting leader: ${team.name} unreported for ${Math.round(elapsedMin)}min (auto-resolving after alert)`);
        const alertMsg: ConversationMessage = {
          teamId: 'system',
          teamName: 'System',
          content: `[미보고 알림] ${team.name}가 ${Math.round(elapsedMin)}분째 보고하지 않음. 작업: ${record.reason}`,
          timestamp: new Date(),
          mentions: [leader.id],
        };
        const alertChannelId = env.workChannelId || env.memberTrackingChannelId;
        if (alertChannelId) {
          addMessage(alertChannelId, alertMsg);
          await sendAsTeam(alertChannelId, leader, `📋 ${alertMsg.content}`).catch(err => console.warn('[inbox-compactor] sendAsTeam failed:', err instanceof Error ? err.message : err));
          triggerInvocation(leader, alertMsg, alertChannelId, config, env, newChain());
        }
      }
      // Auto-resolve after leader alert to prevent repeated notifications
      ledger.resolveById(record.id);
      nudgeCounts.delete(record.id);
      console.log(`[follow-up] Auto-resolved record for ${team.name} after leader alert (${Math.round(elapsedMin)}min elapsed)`);
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
  if (isOccupied(leader.id)) return;
  const digestChannelId = env.workChannelId || env.memberTrackingChannelId;
  if (!digestChannelId) return;

  const digestMsg: ConversationMessage = {
    teamId: 'system',
    teamName: 'System',
    content: `[일일 보고] 지난 24시간 활동을 정리해서 회장님께 보고하세요. 완료 작업, 미해소 건, 발견된 이슈를 요약하세요. 반드시 회장님을 태그하세요.`,
    timestamp: new Date(),
    mentions: [leader.id],
  };
  addMessage(digestChannelId, digestMsg);
  await sendAsTeam(digestChannelId, leader, `📋 ${digestMsg.content}`).catch(err => console.warn('[inbox-compactor] sendAsTeam failed:', err instanceof Error ? err.message : err));
  // triggerInvocation 직전 최종 상태 체크 (race condition 방지)
  if (isOccupied(leader.id)) return;
  triggerInvocation(leader, digestMsg, digestChannelId, config, env, newChain());
}

// ---------------------------------------------------------------------------
// HR evaluation loop — periodic team member performance evaluation
// ---------------------------------------------------------------------------

async function hrEvaluationLoop(
  config: TeamsConfig,
  env: EnvConfig,
  triggerInvocation: InvocationHandler,
): Promise<void> {
  try {
    const hrTeam = Object.values(config.teams).find(t => t.id === 'hr');
    if (!hrTeam) return;
    if (isOccupied(hrTeam.id)) {
      console.log('[hr-eval] HR team busy/queued, skipping this cycle');
      return;
    }

    const channelId = env.workChannelId || env.memberTrackingChannelId;
    if (!channelId) {
      console.warn('[hr-eval] No workChannelId or memberTrackingChannelId configured');
      return;
    }

    // Read and clear activity log (atomic rename to prevent data loss)
    const logFile = path.resolve(config.workspacePath, '.mococo/hr-logs/activity-log.jsonl');
    const tmpFile = logFile + '.processing';
    let activityLog = '';
    try {
      fs.renameSync(logFile, tmpFile);
      activityLog = fs.readFileSync(tmpFile, 'utf-8').trim();
      try {
        fs.unlinkSync(tmpFile);
      } catch (unlinkErr) {
        console.warn(`[hr-eval] Failed to clean up temp file ${tmpFile}: ${unlinkErr}`);
      }
    } catch {
      // File doesn't exist or empty — no activity
      // Also clean up stale temp file from previous failed run
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }

    if (!activityLog) {
      console.log('[hr-eval] No activity log entries, skipping evaluation');
      return;
    }

    // Parse and format log entries for the prompt
    const entries = activityLog.split('\n').filter(Boolean);
    const formattedLines: string[] = [];
    for (const line of entries) {
      try {
        const e = JSON.parse(line) as { ts: number; channelId: string; author: string; teamId: string; content: string };
        const time = new Date(e.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
        formattedLines.push(`[${time}] ${e.author}: ${e.content}`);
      } catch {
        // Skip malformed lines
      }
    }

    const fromTime = new Date(Date.now() - HR_EVAL_MS).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    const toTime = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

    const MAX_LOG_LINES = 200;
    const trimmedLines = formattedLines.length > MAX_LOG_LINES ? formattedLines.slice(-MAX_LOG_LINES) : formattedLines;
    const logSummary = trimmedLines.join('\n');
    const systemMsg: ConversationMessage = {
      teamId: 'system',
      teamName: 'System',
      content: `[정기 업무평가] 최근 활동 기간(${fromTime}~${toTime}) 로그를 기반으로 각 모코코 팀원의 업무 활동을 평가하고, 회장님(<@401573048353816587>)께 보고하세요.\n\n--- 활동 로그 ---\n${logSummary}\n--- 로그 끝 ---\n\n평가 항목: 작업량, 품질, 협업, 자율성. 로그에 기록이 없는 팀원은 "활동 없음"으로 표시하세요.`,
      timestamp: new Date(),
      mentions: [hrTeam.id],
    };
    addMessage(channelId, systemMsg);
    await sendAsTeam(channelId, hrTeam, `📋 [정기 업무평가] ${fromTime}~${toTime} 활동 로그 기반 평가를 시작합니다.`).catch(err => console.warn('[hr-eval] sendAsTeam failed:', err instanceof Error ? err.message : err));
    triggerInvocation(hrTeam, systemMsg, channelId, config, env, newChain());

    console.log(`[hr-eval] HR evaluation triggered with ${entries.length} log entries for period ${fromTime}~${toTime}`);
  } catch (err) {
    console.error(`[hr-eval] Error: ${err}`);
  }
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
  if (/\[WAITING\]/i.test(taskLine)) return true;
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
  // Natural language detection for waiting/completed states
  if (/(?:대기|지시\s*대기|승인\s*대기|결과\s*대기|판단\s*대기|보고\s*완료|완료\s*보고|리뷰\s*대기|확인\s*대기|답변\s*대기|응답\s*대기)/i.test(taskLine)) return true;
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
    if (isOccupied(team.id)) continue;
    if (invoked >= MAX_INVOCATIONS_PER_CYCLE) break;
    if (isPendingTaskOnCooldown(team.id)) {
      console.log(`[pending-task] ${team.name} on cooldown, skipping`);
      continue;
    }

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
    const pendingLeader = Object.values(config.teams).find(t => t.isLeader);
    addMessage(task.channelId, triggerMsg);
    if (pendingLeader) await sendAsTeam(task.channelId, pendingLeader, `📋 ${triggerMsg.content}`).catch(err => console.warn('[inbox-compactor] sendAsTeam failed:', err instanceof Error ? err.message : err));
    // triggerInvocation 직전 최종 상태 체크 (race condition 방지)
    if (isOccupied(team.id)) continue;
    triggerInvocation(team, triggerMsg, task.channelId, config, env, newChain());
    setPendingTaskCooldown(team.id);
    invoked++;
  }
}

// ---------------------------------------------------------------------------
// Timer management for graceful shutdown
// ---------------------------------------------------------------------------

const activeTimers: ReturnType<typeof setInterval>[] = [];

export function stopInboxCompactor(): void {
  for (const timer of activeTimers) {
    clearInterval(timer);
  }
  activeTimers.length = 0;
  console.log('[inbox-compactor] Stopped all timers');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function startInboxCompactor(
  config: TeamsConfig,
  env: EnvConfig,
  triggerInvocation: InvocationHandler,
): void {
  console.log('[inbox-compactor] Started: fs.watch(immediate) + heartbeat(10m/fallback) + follow-up(2m) + pending(60s) + digest(24h) + hr-eval(2h)');

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
  const immediateLeaderInvoke = async () => {
    if (isOccupied(leaderTeam.id)) {
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
    await sendAsTeam(channelId, leaderTeam, `📋 ${systemMsg.content}`).catch(err => console.warn('[inbox-compactor] sendAsTeam failed:', err instanceof Error ? err.message : err));
    triggerInvocation(leaderTeam, systemMsg, channelId, config, env, newChain());
  };

  try {
    fs.watch(inboxDir, (eventType, filename) => {
      if (filename !== `${leaderTeam.id}.md`) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        immediateLeaderInvoke().catch(err => {
          console.error(`[inbox-compactor] Immediate invoke error: ${err}`);
        });
      }, DEBOUNCE_MS);
    });
    console.log(`[inbox-compactor] Watching ${inboxDir} for changes (A안: immediate dispatch)`);
  } catch (err) {
    console.error(`[inbox-compactor] Failed to watch inbox directory: ${err}`);
  }

  // Leader heartbeat: periodic check every 10 minutes
  activeTimers.push(setInterval(executeHeartbeat, HEARTBEAT_MS));

  // Follow-up loop: check dispatch ledger every 2 minutes
  activeTimers.push(setInterval(() => {
    followUpLoop(config, env, triggerInvocation).catch(err => {
      console.error(`[follow-up] Unhandled error: ${err}`);
    });
  }, FOLLOW_UP_MS));

  // Pending task loop: every 60 seconds
  activeTimers.push(setInterval(() => {
    pendingTaskLoop(config, env, triggerInvocation).catch(err => {
      console.error(`[pending-task] Unhandled error: ${err}`);
    });
  }, PENDING_TASK_INTERVAL_MS));

  // Daily digest: every 24 hours (first run after 1 hour)
  activeTimers.push(setTimeout(() => {
    dailyDigest(config, env, triggerInvocation).catch(err => {
      console.error(`[daily-digest] Unhandled error: ${err}`);
    });
    activeTimers.push(setInterval(() => {
      dailyDigest(config, env, triggerInvocation).catch(err => {
        console.error(`[daily-digest] Unhandled error: ${err}`);
      });
    }, DAILY_DIGEST_MS));
  }, 60 * 60_000));

  // HR evaluation loop: every 2 hours (first run after 10 minutes)
  const hrTeamCheck = Object.values(config.teams).find(t => t.id === 'hr');
  if (hrTeamCheck) {
    activeTimers.push(setTimeout(() => {
      hrEvaluationLoop(config, env, triggerInvocation).catch(err => {
        console.error(`[hr-eval] Unhandled error: ${err}`);
      });
      activeTimers.push(setInterval(() => {
        hrEvaluationLoop(config, env, triggerInvocation).catch(err => {
          console.error(`[hr-eval] Unhandled error: ${err}`);
        });
      }, HR_EVAL_MS));
    }, 10 * 60_000)); // First run after 10 minutes
  }
}
