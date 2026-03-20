import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteSync } from '../utils/fs.js';
import { isBusy, isQueued } from '../teams/concurrency.js';
import { ledger } from '../teams/dispatch-ledger.js';
import { loadRecentEpisodes } from './episode-writer.js';
import type { StressProfile } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StressEvent =
  | 'queue_added'
  | 'task_complete'
  | 'task_failed'
  | 'task_timeout'
  | 'positive_feedback'
  | 'dispatch_resolved'
  | 'review_rejected'
  | 'review_rework';

export interface StressState {
  teamId: string;
  score: number;        // 0–100
  level: 0 | 1 | 2 | 3;
  lastUpdated: number;  // Unix ms
  lastDecayAt: number;  // Unix ms — for time-based continuous decay
  lastAlertAt: number;  // Unix ms — Level 3 alert spam prevention
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 시간당 감쇠율: score * 0.9^(elapsedHours). 경과 시간 기반 연속 계산 */
const DECAY_FACTOR = 0.9;

/** Level 3 알림 중복 방지 쿨다운 (30분) */
const ALERT_COOLDOWN_MS = 30 * 60_000;

/** 스트레스 이벤트별 기본 점수 변화량 (sensitivity 적용 전) */
const BASE_DELTAS: Record<StressEvent, number> = {
  queue_added:       +10,
  task_failed:       +20,
  task_timeout:      +20,
  review_rejected:   +15,
  review_rework:     +15,
  task_complete:     -15,
  dispatch_resolved: -5,
  positive_feedback: -10,
};

// ---------------------------------------------------------------------------
// Level calculation
// ---------------------------------------------------------------------------

export function calcLevel(score: number): 0 | 1 | 2 | 3 {
  if (score <= 25) return 0;
  if (score <= 50) return 1;
  if (score <= 75) return 2;
  return 3;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

const stateCache = new Map<string, StressState>();

function getStatePath(ws: string, teamId: string): string {
  return path.resolve(ws, '.mococo/stress', `${teamId}.json`);
}

export function loadStressState(ws: string, teamId: string): StressState {
  const cached = stateCache.get(teamId);
  if (cached) return cached;

  const filePath = getStatePath(ws, teamId);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as StressState;
    stateCache.set(teamId, parsed);
    return parsed;
  } catch {
    const initial: StressState = {
      teamId,
      score: 0,
      level: 0,
      lastUpdated: Date.now(),
      lastDecayAt: Date.now(),
      lastAlertAt: 0,
    };
    stateCache.set(teamId, initial);
    return initial;
  }
}

/** Backward-compatible alias for loadStressState */
export const loadState = loadStressState;

function saveStressState(ws: string, state: StressState): void {
  const dir = path.resolve(ws, '.mococo/stress');
  try {
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteSync(getStatePath(ws, state.teamId), JSON.stringify(state, null, 2));
    stateCache.set(state.teamId, state);
  } catch (err) {
    // Graceful degradation: keep in-memory state if disk write fails
    stateCache.set(state.teamId, state);
    console.warn(`[stress-tracker] Failed to persist state for ${state.teamId}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Positive feedback detection
// ---------------------------------------------------------------------------

/**
 * 긍정 피드백 키워드 감지.
 * 부정어(안/못/아님/아니) 뒤에 이어지는 키워드는 오탐 방지를 위해 제외.
 */
export function detectPositiveFeedback(content: string): boolean {
  const POSITIVE_RE = /(좋아|잘했어|수고|PASS|훌륭|완벽|고마워|감사|잘됐다)/gi;
  const NEGATION_RE = /(?:안|못|아님|아니)\s*$/;

  const matches = [...content.matchAll(POSITIVE_RE)];
  if (matches.length === 0) return false;

  for (const match of matches) {
    const before = content.slice(0, match.index).slice(-10);
    if (!NEGATION_RE.test(before)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 시간 기반 자연 감쇠 적용.
 * 공식: score * 0.9^(경과시간_시간 단위)
 * heartbeat 주기(3분)마다 호출하되 실제 경과 시간으로 정확히 계산.
 */
export function decayStress(ws: string, teamId: string): void {
  const state = loadStressState(ws, teamId);
  if (state.score === 0) return;

  const now = Date.now();
  const elapsedHours = (now - state.lastDecayAt) / 3_600_000;
  if (elapsedHours < 0.01) return; // 36초 미만 — float noise 방지

  const decayed = state.score * Math.pow(DECAY_FACTOR, elapsedHours);
  const newScore = Math.max(0, Math.round(decayed));

  const updated: StressState = {
    ...state,
    score: newScore,
    level: calcLevel(newScore),
    lastUpdated: now,
    lastDecayAt: now,
  };
  saveStressState(ws, updated);
}

/** Batch decay for all teams (calls decayStress per team). */
export function decayAll(ws: string, teamIds: string[]): void {
  for (const teamId of teamIds) {
    decayStress(ws, teamId);
  }
}

/**
 * 이벤트 기반 스트레스 점수 변경.
 * @returns Level 3 알림을 보내야 하는 경우 true (30분 쿨다운 체크 포함)
 */
export function updateStress(
  ws: string,
  teamId: string,
  event: StressEvent,
  profileOrSensitivity?: StressProfile | number,
): boolean {
  const state = loadStressState(ws, teamId);
  const sensitivity = typeof profileOrSensitivity === 'number'
    ? profileOrSensitivity
    : (profileOrSensitivity?.sensitivity ?? 1.0);
  const baseDelta = BASE_DELTAS[event] ?? 0;
  const delta = Math.round(baseDelta * sensitivity);

  const newScore = Math.max(0, Math.min(100, state.score + delta));
  const newLevel = calcLevel(newScore);

  const now = Date.now();
  let shouldAlert = false;
  let newLastAlertAt = state.lastAlertAt;

  if (newLevel === 3 && now - state.lastAlertAt >= ALERT_COOLDOWN_MS) {
    shouldAlert = true;
    newLastAlertAt = now;
  }

  const updated: StressState = {
    ...state,
    score: newScore,
    level: newLevel,
    lastUpdated: now,
    lastAlertAt: newLastAlertAt,
  };
  saveStressState(ws, updated);

  return shouldAlert;
}

/** 현재 스트레스 레벨(0–3) 반환. */
export function getStressLevel(ws: string, teamId: string): 0 | 1 | 2 | 3 {
  return loadStressState(ws, teamId).level;
}

/** 현재 스트레스 점수 반환. */
export function getStressScore(ws: string, teamId: string): number {
  return loadStressState(ws, teamId).score;
}

/** 현재 스트레스 상태 전체 반환. */
export function getStressState(ws: string, teamId: string): StressState {
  return loadStressState(ws, teamId);
}

/**
 * Check if Level 3 alert should be sent (respects cooldown).
 */
export function shouldSendLevel3Alert(ws: string, teamId: string): boolean {
  const state = loadStressState(ws, teamId);
  if (state.level < 3) return false;
  if (Date.now() - state.lastAlertAt < ALERT_COOLDOWN_MS) return false;
  return true;
}

export function markLevel3AlertSent(ws: string, teamId: string): void {
  const state = loadStressState(ws, teamId);
  const updated: StressState = {
    ...state,
    lastAlertAt: Date.now(),
  };
  saveStressState(ws, updated);
}

/**
 * Calculate contextual stress from current system state.
 * Called before building prompt to capture queue depth, busy time, etc.
 */
export function evaluateContextualStress(
  ws: string,
  teamId: string,
  sensitivity = 1.0,
): void {
  const state = loadStressState(ws, teamId);
  let contextDelta = 0;

  if (isQueued(teamId)) {
    contextDelta += 10;
  }

  if (isBusy(teamId)) {
    contextDelta += 15;
  }

  const unresolved = ledger.getUnresolved().filter(r => r.toTeam === teamId);
  contextDelta += Math.min(unresolved.length * 10, 30);

  const episodes = loadRecentEpisodes(teamId, ws);
  if (episodes) {
    const episodeCount = episodes.split('\n').filter(l => l.trim()).length;
    if (episodeCount >= 5) contextDelta += 10;
  }

  if (contextDelta > 0) {
    const newScore = Math.max(0, Math.min(100, state.score + Math.round(contextDelta * sensitivity)));
    const updated: StressState = {
      ...state,
      score: newScore,
      level: calcLevel(newScore),
      lastUpdated: Date.now(),
    };
    saveStressState(ws, updated);
  }
}

/**
 * Build the prompt modifier text for the current stress level.
 * Returns empty string for Level 0 (no modification).
 */
export function getStressModifier(
  ws: string,
  teamId: string,
  profile: StressProfile | undefined,
): string {
  if (!profile) return '';
  const state = loadStressState(ws, teamId);
  if (state.level === 0) return '';

  const levelKey = `level${state.level}` as keyof StressProfile['modifiers'];
  const modifier = profile.modifiers[levelKey];
  if (!modifier) return '';

  const levelNames = ['', '바쁨', '압박', '과부하'];
  return `## Current Mood
**스트레스 레벨: ${state.level}/3 (${levelNames[state.level]}) — 점수: ${state.score}/100**
${modifier}
이 상태에 맞게 말투와 태도를 자연스럽게 조정하세요.`;
}

/** 스트레스 리셋 (장시간 유휴 또는 수동 명령 시). */
export function resetStress(ws: string, teamId: string): void {
  const now = Date.now();
  const state: StressState = {
    teamId,
    score: 0,
    level: 0,
    lastUpdated: now,
    lastDecayAt: now,
    lastAlertAt: 0,
  };
  saveStressState(ws, state);
}

/** 전체 팀 스트레스 상태 요약 (디버깅/모니터링용). */
export function getStressReport(ws: string, teamIds: string[]): Record<string, { score: number; level: number }> {
  const report: Record<string, { score: number; level: number }> = {};
  for (const teamId of teamIds) {
    const state = loadStressState(ws, teamId);
    report[teamId] = { score: state.score, level: state.level };
  }
  return report;
}

// ---------------------------------------------------------------------------
// Reset (for testing)
// ---------------------------------------------------------------------------

export function _resetForTesting(): void {
  stateCache.clear();
}
