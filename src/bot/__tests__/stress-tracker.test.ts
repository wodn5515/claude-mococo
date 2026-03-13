import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  atomicWriteSync: vi.fn((filePath: string, content: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }),
}));

import {
  calcLevel,
  detectPositiveFeedback,
  updateStress,
  decayStress,
  decayAll,
  getStressLevel,
  getStressScore,
  getStressState,
  resetStress,
  loadStressState,
  loadState,
  shouldSendLevel3Alert,
  markLevel3AlertSent,
  getStressModifier,
  _resetForTesting,
} from '../stress-tracker.js';
import type { StressProfile } from '../../types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-test-'));
  _resetForTesting();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// calcLevel — 경계값 분석
// ---------------------------------------------------------------------------

describe('calcLevel', () => {
  it.each([
    [0, 0], [25, 0],
    [26, 1], [50, 1],
    [51, 2], [75, 2],
    [76, 3], [100, 3],
  ])('score %d → level %d', (score, expected) => {
    expect(calcLevel(score)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// detectPositiveFeedback — 오탐 방지 포함
// ---------------------------------------------------------------------------

describe('detectPositiveFeedback', () => {
  it('긍정 키워드 감지', () => {
    expect(detectPositiveFeedback('잘했어!')).toBe(true);
    expect(detectPositiveFeedback('PASS 처리합니다')).toBe(true);
    expect(detectPositiveFeedback('수고했어')).toBe(true);
    expect(detectPositiveFeedback('훌륭해')).toBe(true);
  });

  it('부정 문맥은 오탐 제외', () => {
    expect(detectPositiveFeedback('안 잘했어')).toBe(false);
    expect(detectPositiveFeedback('못 PASS했어')).toBe(false);
    expect(detectPositiveFeedback('아니 수고는 무슨')).toBe(false);
  });

  it('긍정 없으면 false', () => {
    expect(detectPositiveFeedback('코드 리뷰 부탁해')).toBe(false);
    expect(detectPositiveFeedback('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateStress — 점수 변화 및 level 계산
// ---------------------------------------------------------------------------

describe('updateStress', () => {
  it('task_complete: 점수 감소', () => {
    updateStress(tmpDir, 'test', 'queue_added');   // +10 → 10
    updateStress(tmpDir, 'test', 'task_complete'); // -15 → 0 (min 0)
    expect(getStressState(tmpDir, 'test').score).toBe(0);
  });

  it('score는 0 이하로 내려가지 않음', () => {
    updateStress(tmpDir, 'test', 'task_complete');
    expect(getStressState(tmpDir, 'test').score).toBe(0);
  });

  it('score는 100 이상으로 올라가지 않음', () => {
    for (let i = 0; i < 10; i++) updateStress(tmpDir, 'test', 'task_failed'); // +200
    expect(getStressState(tmpDir, 'test').score).toBe(100);
  });

  it('sensitivity 1.5 적용 시 delta 증가 (StressProfile)', () => {
    const profile = { sensitivity: 1.5, modifiers: { level1: '', level2: '', level3: '' } };
    updateStress(tmpDir, 'sens', 'queue_added', profile); // +10 * 1.5 = +15
    expect(getStressState(tmpDir, 'sens').score).toBe(15);
  });

  it('sensitivity 0.5 적용 시 delta 감소 (StressProfile)', () => {
    const profile = { sensitivity: 0.5, modifiers: { level1: '', level2: '', level3: '' } };
    updateStress(tmpDir, 'sens2', 'queue_added', profile); // +10 * 0.5 = +5
    expect(getStressState(tmpDir, 'sens2').score).toBe(5);
  });

  it('sensitivity as number (backward compat)', () => {
    updateStress(tmpDir, 'num-sens', 'task_failed', 2.0); // +20 * 2.0 = +40
    expect(getStressScore(tmpDir, 'num-sens')).toBe(40);

    updateStress(tmpDir, 'num-sens', 'task_complete', 2.0); // +(-15) * 2.0 = -30
    expect(getStressScore(tmpDir, 'num-sens')).toBe(10);
  });

  it('level이 올바르게 계산됨', () => {
    for (let i = 0; i < 3; i++) updateStress(tmpDir, 'lv', 'task_failed'); // +60
    const state = getStressState(tmpDir, 'lv');
    expect(state.score).toBe(60);
    expect(state.level).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Level 3 알림 — 스팸 방지 (30분 쿨다운)
// ---------------------------------------------------------------------------

describe('updateStress Level 3 alert', () => {
  it('처음 Level 3 진입 시 shouldAlert = true', () => {
    for (let i = 0; i < 3; i++) updateStress(tmpDir, 'alert2', 'task_failed'); // +60 → Level 2
    const first = updateStress(tmpDir, 'alert2', 'task_failed'); // +80 → Level 3
    expect(first).toBe(true);
  });

  it('30분 내 재진입 시 shouldAlert = false', () => {
    for (let i = 0; i < 3; i++) updateStress(tmpDir, 'cd', 'task_failed');
    const first = updateStress(tmpDir, 'cd', 'task_failed'); // Level 3 진입
    expect(first).toBe(true);

    vi.advanceTimersByTime(29 * 60_000);
    const second = updateStress(tmpDir, 'cd', 'task_complete');
    expect(second).toBe(false);
  });

  it('30분 후 재진입 시 shouldAlert = true', () => {
    for (let i = 0; i < 3; i++) updateStress(tmpDir, 'cd2', 'task_failed');
    updateStress(tmpDir, 'cd2', 'task_failed'); // Level 3 진입

    vi.advanceTimersByTime(31 * 60_000);
    const retry = updateStress(tmpDir, 'cd2', 'task_failed');
    expect(retry).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldSendLevel3Alert / markLevel3AlertSent (backward compat)
// ---------------------------------------------------------------------------

describe('shouldSendLevel3Alert / markLevel3AlertSent', () => {
  it('Level 3 alert respects cooldown', () => {
    for (let i = 0; i < 4; i++) updateStress(tmpDir, 'alert-test', 'task_failed'); // +80
    // updateStress already set lastAlertAt when entering Level 3
    // so shouldSendLevel3Alert will be false immediately after
    expect(shouldSendLevel3Alert(tmpDir, 'alert-test')).toBe(false);

    vi.advanceTimersByTime(31 * 60_000);
    expect(shouldSendLevel3Alert(tmpDir, 'alert-test')).toBe(true);

    markLevel3AlertSent(tmpDir, 'alert-test');
    expect(shouldSendLevel3Alert(tmpDir, 'alert-test')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decayStress — 시간 기반 감쇠
// ---------------------------------------------------------------------------

describe('decayStress', () => {
  it('1시간 후 score * 0.9 감쇠', () => {
    for (let i = 0; i < 5; i++) updateStress(tmpDir, 'decay', 'task_failed'); // +100

    vi.advanceTimersByTime(60 * 60_000); // 1시간
    decayStress(tmpDir, 'decay');
    const state = getStressState(tmpDir, 'decay');
    expect(state.score).toBe(90); // 100 * 0.9^1
  });

  it('score 0이면 decay 스킵', () => {
    decayStress(tmpDir, 'zero');
    expect(getStressState(tmpDir, 'zero').score).toBe(0);
  });

  it('36초 미만 경과 시 decay 스킵 (float noise 방지)', () => {
    for (let i = 0; i < 4; i++) updateStress(tmpDir, 'short', 'task_failed'); // +80

    vi.advanceTimersByTime(30_000); // 30초
    decayStress(tmpDir, 'short');
    expect(getStressState(tmpDir, 'short').score).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// decayAll — batch decay (backward compat)
// ---------------------------------------------------------------------------

describe('decayAll', () => {
  it('applies decay to all teams', () => {
    for (let i = 0; i < 5; i++) updateStress(tmpDir, 'team-a', 'task_failed'); // 100
    for (let i = 0; i < 3; i++) updateStress(tmpDir, 'team-b', 'task_failed'); // 60

    vi.advanceTimersByTime(60 * 60_000);
    decayAll(tmpDir, ['team-a', 'team-b']);
    expect(getStressScore(tmpDir, 'team-a')).toBe(90);
    expect(getStressScore(tmpDir, 'team-b')).toBe(54); // 60 * 0.9
  });

  it('decay on zero score remains zero', () => {
    vi.advanceTimersByTime(60 * 60_000);
    decayAll(tmpDir, ['zero-test']);
    expect(getStressScore(tmpDir, 'zero-test')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// State persistence — 파일 저장/복원
// ---------------------------------------------------------------------------

describe('state persistence', () => {
  it('상태가 파일에 저장되고 캐시 없이 복원됨', () => {
    updateStress(tmpDir, 'persist', 'task_failed'); // +20
    updateStress(tmpDir, 'persist', 'task_failed'); // +40

    const filePath = path.resolve(tmpDir, '.mococo/stress/persist.json');
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(raw.score).toBe(40);
    expect(raw.level).toBe(1);
  });

  it('state restores after cache reset', () => {
    updateStress(tmpDir, 'persist-test', 'task_failed'); // 20
    updateStress(tmpDir, 'persist-test', 'task_failed'); // 40

    _resetForTesting();

    const state = loadState(tmpDir, 'persist-test');
    expect(state.score).toBe(40);
    expect(state.teamId).toBe('persist-test');
  });
});

// ---------------------------------------------------------------------------
// resetStress
// ---------------------------------------------------------------------------

describe('resetStress', () => {
  it('score와 level을 0으로 초기화', () => {
    for (let i = 0; i < 5; i++) updateStress(tmpDir, 'reset', 'task_failed');
    expect(getStressState(tmpDir, 'reset').score).toBeGreaterThan(0);

    resetStress(tmpDir, 'reset');
    const state = getStressState(tmpDir, 'reset');
    expect(state.score).toBe(0);
    expect(state.level).toBe(0);
    expect(state.lastAlertAt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getStressLevel / getStressScore
// ---------------------------------------------------------------------------

describe('getStressLevel', () => {
  it('초기 상태는 level 0', () => {
    expect(getStressLevel(tmpDir, 'new-team')).toBe(0);
  });

  it('점수에 따라 올바른 레벨 반환', () => {
    for (let i = 0; i < 4; i++) updateStress(tmpDir, 'glv', 'task_failed'); // +80
    expect(getStressLevel(tmpDir, 'glv')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// getStressModifier — prompt modifier text
// ---------------------------------------------------------------------------

describe('getStressModifier', () => {
  const profile: StressProfile = {
    sensitivity: 1.0,
    modifiers: { level1: 'busy mode', level2: 'stressed mode', level3: 'overloaded mode' },
  };

  it('Level 0 returns empty modifier', () => {
    const result = getStressModifier(tmpDir, 'mod-test', profile);
    expect(result).toBe('');
  });

  it('Level 2 returns correct modifier text', () => {
    updateStress(tmpDir, 'mod-test-2', 'task_failed'); // 20
    updateStress(tmpDir, 'mod-test-2', 'task_failed'); // 40
    updateStress(tmpDir, 'mod-test-2', 'review_rework'); // 55

    const result = getStressModifier(tmpDir, 'mod-test-2', profile);
    expect(result).toContain('## Current Mood');
    expect(result).toContain('stressed mode');
    expect(result).toContain('레벨: 2/3');
  });

  it('returns empty when no profile', () => {
    updateStress(tmpDir, 'no-profile', 'task_failed');
    updateStress(tmpDir, 'no-profile', 'task_failed');
    updateStress(tmpDir, 'no-profile', 'task_failed');
    updateStress(tmpDir, 'no-profile', 'task_failed');
    expect(getStressModifier(tmpDir, 'no-profile', undefined)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// loadState alias
// ---------------------------------------------------------------------------

describe('loadState (backward compat)', () => {
  it('loadState is alias for loadStressState', () => {
    updateStress(tmpDir, 'alias-test', 'task_failed');
    const a = loadState(tmpDir, 'alias-test');
    const b = loadStressState(tmpDir, 'alias-test');
    expect(a).toBe(b);
  });
});
