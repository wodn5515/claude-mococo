import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock concurrency module before importing the module under test
vi.mock('../../teams/concurrency.js', () => ({
  isBusy: vi.fn(() => false),
  isQueued: vi.fn(() => false),
}));

vi.mock('../../utils/haiku.js', () => ({ runHaiku: vi.fn() }));
vi.mock('../../utils/fs.js', () => ({ atomicWriteSync: vi.fn() }));
vi.mock('../../teams/dispatch-ledger.js', () => ({
  ledger: { getUnresolved: vi.fn(() => []), resolveById: vi.fn() },
}));
vi.mock('../../teams/context.js', () => ({ addMessage: vi.fn() }));
vi.mock('../client.js', () => ({ newChain: vi.fn() }));
vi.mock('../heartbeat-tasks.js', () => ({ toHeartbeatTasks: vi.fn(() => []) }));
vi.mock('../stress-tracker.js', () => ({ decayAll: vi.fn() }));

import { purgeExpiredCooldowns, _cooldownState } from '../inbox-compactor.js';

describe('purgeExpiredCooldowns', () => {
  beforeEach(() => {
    _cooldownState.pendingTaskCooldowns.clear();
    _cooldownState.followUpCooldowns.clear();
    _cooldownState.nudgeCounts.clear();
  });

  it('should not purge entries that are still within cooldown window', () => {
    _cooldownState.pendingTaskCooldowns.set('team-a', Date.now());
    _cooldownState.followUpCooldowns.set('team-b', Date.now());

    const purged = purgeExpiredCooldowns();

    expect(purged).toBe(0);
    expect(_cooldownState.pendingTaskCooldowns.size).toBe(1);
    expect(_cooldownState.followUpCooldowns.size).toBe(1);
  });

  it('should purge expired pendingTaskCooldowns entries (2h+)', () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60_000 - 1;
    _cooldownState.pendingTaskCooldowns.set('team-expired', twoHoursAgo);
    _cooldownState.pendingTaskCooldowns.set('team-fresh', Date.now());

    const purged = purgeExpiredCooldowns();

    expect(purged).toBe(1);
    expect(_cooldownState.pendingTaskCooldowns.has('team-expired')).toBe(false);
    expect(_cooldownState.pendingTaskCooldowns.has('team-fresh')).toBe(true);
  });

  it('should purge expired followUpCooldowns entries (30m+)', () => {
    const thirtyMinAgo = Date.now() - 30 * 60_000 - 1;
    _cooldownState.followUpCooldowns.set('team-expired', thirtyMinAgo);
    _cooldownState.followUpCooldowns.set('team-fresh', Date.now());

    const purged = purgeExpiredCooldowns();

    expect(purged).toBe(1);
    expect(_cooldownState.followUpCooldowns.has('team-expired')).toBe(false);
    expect(_cooldownState.followUpCooldowns.has('team-fresh')).toBe(true);
  });

  it('should purge from both Maps in a single call', () => {
    const old = Date.now() - 3 * 60 * 60_000; // 3 hours ago
    _cooldownState.pendingTaskCooldowns.set('a', old);
    _cooldownState.pendingTaskCooldowns.set('b', old);
    _cooldownState.followUpCooldowns.set('c', old);

    const purged = purgeExpiredCooldowns();

    expect(purged).toBe(3);
    expect(_cooldownState.pendingTaskCooldowns.size).toBe(0);
    expect(_cooldownState.followUpCooldowns.size).toBe(0);
  });

  it('should return 0 when Maps are empty', () => {
    const purged = purgeExpiredCooldowns();
    expect(purged).toBe(0);
  });
});
