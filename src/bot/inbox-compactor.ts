import fs from 'node:fs';
import path from 'node:path';
import { runHaiku } from '../utils/haiku.js';
import { atomicWriteSync } from '../utils/fs.js';
import { isBusy, isQueued } from '../teams/concurrency.js';
import { ledger } from '../teams/dispatch-ledger.js';
import { addMessage } from '../teams/context.js';
import { newChain } from './client.js';
import { toHeartbeatTasks } from './heartbeat-tasks.js';
import { decayAll } from './stress-tracker.js';
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
const HEARTBEAT_MS = 3 * 60_000;        // 3 minutes
const FOLLOW_UP_MS = 2 * 60_000;         // 2 minutes
const DAILY_DIGEST_MS = 24 * 60 * 60_000; // 24 hours
const PENDING_TASK_COOLDOWN_MS = 2 * 60 * 60_000; // 2 hours cooldown per team
const PERIODIC_COOLDOWN_MS = 3 * 60_000;            // 3 minutes — match heartbeat.md spec

// ---------------------------------------------------------------------------
// Heartbeat.md — scheduled tasks from file
// ---------------------------------------------------------------------------

export interface HeartbeatTask {
  section: 'daily' | 'weekly' | 'hourly' | 'periodic' | 'on-demand';
  content: string;
  assignee: string | null;
}

interface HeartbeatState {
  lastDaily: string | null;
  lastWeekly: string | null;
  lastPeriodic: string | null;
  lastHourly: string | null;
}

