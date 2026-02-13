import fs from 'node:fs';
import path from 'node:path';
import { runHaiku } from '../utils/haiku.js';
import { atomicWriteSync } from '../utils/fs.js';
import { isBusy } from '../teams/concurrency.js';
import type { TeamsConfig, Episode } from '../types.js';

const CONSOLIDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SIZE_THRESHOLD_BYTES = 3 * 1024; // 3KB
const EPISODE_AGE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours
const MAX_MEMORY_INPUT_BYTES = 5 * 1024; // 5KB per memory section to avoid Haiku token overflow

function truncateMemory(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, 'utf-8') <= maxBytes) return content;
  const lines = content.split('\n');
  let size = 0;
  let cutIdx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    size += Buffer.byteLength(lines[i] + '\n', 'utf-8');
    if (size > maxBytes) { cutIdx = i; break; }
  }
  return lines.slice(0, cutIdx).join('\n') + '\n... (truncated)';
}

function buildConsolidatePrompt(teamName: string, shortTerm: string, longTerm: string): string {
  const safeShort = truncateMemory(shortTerm, MAX_MEMORY_INPUT_BYTES);
  const safeLong = truncateMemory(longTerm, MAX_MEMORY_INPUT_BYTES);
  return `You are consolidating memory for team member "${teamName}".

## Current Long-term Memory
${safeLong || '(empty)'}

## Current Short-term Memory
${safeShort || '(empty)'}

## Task
Review the short-term memory and make these decisions for each piece of information:
1. **Promote to long-term**: User preferences, project structure, recurring patterns, key decisions, team capabilities, important facts that will be needed long-term
2. **Keep in short-term**: Active tasks, current blockers, temporary context needed for upcoming work
3. **Remove**: Truly obsolete info with no future relevance, stale context that no longer matters, duplicates of what's already in long-term

## Important Rules
- 최근 결정/약속은 에피소드 로그가 자동 기록하므로 short-term의 "최근 결정 & 약속" 섹션은 제거하라.
- \`#ch:숫자ID\` 형식의 대기 항목은 반드시 보존하라. 자동 실행 루프가 이 정보를 사용한다.
- 24시간 이상 경과한 캐시된 외부 데이터는 제거하라.

Output EXACTLY this format (include both sections even if empty):

---LONG-TERM---
(full updated long-term memory content - existing + newly promoted items, in Korean bullet list)
---END-LONG-TERM---

---SHORT-TERM---
(cleaned short-term memory - only active/relevant items, in Korean bullet list)
---END-SHORT-TERM---`;
}

function parseConsolidateResult(stdout: string): { longTerm: string; shortTerm: string } | null {
  const longMatch = stdout.match(/---LONG-TERM---\n([\s\S]*?)\n---END-LONG-TERM---/);
  const shortMatch = stdout.match(/---SHORT-TERM---\n([\s\S]*?)\n---END-SHORT-TERM---/);

  if (!longMatch && !shortMatch) {
    console.warn(`[memory-consolidator] Could not parse consolidation output (${stdout.length} chars), skipping`);
    return null;
  }

  return {
    longTerm: longMatch?.[1]?.trim() ?? '',
    shortTerm: shortMatch?.[1]?.trim() ?? '',
  };
}

// Per-team Promise chain for async-safe mutual exclusion
const teamLocks = new Map<string, Promise<void>>();

