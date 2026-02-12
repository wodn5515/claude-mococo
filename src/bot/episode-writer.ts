import fs from 'node:fs';
import path from 'node:path';
import { runHaiku } from '../utils/haiku.js';
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
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length > MAX_EPISODE_LINES) {
      const trimmed = lines.slice(-MAX_EPISODE_LINES).join('\n') + '\n';
      fs.writeFileSync(filePath, trimmed);
    }
  } catch {
    // truncation failed — non-critical
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
  const formatted = recent.map(line => {
    try {
      const ep: Episode = JSON.parse(line);
      const ago = formatTimeAgo(Date.now() - ep.ts);
      return `[${ago}] ${ep.summary} (ch:${ep.channelId})`;
    } catch {
      return null;
    }
  }).filter(Boolean);

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