export function parseHeartbeatMd(ws: string): HeartbeatTask[] {
  const heartbeatPath = path.resolve(ws, 'heartbeat.md');
  let content: string;
  try { content = fs.readFileSync(heartbeatPath, 'utf-8'); } catch { return []; }

  const tasks: HeartbeatTask[] = [];
  let currentSection: HeartbeatTask['section'] | null = null;

  for (const line of content.split('\n')) {
    const sectionMatch = line.match(/^##\s+(Daily|Weekly|Hourly|Periodic|On-demand)/i);
    if (sectionMatch) {
      const s = sectionMatch[1].toLowerCase() as HeartbeatTask['section'];
      if (['daily', 'weekly', 'hourly', 'periodic', 'on-demand'].includes(s)) {
        currentSection = s;
      }
      continue;
    }
    if (!currentSection) continue;

    // Active task: - [ ] content @assignee
    const taskMatch = line.match(/^-\s*\[\s\]\s+(.+)/);
    if (taskMatch) {
      const fullContent = taskMatch[1].trim();
      const assigneeMatch = fullContent.match(/@(\S+)/);
      tasks.push({
        section: currentSection,
        content: fullContent.replace(/@\S+\s*/, '').trim(),
        assignee: assigneeMatch ? assigneeMatch[1] : null,
      });
    }
  }
  return tasks;
}

function readHeartbeatState(ws: string): HeartbeatState {
  const statePath = path.resolve(ws, '.mococo/heartbeat-state.json');
  try {
    const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    return {
      lastDaily: data.lastDaily ?? null,
      lastWeekly: data.lastWeekly ?? null,
      lastPeriodic: data.lastPeriodic ?? null,
      lastHourly: data.lastHourly ?? null,
    };
  } catch {
    return { lastDaily: null, lastWeekly: null, lastPeriodic: null, lastHourly: null };
  }
}

function writeHeartbeatState(ws: string, state: HeartbeatState): void {
  const statePath = path.resolve(ws, '.mococo/heartbeat-state.json');
  try {
    atomicWriteSync(statePath, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[heartbeat] Failed to write heartbeat state: ${err instanceof Error ? err.message : err}`);
  }
}

export function getDueHeartbeatTasks(ws: string, config?: TeamsConfig): HeartbeatTask[] {
  // Use TaskRegistry (code-defined tasks) with fallback to heartbeat.md
  const useRegistry = process.env.HEARTBEAT_SOURCE !== 'md';
  const allTasks = useRegistry ? toHeartbeatTasks() : parseHeartbeatMd(ws);
  if (allTasks.length === 0) return [];

  const state = readHeartbeatState(ws);
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon

  const due: HeartbeatTask[] = [];
  let dailyDue = false;
  let weeklyDue = false;
  let periodicDue = false;
  let hourlyDue = false;

  // Check daily: due if not run today
  if (!state.lastDaily || !state.lastDaily.startsWith(todayStr)) {
    dailyDue = true;
  }
  // Check weekly: due if not yet run this week (Mon=1 ~ Sun=0)
  // Calculates the Monday of the current week and checks if lastWeekly is before it
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // days since Monday
  const monday = new Date(now);
  monday.setDate(monday.getDate() - mondayOffset);
  const mondayStr = monday.toISOString().slice(0, 10);
  if (!state.lastWeekly || state.lastWeekly.slice(0, 10) < mondayStr) {
    weeklyDue = true;
  }
  // Check periodic: due if not run within cooldown period (30 min)
  if (!state.lastPeriodic || now.getTime() - new Date(state.lastPeriodic).getTime() >= PERIODIC_COOLDOWN_MS) {
    periodicDue = true;
  }
  // Check hourly: due if not run in the current hour
  // Compare YYYY-MM-DDTHH prefix to detect hour boundary
  const currentHourPrefix = now.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
  if (!state.lastHourly || !state.lastHourly.startsWith(currentHourPrefix)) {
    hourlyDue = true;
  }

  for (const task of allTasks) {
    switch (task.section) {
      case 'periodic':
        if (!periodicDue) break;
        // Skip periodic tasks whose assigned team is currently occupied
        if (task.assignee && config) {
          const team = Object.values(config.teams).find(t => t.name === task.assignee);
          if (team && isOccupied(team.id)) {
            console.log(`[heartbeat] Skipping periodic task: assignee "${task.assignee}" is occupied`);
            break;
          }
        }
        due.push(task);
        break;
      case 'daily': if (dailyDue) due.push(task); break;
      case 'weekly': if (weeklyDue) due.push(task); break;
      case 'hourly': if (hourlyDue) due.push(task); break;
      // on-demand: excluded from automatic heartbeat — requires explicit trigger
    }
  }
  return due;
}

function formatHeartbeatReport(tasks: HeartbeatTask[]): string | null {
  if (tasks.length === 0) return null;
  const lines: string[] = [`${tasks.length}건 실행 예정:`];
  for (const t of tasks) {
    const assignee = t.assignee ? ` (@${t.assignee})` : '';
    lines.push(`- [${t.section}] ${t.content}${assignee}`);
  }
  return lines.join('\n');
}

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
let heartbeatStartedAt = 0;
const HEARTBEAT_STUCK_TIMEOUT_MS = 5 * 60_000; // 5 minutes — auto-reset if stuck

// Cooldown tracker for pending task loop — tracks last invoke time per team
const pendingTaskCooldowns = new Map<string, number>();

// Nudge counter for follow-up loop — tracks how many nudges sent per dispatch record
const nudgeCounts = new Map<string, number>();
const MAX_NUDGES_PER_RECORD = 2;

// Cooldown tracker for follow-up loop — tracks last nudge time per team
const followUpCooldowns = new Map<string, number>();
const FOLLOW_UP_COOLDOWN_MS = 30 * 60_000; // 30 minutes cooldown per team

// Heartbeat dedup — suppress repeated invocations for identical context
const HEARTBEAT_DEDUP_WINDOW_MS = 60 * 60_000; // 1 hour suppression window
let lastHeartbeatFingerprint: string | null = null;
let lastHeartbeatInvokeAt = 0;

/**
 * Determine whether a heartbeat invocation should be suppressed (deduped).
 * Scheduled heartbeat tasks (periodic/daily/weekly/hourly) bypass dedup —
 * they must execute every cycle regardless of fingerprint match.
 */
export function shouldSuppressHeartbeat(
  hasInbox: boolean,
  dueTaskCount: number,
  currentFp: string,
  lastFp: string | null,
  msSinceLastInvoke: number,
): boolean {
  if (hasInbox) return false;
  if (dueTaskCount > 0) return false;
  return currentFp === lastFp && msSinceLastInvoke < HEARTBEAT_DEDUP_WINDOW_MS;
}

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

/**
 * Purge expired entries from cooldown/counter Maps to prevent unbounded growth.
 * Called periodically by a cleanup timer.
 */
export function purgeExpiredCooldowns(): number {
  const now = Date.now();
  let purged = 0;

  for (const [teamId, ts] of pendingTaskCooldowns) {
    if (now - ts >= PENDING_TASK_COOLDOWN_MS) {
      pendingTaskCooldowns.delete(teamId);
      purged++;
    }
  }

  for (const [teamId, ts] of followUpCooldowns) {
    if (now - ts >= FOLLOW_UP_COOLDOWN_MS) {
      followUpCooldowns.delete(teamId);
      purged++;
    }
  }

  if (purged > 0) {
    console.log(`[cooldown-cleanup] Purged ${purged} expired entries (pending=${pendingTaskCooldowns.size}, followUp=${followUpCooldowns.size}, nudge=${nudgeCounts.size})`);
  }
  return purged;
}

/** @internal — test-only access to cooldown state */
export const _cooldownState = {
  get pendingTaskCooldowns() { return pendingTaskCooldowns; },
  get followUpCooldowns() { return followUpCooldowns; },
  get nudgeCounts() { return nudgeCounts; },
};

// ---------------------------------------------------------------------------
// Leader heartbeat — haiku triage → leader self-invoke
// ---------------------------------------------------------------------------

function buildTriagePrompt(
  inbox: string,
  unresolvedCount: number,
  improvementReport: string | null,
  heartbeatReport: string | null,
): string {
  return `You are a triage assistant. Decide if the leader coordinator needs to be woken up.

## Leader Inbox
${inbox || '(empty)'}

## Unresolved Dispatches
${unresolvedCount > 0 ? `${unresolvedCount} team(s) have not reported back yet.` : '(none)'}

## Improvement Report
${improvementReport || '(none)'}

## Heartbeat Tasks (scheduled from heartbeat.md)
${heartbeatReport || '(none)'}

## Rules
- New human messages → INVOKE
- Team reports/delegation requests → INVOKE
- Unresolved dispatches (5min+) → INVOKE
- High severity improvement issues → INVOKE (include issue details in reason)
- Medium/low only improvement issues → NO (다음 정기 리뷰에서 처리)
- Heartbeat tasks (periodic/daily/weekly/hourly) → INVOKE (include task summary in reason)
- Empty inbox + no unresolved + no high issues + no heartbeat tasks → NO

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
  // Safety: auto-reset stuck mutex (e.g., if a previous invocation hangs beyond 5 minutes)
  if (heartbeatRunning && heartbeatStartedAt > 0 && Date.now() - heartbeatStartedAt > HEARTBEAT_STUCK_TIMEOUT_MS) {
    console.warn(`[heartbeat] Force-resetting stuck heartbeatRunning mutex (stuck for ${Math.round((Date.now() - heartbeatStartedAt) / 1000)}s)`);
    heartbeatRunning = false;
  }
  if (heartbeatRunning) return;
  heartbeatRunning = true;
  heartbeatStartedAt = Date.now();

  try {
    const leaderTeam = Object.values(config.teams).find(t => t.isLeader);
    if (!leaderTeam) return;

    // Stress decay — runs every heartbeat cycle regardless of leader availability
    const ws = config.workspacePath;
    decayAll(ws, Object.keys(config.teams));

    if (isOccupied(leaderTeam.id)) return;
    const inboxPath = path.resolve(ws, '.mococo/inbox', `${leaderTeam.id}.md`);

    // Gather context
    let inbox = '';
    try { inbox = fs.readFileSync(inboxPath, 'utf-8').trim(); } catch {}

    const unresolved = ledger.getUnresolved(5 * 60_000); // 5min+
    const highIssueKeys: string[] = []; // for heartbeat dedup fingerprint

    let improvementReport: string | null = null;
    try {
      const improvementPath = path.resolve(ws, '.mococo/inbox/improvement.json');

      // Clean up orphaned tmp file from previous crash (renameSync failure or process crash)
      const tmpPath = improvementPath + '.tmp';
      try {
        const tmpStat = fs.statSync(tmpPath);
        // Remove if older than 1 minute (not from an in-progress write)
        if (Date.now() - tmpStat.mtimeMs > 60_000) {
          fs.unlinkSync(tmpPath);
          console.log('[heartbeat] Cleaned up orphaned improvement.json.tmp');
        }
      } catch {
        // No tmp file — normal scenario
      }

      // Guard: after tmp cleanup, the original file may not exist (atomicWriteSync failure scenario)
      if (!fs.existsSync(improvementPath)) {
        // File absent — treat as empty state, skip improvement report
        throw Object.assign(new Error('File not found after tmp cleanup'), { code: 'ENOENT' });
      }

      const raw = fs.readFileSync(improvementPath, 'utf-8');
      if (!raw.trim()) throw Object.assign(new Error('Empty file'), { code: 'EMPTY' });
      let data: any;
      try {
        data = JSON.parse(raw);
      } catch (parseErr) {
        console.warn(`[heartbeat] Corrupted improvement.json, recreating: ${parseErr}`);
        const emptyData = JSON.stringify({ issues: [] }, null, 2);
        try {
          atomicWriteSync(improvementPath, emptyData);
        } catch (writeErr) {
          console.error(`[heartbeat] atomicWriteSync failed for ${improvementPath}: ${writeErr instanceof Error ? writeErr.message : writeErr}`);
          // atomicWriteSync failure may leave orphaned .tmp — will be cleaned next cycle
          data = { issues: [] };
        }
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
            highIssueKeys.push(`${i.repo}/${i.file}:${i.type}`);
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
      // ENOENT / EMPTY is expected — improvement.json may not exist yet or be empty
      const isExpected = err instanceof Error && (
        (err as NodeJS.ErrnoException).code === 'ENOENT' ||
        (err as NodeJS.ErrnoException).code === 'EMPTY'
      );
      if (!isExpected) {
        console.warn(`[heartbeat] Failed to parse improvement.json: ${err}`);
      }
    }

    // Gather heartbeat.md scheduled tasks (config passed for assignee occupancy check)
    const dueHeartbeatTasks = getDueHeartbeatTasks(ws, config);
    const heartbeatReport = formatHeartbeatReport(dueHeartbeatTasks);

    // Nothing to evaluate
    if (!inbox && unresolved.length === 0 && !improvementReport && !heartbeatReport) return;

    // Dedup check — suppress if same dispatches + issues + heartbeat tasks were already reported recently
    const heartbeatFp = [
      ...unresolved.map(r => r.id).sort(),
      '||',
      ...highIssueKeys.sort(),
      '||',
      ...(dueHeartbeatTasks.map(t => `${t.section}:${t.content}`).sort()),
    ].join('|');

    if (shouldSuppressHeartbeat(!!inbox, dueHeartbeatTasks.length, heartbeatFp, lastHeartbeatFingerprint, Date.now() - lastHeartbeatInvokeAt)) {
      console.log('[heartbeat] Suppressed: identical context already reported within dedup window');
      return;
    }

    // Haiku triage — with fallback for heartbeat tasks
    const triagePrompt = buildTriagePrompt(inbox, unresolved.length, improvementReport, heartbeatReport);
    let reason: string;
    try {
      const triageResult = await runHaiku(triagePrompt);

      if (triageResult.startsWith('NO')) {
        // Fallback: if heartbeat tasks are due, force invoke even if Haiku says NO
        if (dueHeartbeatTasks.length > 0) {
          console.log(`[heartbeat] Haiku said NO but ${dueHeartbeatTasks.length} heartbeat task(s) due — forcing invoke`);
          reason = `정기 작업 ${dueHeartbeatTasks.length}건 실행 예정`;
        } else {
          console.log('[heartbeat] Haiku triage: no leader intervention needed');
          return;
        }
      } else {
        reason = triageResult.replace(/^INVOKE:\s*/, '').trim() || 'inbox 확인 필요';
      }
    } catch (triageErr) {
      // Haiku failure fallback: if heartbeat tasks or inbox exist, invoke anyway
      if (dueHeartbeatTasks.length > 0 || inbox) {
        console.warn(`[heartbeat] Haiku triage failed, falling back to direct invoke: ${triageErr}`);
        reason = dueHeartbeatTasks.length > 0
          ? `정기 작업 ${dueHeartbeatTasks.length}건 실행 예정 (triage 실패 fallback)`
          : 'inbox 확인 필요 (triage 실패 fallback)';
      } else {
        console.warn(`[heartbeat] Haiku triage failed, nothing actionable to invoke for: ${triageErr}`);
        return;
      }
    }

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
    triggerInvocation(leaderTeam, systemMsg, channelId, config, env, newChain());
    // Update heartbeat dedup state
    lastHeartbeatFingerprint = heartbeatFp;
    lastHeartbeatInvokeAt = Date.now();

    // Clear improvement.json after consuming — prevent same issues from re-triggering
    // The leader already received the report in the triage prompt.
    // The improvement-scanner will write fresh issues on its next scan cycle.
    if (improvementReport) {
      try {
        const improvementPath = path.resolve(ws, '.mococo/inbox/improvement.json');
        const raw = fs.readFileSync(improvementPath, 'utf-8');
        const data = JSON.parse(raw);
        data.issues = [];
        atomicWriteSync(improvementPath, JSON.stringify(data, null, 2));
        console.log('[heartbeat] Cleared improvement.json issues after leader invoke');
      } catch {
        // File may not exist or be malformed — ignore
      }
    }

    // Update heartbeat.md state tracking (mark daily/weekly/periodic/hourly as executed)
    if (dueHeartbeatTasks.length > 0) {
      const hasDaily = dueHeartbeatTasks.some(t => t.section === 'daily');
      const hasWeekly = dueHeartbeatTasks.some(t => t.section === 'weekly');
      const hasPeriodic = dueHeartbeatTasks.some(t => t.section === 'periodic');
      const hasHourly = dueHeartbeatTasks.some(t => t.section === 'hourly');
      if (hasDaily || hasWeekly || hasPeriodic || hasHourly) {
        const state = readHeartbeatState(ws);
        const nowIso = new Date().toISOString();
        if (hasDaily) state.lastDaily = nowIso;
        if (hasWeekly) state.lastWeekly = nowIso;
        if (hasPeriodic) state.lastPeriodic = nowIso;
        if (hasHourly) state.lastHourly = nowIso;
        writeHeartbeatState(ws, state);
      }
    }

    // Inbox is cleared inside handleTeamInvocation after buildTeamPrompt reads it
  } catch (err) {
    console.error(`[heartbeat] Error: ${err}`);
  } finally {
    heartbeatRunning = false;
    heartbeatStartedAt = 0;
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

    // Just finished → give it a moment (10 min grace period)
    if (elapsedMin < 10) continue;

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

    if (elapsedMin < 30) {
      // triggerInvocation 직전 최종 상태 체크 (race condition 방지)
      if (isOccupied(team.id)) continue;

      // 10-30 min: nudge the team to report
      console.log(`[follow-up] Nudging ${team.name} to report (${Math.round(elapsedMin)}min since dispatch, nudge ${currentNudges + 1}/${MAX_NUDGES_PER_RECORD})`);
      const nudgeMsg: ConversationMessage = {
        teamId: 'system',
        teamName: 'System',
        content: `[보고 요청] 이전 작업 결과를 보고해주세요. 작업 내용: ${record.reason}`,
        timestamp: new Date(),
        mentions: [team.id],
      };
      addMessage(record.channelId, nudgeMsg);
      // Fresh resolved check — record may have been resolved by another path since getUnresolved()
      if (record.resolved) {
        console.log(`[follow-up] ${team.name} record resolved before nudge invocation, skipping`);
      } else if (isOccupied(team.id)) {
        console.log(`[follow-up] ${team.name} became occupied during nudge, skipping invocation`);
      } else {
        triggerInvocation(team, nudgeMsg, record.channelId, config, env, newChain());
      }
      nudgeCounts.set(record.id, currentNudges + 1);
      setFollowUpCooldown(team.id);
      break; // One nudge per cycle
    } else {
      // 30min+: auto-resolve silently — no leader alert to prevent false alarms
      // The leader will see unresolved dispatches in the next heartbeat triage if needed
      ledger.resolveById(record.id);
      nudgeCounts.delete(record.id);
      console.log(`[follow-up] Auto-resolved record for ${team.name} after ${Math.round(elapsedMin)}min (silent — no leader alert)`);
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
  // triggerInvocation 직전 최종 상태 체크 (race condition 방지)
  if (isOccupied(leader.id)) return;
  triggerInvocation(leader, digestMsg, digestChannelId, config, env, newChain());
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
    addMessage(task.channelId, triggerMsg);
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
let inboxWatcher: fs.FSWatcher | null = null;
let inboxDebounceTimer: NodeJS.Timeout | null = null;

export function stopInboxCompactor(): void {
  if (inboxWatcher) {
    inboxWatcher.close();
    inboxWatcher = null;
  }
  if (inboxDebounceTimer) {
    clearTimeout(inboxDebounceTimer);
    inboxDebounceTimer = null;
  }
  for (const timer of activeTimers) {
    clearInterval(timer);
  }
  activeTimers.length = 0;
  // 상태 초기화 — 재시작 시 이전 fingerprint로 dedup 오작동 방지
  lastHeartbeatFingerprint = null;
  lastHeartbeatInvokeAt = 0;
  heartbeatRunning = false;
  heartbeatStartedAt = 0;
  pendingTaskCooldowns.clear();
  nudgeCounts.clear();
  followUpCooldowns.clear();
  console.log('[inbox-compactor] Stopped all timers and reset state');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function startInboxCompactor(
  config: TeamsConfig,
  env: EnvConfig,
  triggerInvocation: InvocationHandler,
): void {
  // Guard against double-start — clean up existing timers first
  if (activeTimers.length > 0) {
    console.warn('[inbox-compactor] Already running — stopping existing instance before restart');
    stopInboxCompactor();
  }

  console.log('[inbox-compactor] Started: fs.watch(immediate) + queue-drain(15s) + heartbeat(3m/fallback) + follow-up(2m) + pending(60s) + cooldown-cleanup(10m) + digest(24h)');

  const leaderTeam = Object.values(config.teams).find(t => t.isLeader);
  if (!leaderTeam) {
    console.warn('[inbox-compactor] No leader team found');
    return;
  }

  const ws = config.workspacePath;
  const inboxDir = path.resolve(ws, '.mococo/inbox');
  fs.mkdirSync(inboxDir, { recursive: true });

  // 재시작 시 기존 상태로 heartbeat fingerprint를 초기화하여 중복 알림 방지
  try {
    const improvementPath = path.resolve(ws, '.mococo/inbox/improvement.json');
    const raw = fs.readFileSync(improvementPath, 'utf-8');
    const data = JSON.parse(raw) as { issues?: { file: string; repo: string; type: string; severity: string; description: string }[] };
    const highIssueKeys = (data.issues ?? [])
      .filter((i: { severity: string }) => i.severity === 'high')
      .map((i: { repo: string; file: string; type: string }) => `${i.repo}/${i.file}:${i.type}`)
      .sort();
    lastHeartbeatFingerprint = ['||', ...highIssueKeys, '||'].join('|');
    lastHeartbeatInvokeAt = Date.now();
    console.log(`[inbox-compactor] Initialized heartbeat fingerprint from existing state (${highIssueKeys.length} high issues)`);
  } catch {
    // improvement.json 없음 — 정상. fingerprint는 null 유지
  }

  let pendingInboxInvoke = false;

  const executeHeartbeat = () => {
    // Decay stress for all teams on every heartbeat tick
    for (const teamId of Object.keys(config.teams)) {
      try { decayStress(ws, teamId); } catch (err) {
        console.warn(`[heartbeat] decayStress failed for ${teamId}:`, err);
      }
    }

    leaderHeartbeat(config, env, triggerInvocation).catch(err => {
      console.error(`[heartbeat] Unhandled error: ${err}`);
    });
  };

  // fs.watch for immediate inbox change detection — A안: bypass haiku triage
  const immediateLeaderInvoke = async () => {
    if (isOccupied(leaderTeam.id)) {
      console.log('[inbox-compactor] Leader busy/queued, queueing inbox invoke');
      pendingInboxInvoke = true;
      return;
    }

    pendingInboxInvoke = false;
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
    if (isOccupied(leaderTeam.id)) {
      console.log('[inbox-compactor] Leader became busy before invoke, skipping');
      return;
    }
    triggerInvocation(leaderTeam, systemMsg, channelId, config, env, newChain());
  };

  try {
    inboxWatcher = fs.watch(inboxDir, (eventType, filename) => {
      if (filename !== `${leaderTeam.id}.md`) return;
      if (inboxDebounceTimer) clearTimeout(inboxDebounceTimer);
      inboxDebounceTimer = setTimeout(() => {
        immediateLeaderInvoke().catch(err => {
          console.error(`[inbox-compactor] Immediate invoke error: ${err}`);
        });
      }, DEBOUNCE_MS);
    });
    console.log(`[inbox-compactor] Watching ${inboxDir} for changes (A안: immediate dispatch)`);
  } catch (err) {
    console.error(`[inbox-compactor] Failed to watch inbox directory: ${err}`);
  }

  // Leader heartbeat: periodic check every 3 minutes
  activeTimers.push(setInterval(executeHeartbeat, HEARTBEAT_MS));

  // Queue drain: retry pending inbox invoke every 15 seconds when leader was busy
  activeTimers.push(setInterval(() => {
    if (!pendingInboxInvoke) return;
    immediateLeaderInvoke().catch(err => {
      console.error(`[inbox-compactor] Queue drain error: ${err}`);
    });
  }, 15_000));

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

  // Cooldown cleanup: purge expired entries every 10 minutes
  activeTimers.push(setInterval(purgeExpiredCooldowns, 10 * 60_000));

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
}