function withTeamLock(teamId: string, fn: () => Promise<void>): Promise<void> {
  const prev = teamLocks.get(teamId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn after previous completes (even if it rejected)
  teamLocks.set(teamId, next);
  // finally 블록으로 정리 이동 — .then 콜백이 새 호출에 의해 덮어쓰이는 race condition 방지
  next.finally(() => {
    if (teamLocks.get(teamId) === next) teamLocks.delete(teamId);
  });
  return next;
}

async function consolidateTeam(teamId: string, teamName: string, config: TeamsConfig): Promise<void> {
  return withTeamLock(teamId, async () => {
    const ws = config.workspacePath;
    const memoryDir = path.resolve(ws, '.mococo/memory', teamId);
    const shortTermPath = path.resolve(memoryDir, 'short-term.md');
    const longTermPath = path.resolve(memoryDir, 'long-term.md');

    let shortTerm = '';
    let longTerm = '';
    try { shortTerm = fs.readFileSync(shortTermPath, 'utf-8').trim(); } catch {}
    try { longTerm = fs.readFileSync(longTermPath, 'utf-8').trim(); } catch {}

    if (!shortTerm) return;

    const prompt = buildConsolidatePrompt(teamName, shortTerm, longTerm);
    const output = await runHaiku(prompt);
    const result = parseConsolidateResult(output);
    if (!result) return;

    fs.mkdirSync(memoryDir, { recursive: true });

    if (result.longTerm) {
      atomicWriteSync(longTermPath, result.longTerm);
    }
    atomicWriteSync(shortTermPath, result.shortTerm);

    const promoted = result.longTerm && result.longTerm !== longTerm;
    console.log(`[memory-consolidator] Consolidated ${teamName}: short-term ${shortTerm.length}→${result.shortTerm.length} chars${promoted ? ', promoted items to long-term' : ''}`);
  });
}

// ---------------------------------------------------------------------------
// compactEpisodes — 48시간 이상 된 에피소드를 통합 요약
// ---------------------------------------------------------------------------

async function compactEpisodes(teamId: string, teamName: string, config: TeamsConfig): Promise<void> {
  return withTeamLock(teamId, async () => {
  const filePath = path.resolve(config.workspacePath, '.mococo/memory', teamId, 'episodes.jsonl');

  let lines: string[];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    lines = content.split('\n').filter(l => l.trim());
  } catch {
    return;
  }

  const now = Date.now();
  const old: Episode[] = [];
  const recent: string[] = [];
  let malformedCount = 0;

  for (const line of lines) {
    try {
      const ep: Episode = JSON.parse(line);
      if (now - ep.ts > EPISODE_AGE_THRESHOLD_MS) {
        old.push(ep);
      } else {
        recent.push(line);
      }
    } catch {
      malformedCount++;
    }
  }

  // 손상된 라인이 있으면 요약 로그 출력
  if (malformedCount > 0) {
    console.warn(`[memory-consolidator] ${teamName}: ${malformedCount}건의 손상된 에피소드 라인 스킵됨 (전체 ${lines.length}건 중)`);
  }

  if (old.length < 2) return; // not enough old episodes to compact

  const lastOld = old[old.length - 1];

  const oldSummaries = old.map(ep => `- ${ep.summary} (ch:${ep.channelId})`).join('\n');

  const prompt = `Summarize these old activity logs for team "${teamName}" into a single concise summary (max 5 lines, Korean).
Focus on key outcomes and decisions. Drop routine/repetitive entries.

${oldSummaries}

Output ONLY the summary lines (1-5 lines), nothing else.`;

  const compactedSummary = await runHaiku(prompt);

  const compactedEpisode: Episode = {
    ts: lastOld.ts, // use last old episode's timestamp
    teamId,
    channelId: lastOld.channelId,
    trigger: 'system',
    summary: `[통합 요약] ${compactedSummary.slice(0, 200)}`,
    mentions: [],
  };

  const newLines = [JSON.stringify(compactedEpisode), ...recent];
  atomicWriteSync(filePath, newLines.join('\n') + '\n');

  console.log(`[memory-consolidator] Compacted ${old.length} old episodes for ${teamName} → 1 summary`);
  });
}

// ---------------------------------------------------------------------------
// checkSizeBasedConsolidation — short-term 3KB 초과 시 즉시 consolidation
// ---------------------------------------------------------------------------

export function checkSizeBasedConsolidation(teamId: string, teamName: string, config: TeamsConfig): void {
  const shortTermPath = path.resolve(config.workspacePath, '.mococo/memory', teamId, 'short-term.md');

  try {
    const stat = fs.statSync(shortTermPath);
    if (stat.size > SIZE_THRESHOLD_BYTES) {
      console.log(`[memory-consolidator] Size-triggered consolidation for ${teamName} (${stat.size} bytes > ${SIZE_THRESHOLD_BYTES})`);
      consolidateTeam(teamId, teamName, config).catch(err => {
        console.error(`[memory-consolidator] Size-triggered consolidation error for ${teamName}: ${err}`);
      });
    }
  } catch {
    // file doesn't exist — nothing to consolidate
  }
}

// ---------------------------------------------------------------------------
// Periodic check — 6-hour interval
// ---------------------------------------------------------------------------

function checkMemories(config: TeamsConfig): void {
  for (const team of Object.values(config.teams)) {
    if (isBusy(team.id)) continue;

    consolidateTeam(team.id, team.name, config).catch(err => {
      console.error(`[memory-consolidator] Error consolidating ${team.name}: ${err}`);
    });

    compactEpisodes(team.id, team.name, config).catch(err => {
      console.error(`[memory-consolidator] Error compacting episodes for ${team.name}: ${err}`);
    });
  }
}

export function startMemoryConsolidator(config: TeamsConfig): void {
  console.log('[memory-consolidator] Started (interval: 6h)');
  setTimeout(() => {
    checkMemories(config);
    setInterval(() => checkMemories(config), CONSOLIDATE_INTERVAL_MS);
  }, 60_000);
}
