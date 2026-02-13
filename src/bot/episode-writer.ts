import fs from 'node:fs';
import path from 'node:path';
import { runHaiku } from '../utils/haiku.js';
import { atomicWriteSync } from '../utils/fs.js';
import type { Episode, ConversationMessage } from '../types.js';

const MAX_EPISODE_LINES = 200;

// ---------------------------------------------------------------------------
// writeEpisode — Haiku로 요약 생성 후 episodes.jsonl에 append
// ---------------------------------------------------------------------------

export async function writeEpisode(
  teamId: string,
  teamName: string,
  channelId: string,
  triggerMsg: ConversationMessage,
  output: string,
  mentions: string[],
  workspacePath: string,
): Promise<void> {
  const triggerSnippet = triggerMsg.content.slice(0, 300);
  const outputSnippet = output.slice(0, 800);

  const prompt = `You are summarizing a bot team member's activity for a brief log.
Team: ${teamName}
Trigger: ${triggerSnippet}
Output: ${outputSnippet}

Write a 1-2 line Korean summary (max 200 characters) of what happened.
Focus on: what was requested, what action was taken, what was the result.
Output ONLY the summary text, nothing else.`;

  const summary = (await runHaiku(prompt)).slice(0, 200);

  const episode: Episode = {
    ts: Date.now(),
    teamId,
    channelId,
    trigger: triggerMsg.teamId === 'human' ? 'human_message'
      : triggerMsg.teamId === 'system' ? 'system'
      : 'team_mention',
    summary,
    mentions,
  };

  const dir = path.resolve(workspacePath, '.mococo/memory', teamId);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.resolve(dir, 'episodes.jsonl');
  fs.appendFileSync(filePath, JSON.stringify(episode) + '\n');

  // Auto-truncate: keep only last MAX_EPISODE_LINES lines
  // Note: writeEpisode is awaited before markFree (client.ts), so no concurrent
  // writers exist for the same team. atomicWriteSync ensures crash-safe writes.
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length > MAX_EPISODE_LINES) {
      const trimmed = lines.slice(-MAX_EPISODE_LINES).join('\n') + '\n';
      atomicWriteSync(filePath, trimmed);
    }
  } catch (err) {
    // 파싱/잘라내기 실패 시 상세 로그 — 파일 경로와 에러 메시지 포함
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[episode] Truncation failed for ${teamId} (${filePath}): ${errMsg}`);
  }
}

// ---------------------------------------------------------------------------
// loadRecentEpisodes — 최근 N개 에피소드를 포맷 문자열로 반환
// ---------------------------------------------------------------------------

export function loadRecentEpisodes(
  teamId: string,
  workspacePath: string,
  count: number = 10,
): string {
  const filePath = path.resolve(workspacePath, '.mococo/memory', teamId, 'episodes.jsonl');

  let lines: string[];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    lines = content.split('\n').filter(l => l.trim());
  } catch {
    return '';
  }

  const recent = lines.slice(-count);
  let parseFailures = 0;
  let firstCorruptedSample = '';
  const formatted = recent.map(line => {
    try {
      const ep: Episode = JSON.parse(line);
      if (typeof ep.ts !== 'number' || isNaN(ep.ts)) {
        parseFailures++;
        if (!firstCorruptedSample) firstCorruptedSample = line.slice(0, 100);
        return null;
      }
      const ago = formatTimeAgo(Date.now() - ep.ts);
      return `[${ago}] ${ep.summary} (ch:${ep.channelId})`;
    } catch {
      parseFailures++;
      if (!firstCorruptedSample) firstCorruptedSample = line.slice(0, 100);
      return null;
    }
  }).filter(Boolean);
  if (parseFailures > 0) {
    console.warn(`[episode] ${teamId}: ${parseFailures}건의 손상된 라인 스킵됨 (전체 ${recent.length}건 중, 파일: ${filePath}) — 첫 번째 손상: ${firstCorruptedSample}`);
    // Self-healing: 전체 파일에서 손상 비율이 30% 이상이면 유효한 라인만 재작성
    const totalCorrupted = lines.filter(l => { try { const e = JSON.parse(l); return typeof e.ts !== 'number' || isNaN(e.ts); } catch { return true; } }).length;
    if (totalCorrupted > 0 && totalCorrupted / lines.length >= 0.3) {
      const validLines = lines.filter(l => { try { const e = JSON.parse(l); return typeof e.ts === 'number' && !isNaN(e.ts); } catch { return false; } });
      atomicWriteSync(filePath, validLines.join('\n') + '\n');
      console.log(`[episode] ${teamId}: Self-healing — ${totalCorrupted}건 손상 라인 제거, ${validLines.length}건 유지`);
    }
  }

  return formatted.join('\n');
}

// ---------------------------------------------------------------------------
// formatTimeAgo — 상대 시간 변환
// ---------------------------------------------------------------------------

export function formatTimeAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;

  const days = Math.floor(hours / 24);
  return `${days}일 전`;
}
