import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteSync } from '../utils/fs.js';
import { isBusy, isQueued } from '../teams/concurrency.js';
import { ledger } from '../teams/dispatch-ledger.js';
import { loadRecentEpisodes } from './episode-writer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StressEvent =
  | 'task_complete'
  | 'task_failed'
  | 'queue_added'
  | 'positive_feedback'
  | 'dispatch_resolved'
  | 'review_rework';

export interface StressProfile {
  sensitivity: number; // 0.5~2.0, default 1.0
  modifiers: {
    level1: string;
    level2: string;
    level3: string;
  };
}

export interface StressState {
  teamId: string;
  score: number;      // 0~100
  level: number;      // 0~3
  lastUpdated: number; // Unix ms
  lastLevel3AlertAt: number; // Unix ms — for cooldown
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCORE_MIN = 0;
const SCORE_MAX = 100;
const LEVEL_THRESHOLDS = [25, 50, 75] as const; // 0~25=L0, 26~50=L1, 51~75=L2, 76~100=L3
const DECAY_FACTOR = 0.9; // 10% decay per hour
const LEVEL3_ALERT_COOLDOWN_MS = 10 * 60_000; // 10 minutes

// Event score deltas (before sensitivity multiplier)
const EVENT_DELTAS: Record<StressEvent, number> = {
  task_complete: -15,
  task_failed: +20,
  queue_added: +10,
  positive_feedback: -10,
  dispatch_resolved: -5,
  review_rework: +15,
};

// ---------------------------------------------------------------------------
// State store (in-memory + file persistence)
// ---------------------------------------------------------------------------

const stressStates = new Map<string, StressState>();

function clampScore(score: number): number {
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(score)));
}

function scoreToLevel(score: number): number {
  if (score > LEVEL_THRESHOLDS[2]) return 3;
  if (score > LEVEL_THRESHOLDS[1]) return 2;
  if (score > LEVEL_THRESHOLDS[0]) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function stressDir(ws: string): string {
  return path.resolve(ws, '.mococo/stress');
}

function stressFilePath(ws: string, teamId: string): string {
  return path.resolve(stressDir(ws), `${teamId}.json`);
}

function saveState(ws: string, state: StressState): void {
  const dir = stressDir(ws);
  try {
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteSync(stressFilePath(ws, state.teamId), JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[stress-tracker] Failed to save state for ${state.teamId}: ${err instanceof Error ? err.message : err}`);
  }
}

export function loadState(ws: string, teamId: string): StressState {
  const cached = stressStates.get(teamId);
  if (cached) return cached;

  const filePath = stressFilePath(ws, teamId);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as StressState;
    // Validate essential fields
    if (typeof data.score !== 'number' || typeof data.teamId !== 'string') {
      throw new Error('Invalid stress state format');
    }
    data.level = scoreToLevel(data.score);
    stressStates.set(teamId, data);
    return data;
  } catch {
    // File missing or corrupted — start fresh
    const fresh: StressState = {
      teamId,
      score: 0,
      level: 0,
      lastUpdated: Date.now(),
      lastLevel3AlertAt: 0,
    };
    stressStates.set(teamId, fresh);
    return fresh;
  }
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

export function updateStress(
  ws: string,
  teamId: string,
  event: StressEvent,
  sensitivity = 1.0,
): StressState {
  const state = loadState(ws, teamId);
  const delta = EVENT_DELTAS[event] * sensitivity;
  state.score = clampScore(state.score + delta);
  state.level = scoreToLevel(state.score);
  state.lastUpdated = Date.now();
  stressStates.set(teamId, state);
  saveState(ws, state);
  return state;
}

export function getStressLevel(ws: string, teamId: string): number {
  return loadState(ws, teamId).level;
}

export function getStressScore(ws: string, teamId: string): number {
  return loadState(ws, teamId).score;
}

/**
 * Apply time-based decay: score *= DECAY_FACTOR (10% reduction).
 * Called from heartbeat cycle (~3 min interval).
 */
export function decayAll(ws: string, teamIds: string[]): void {
  for (const teamId of teamIds) {
    const state = loadState(ws, teamId);
    if (state.score === 0) continue;
    state.score = clampScore(state.score * DECAY_FACTOR);
    state.level = scoreToLevel(state.score);
    state.lastUpdated = Date.now();
    stressStates.set(teamId, state);
    saveState(ws, state);
  }
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
  const state = loadState(ws, teamId);
  let contextDelta = 0;

  // Queue depth: +10 per queued item (max +30) — approximated by isQueued
  if (isQueued(teamId)) {
    contextDelta += 10;
  }

  // Busy duration: +15 if busy for 30+ minutes
  if (isBusy(teamId)) {
    contextDelta += 15;
  }

  // Unresolved dispatches: +10 per record (max +30)
  const unresolved = ledger.getUnresolved().filter(r => r.toTeam === teamId);
  contextDelta += Math.min(unresolved.length * 10, 30);

  // Recent activity density: +10 if 5+ episodes in last hour
  const episodes = loadRecentEpisodes(teamId, ws);
  if (episodes) {
    const episodeCount = episodes.split('\n').filter(l => l.trim()).length;
    if (episodeCount >= 5) contextDelta += 10;
  }

  if (contextDelta > 0) {
    state.score = clampScore(state.score + contextDelta * sensitivity);
    state.level = scoreToLevel(state.score);
    state.lastUpdated = Date.now();
    stressStates.set(teamId, state);
    saveState(ws, state);
  }
}

/**
 * Check if Level 3 alert should be sent (respects cooldown).
 */
export function shouldSendLevel3Alert(ws: string, teamId: string): boolean {
  const state = loadState(ws, teamId);
  if (state.level < 3) return false;
  if (Date.now() - state.lastLevel3AlertAt < LEVEL3_ALERT_COOLDOWN_MS) return false;
  return true;
}

export function markLevel3AlertSent(ws: string, teamId: string): void {
  const state = loadState(ws, teamId);
  state.lastLevel3AlertAt = Date.now();
  stressStates.set(teamId, state);
  saveState(ws, state);
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
  const state = loadState(ws, teamId);
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

// ---------------------------------------------------------------------------
// Reset (for testing)
// ---------------------------------------------------------------------------

export function _resetForTesting(): void {
  stressStates.clear();
}
