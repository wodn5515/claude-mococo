import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock modules that stress-tracker imports
vi.mock('../../teams/concurrency.js', () => ({
  isBusy: vi.fn(() => false),
  isQueued: vi.fn(() => false),
}));

vi.mock('../../teams/dispatch-ledger.js', () => ({
  ledger: { getUnresolved: vi.fn(() => []) },
}));

vi.mock('../episode-writer.js', () => ({
  loadRecentEpisodes: vi.fn(() => ''),
}));

vi.mock('../../utils/fs.js', () => ({
  atomicWriteSync: (filePath: string, content: string) => {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content);
  },
}));

import {
  updateStress,
  getStressLevel,
  getStressScore,
  decayAll,
  loadState,
  getStressModifier,
  shouldSendLevel3Alert,
  markLevel3AlertSent,
  _resetForTesting,
} from '../stress-tracker.js';
import type { StressProfile } from '../../types.js';

describe('stress-tracker', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-test-'));
    _resetForTesting();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // TC-01: Initial score=0, task_failed → score=20
  it('TC-01: task_failed event increases score by 20', () => {
    const state = updateStress(tmpDir, 'team-a', 'task_failed');
    expect(state.score).toBe(20);
  });

  // TC-02: score=100, task_complete → score=85 (clamped)
  it('TC-02: task_complete from max score decreases to 85', () => {
    // Build up to 100
    updateStress(tmpDir, 'team-b', 'task_failed'); // 20
    updateStress(tmpDir, 'team-b', 'task_failed'); // 40
    updateStress(tmpDir, 'team-b', 'task_failed'); // 60
    updateStress(tmpDir, 'team-b', 'task_failed'); // 80
    updateStress(tmpDir, 'team-b', 'task_failed'); // 100
    expect(getStressScore(tmpDir, 'team-b')).toBe(100);

    const state = updateStress(tmpDir, 'team-b', 'task_complete');
    expect(state.score).toBe(85);
  });

  // TC-03: queue_added with sensitivity=1.0 → +10 each, max cap at 100
  it('TC-03: queue_added events accumulate with cap', () => {
    updateStress(tmpDir, 'team-c', 'queue_added'); // 10
    updateStress(tmpDir, 'team-c', 'queue_added'); // 20
    updateStress(tmpDir, 'team-c', 'queue_added'); // 30
    expect(getStressScore(tmpDir, 'team-c')).toBe(30);
  });

  // TC-04: getStressLevel returns correct levels for boundary values
  it('TC-04: getStressLevel returns correct levels', () => {
    expect(getStressLevel(tmpDir, 'level-test')).toBe(0); // score=0

    updateStress(tmpDir, 'level-test', 'queue_added'); // 10
    updateStress(tmpDir, 'level-test', 'queue_added'); // 20
    expect(getStressLevel(tmpDir, 'level-test')).toBe(0); // 20 ≤ 25

    updateStress(tmpDir, 'level-test', 'queue_added'); // 30
    expect(getStressLevel(tmpDir, 'level-test')).toBe(1); // 30 > 25

    updateStress(tmpDir, 'level-test', 'task_failed'); // 50
    expect(getStressLevel(tmpDir, 'level-test')).toBe(1); // 50 ≤ 50... exactly 50

    updateStress(tmpDir, 'level-test', 'queue_added'); // 60
    expect(getStressLevel(tmpDir, 'level-test')).toBe(2); // 60 > 50

    updateStress(tmpDir, 'level-test', 'review_rework'); // 75
    expect(getStressLevel(tmpDir, 'level-test')).toBe(2); // 75 = threshold

    updateStress(tmpDir, 'level-test', 'queue_added'); // 85
    expect(getStressLevel(tmpDir, 'level-test')).toBe(3); // 85 > 75
  });

  // TC-05: decay applies score * 0.9
  it('TC-05: decayAll applies 0.9 factor', () => {
    updateStress(tmpDir, 'decay-test', 'task_failed'); // 20
    updateStress(tmpDir, 'decay-test', 'task_failed'); // 40
    updateStress(tmpDir, 'decay-test', 'task_failed'); // 60
    updateStress(tmpDir, 'decay-test', 'task_failed'); // 80
    updateStress(tmpDir, 'decay-test', 'task_failed'); // 100
    expect(getStressScore(tmpDir, 'decay-test')).toBe(100);

    decayAll(tmpDir, ['decay-test']);
    expect(getStressScore(tmpDir, 'decay-test')).toBe(90); // 100 * 0.9

    decayAll(tmpDir, ['decay-test']);
    expect(getStressScore(tmpDir, 'decay-test')).toBe(81); // 90 * 0.9 = 81
  });

  // TC-06: persistence — write and read back
  it('TC-06: state persists to file and restores', () => {
    updateStress(tmpDir, 'persist-test', 'task_failed'); // 20
    updateStress(tmpDir, 'persist-test', 'task_failed'); // 40

    // Reset in-memory cache
    _resetForTesting();

    // Reload from file
    const state = loadState(tmpDir, 'persist-test');
    expect(state.score).toBe(40);
    expect(state.teamId).toBe('persist-test');
  });

  // TC-09: sensitivity=2.0 doubles the delta
  it('TC-09: sensitivity multiplier applied correctly', () => {
    const state = updateStress(tmpDir, 'sens-test', 'task_failed', 2.0);
    expect(state.score).toBe(40); // 20 * 2.0

    const state2 = updateStress(tmpDir, 'sens-test', 'task_complete', 2.0);
    expect(state2.score).toBe(10); // 40 + (-15 * 2.0) = 10
  });

  // Stress modifier text
  it('TC-07: Level 0 returns empty modifier', () => {
    const profile: StressProfile = {
      sensitivity: 1.0,
      modifiers: { level1: 'busy', level2: 'stressed', level3: 'overloaded' },
    };
    const result = getStressModifier(tmpDir, 'mod-test', profile);
    expect(result).toBe('');
  });

  it('TC-08: Level 2 returns correct modifier text', () => {
    const profile: StressProfile = {
      sensitivity: 1.0,
      modifiers: { level1: 'busy mode', level2: 'stressed mode', level3: 'overloaded mode' },
    };
    // Push to level 2 (score > 50)
    updateStress(tmpDir, 'mod-test-2', 'task_failed'); // 20
    updateStress(tmpDir, 'mod-test-2', 'task_failed'); // 40
    updateStress(tmpDir, 'mod-test-2', 'review_rework'); // 55

    const result = getStressModifier(tmpDir, 'mod-test-2', profile);
    expect(result).toContain('## Current Mood');
    expect(result).toContain('stressed mode');
    expect(result).toContain('레벨: 2/3');
  });

  // Level 3 alert cooldown
  it('TC-10: Level 3 alert respects cooldown', () => {
    // Push to level 3
    updateStress(tmpDir, 'alert-test', 'task_failed'); // 20
    updateStress(tmpDir, 'alert-test', 'task_failed'); // 40
    updateStress(tmpDir, 'alert-test', 'task_failed'); // 60
    updateStress(tmpDir, 'alert-test', 'task_failed'); // 80

    expect(shouldSendLevel3Alert(tmpDir, 'alert-test')).toBe(true);

    markLevel3AlertSent(tmpDir, 'alert-test');
    expect(shouldSendLevel3Alert(tmpDir, 'alert-test')).toBe(false);
  });

  // Score never goes below 0
  it('score never goes below 0', () => {
    updateStress(tmpDir, 'floor-test', 'positive_feedback'); // -10 → 0
    expect(getStressScore(tmpDir, 'floor-test')).toBe(0);

    updateStress(tmpDir, 'floor-test', 'task_complete'); // -15 → 0
    expect(getStressScore(tmpDir, 'floor-test')).toBe(0);
  });

  // No profile returns empty modifier
  it('getStressModifier returns empty when no profile', () => {
    updateStress(tmpDir, 'no-profile', 'task_failed');
    updateStress(tmpDir, 'no-profile', 'task_failed');
    updateStress(tmpDir, 'no-profile', 'task_failed');
    updateStress(tmpDir, 'no-profile', 'task_failed');
    expect(getStressModifier(tmpDir, 'no-profile', undefined)).toBe('');
  });

  // Decay on zero score is no-op
  it('decay on zero score remains zero', () => {
    decayAll(tmpDir, ['zero-test']);
    expect(getStressScore(tmpDir, 'zero-test')).toBe(0);
  });
});
