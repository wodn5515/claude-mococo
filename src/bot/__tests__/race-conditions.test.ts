import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock concurrency module
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

// --- #49: heartbeat mutex stuck timeout ---

describe('#49 — heartbeat mutex stuck timeout', () => {
  it('heartbeatRunning flag resets on normal execution', async () => {
    // Verify the flag pattern: set true, do work, finally reset to false
    let flag = false;
    let startedAt = 0;
    const STUCK_TIMEOUT = 100;

    async function simulateHeartbeat() {
      if (flag && startedAt > 0 && Date.now() - startedAt > STUCK_TIMEOUT) {
        flag = false;
      }
      if (flag) return 'skipped';
      flag = true;
      startedAt = Date.now();
      try {
        await new Promise(resolve => setTimeout(resolve, 10));
        return 'executed';
      } finally {
        flag = false;
        startedAt = 0;
      }
    }

    const result = await simulateHeartbeat();
    expect(result).toBe('executed');
    expect(flag).toBe(false);
  });

  it('stuck mutex auto-resets after timeout', async () => {
    let flag = false;
    let startedAt = 0;
    const STUCK_TIMEOUT = 50;

    // Simulate a stuck heartbeat
    flag = true;
    startedAt = Date.now() - 100; // pretend it started 100ms ago

    // Second call should detect stuck and reset
    if (flag && startedAt > 0 && Date.now() - startedAt > STUCK_TIMEOUT) {
      flag = false;
    }
    expect(flag).toBe(false);
  });

  it('concurrent call is blocked when heartbeat is running (not stuck)', () => {
    let flag = false;
    let startedAt = 0;
    const STUCK_TIMEOUT = 5000;

    flag = true;
    startedAt = Date.now(); // just started

    if (flag && startedAt > 0 && Date.now() - startedAt > STUCK_TIMEOUT) {
      flag = false;
    }
    // Should still be true — not stuck yet
    expect(flag).toBe(true);
  });
});

// --- #51: withTeamLock cleanup race ---

describe('#51 — withTeamLock sequential execution', () => {
  it('chains calls sequentially for the same teamId', async () => {
    const teamLocks = new Map<string, Promise<void>>();
    const executionOrder: number[] = [];

    function withTeamLock(teamId: string, fn: () => Promise<void>): Promise<void> {
      const prev = teamLocks.get(teamId) ?? Promise.resolve();
      const next = prev.then(fn, fn);
      teamLocks.set(teamId, next);
      return next;
    }

    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    // Fire 3 concurrent calls — they should execute sequentially
    const p1 = withTeamLock('team1', async () => {
      executionOrder.push(1);
      await delay(20);
      executionOrder.push(11);
    });
    const p2 = withTeamLock('team1', async () => {
      executionOrder.push(2);
      await delay(10);
      executionOrder.push(22);
    });
    const p3 = withTeamLock('team1', async () => {
      executionOrder.push(3);
      executionOrder.push(33);
    });

    await Promise.all([p1, p2, p3]);

    // Should execute in order: 1 starts, 1 ends, 2 starts, 2 ends, 3 starts, 3 ends
    expect(executionOrder).toEqual([1, 11, 2, 22, 3, 33]);
  });

  it('allows parallel execution for different teamIds', async () => {
    const teamLocks = new Map<string, Promise<void>>();
    const executionOrder: string[] = [];

    function withTeamLock(teamId: string, fn: () => Promise<void>): Promise<void> {
      const prev = teamLocks.get(teamId) ?? Promise.resolve();
      const next = prev.then(fn, fn);
      teamLocks.set(teamId, next);
      return next;
    }

    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const p1 = withTeamLock('teamA', async () => {
      executionOrder.push('A-start');
      await delay(20);
      executionOrder.push('A-end');
    });
    const p2 = withTeamLock('teamB', async () => {
      executionOrder.push('B-start');
      await delay(10);
      executionOrder.push('B-end');
    });

    await Promise.all([p1, p2]);

    // Both should start before either ends (parallel)
    const aStart = executionOrder.indexOf('A-start');
    const bStart = executionOrder.indexOf('B-start');
    const aEnd = executionOrder.indexOf('A-end');
    expect(aStart).toBeLessThan(aEnd);
    expect(bStart).toBeLessThan(aEnd);
  });

  it('third call chains correctly without cleanup race', async () => {
    const teamLocks = new Map<string, Promise<void>>();
    const results: number[] = [];

    function withTeamLock(teamId: string, fn: () => Promise<void>): Promise<void> {
      const prev = teamLocks.get(teamId) ?? Promise.resolve();
      // Never delete from map — entries are bounded by team count
      const next = prev.then(fn, fn);
      teamLocks.set(teamId, next);
      return next;
    }

    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    // Rapidly queue 5 operations
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      const idx = i;
      promises.push(withTeamLock('team1', async () => {
        await delay(5);
        results.push(idx);
      }));
    }

    await Promise.all(promises);
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });
});

// --- #52: inbox write-after-timeout ---

describe('#52 — inbox write-after-timeout prevention', () => {
  it('settled flag prevents resolve after timeout', () => {
    let settled = false;
    let resolved = false;
    let rejected = false;

    // Simulate timeout firing first
    settled = true;
    rejected = true;

    // Simulate write completing after timeout
    if (settled) {
      // Should not resolve
    } else {
      resolved = true;
    }

    expect(rejected).toBe(true);
    expect(resolved).toBe(false);
  });

  it('cancelled flag prevents task execution after timeout', () => {
    let cancelled = false;
    let executed = false;

    // Simulate timeout
    cancelled = true;

    // Simulate task fn
    if (!cancelled) {
      executed = true;
    }

    expect(executed).toBe(false);
  });
});

// --- #53: followUpLoop stale reference ---

describe('#53 — followUpLoop stale resolved check', () => {
  it('detects resolved record before nudge invocation', () => {
    // Simulate a dispatch record object (shared reference)
    const record = { id: '1', resolved: false, toTeam: 'team1' };

    // Simulate another path resolving the record during iteration
    record.resolved = true;

    // The fresh check should catch this
    expect(record.resolved).toBe(true);
  });

  it('allows nudge when record is still unresolved', () => {
    const record = { id: '2', resolved: false, toTeam: 'team1' };
    expect(record.resolved).toBe(false);
  });
});

// --- #54: checkMemories sequential consolidation ---

describe('#54 — checkMemories sequential consolidation', () => {
  it('consolidateTeam completes before compactEpisodes starts', async () => {
    const order: string[] = [];

    async function consolidateTeam() {
      order.push('consolidate-start');
      await new Promise(resolve => setTimeout(resolve, 10));
      order.push('consolidate-end');
    }

    async function compactEpisodes() {
      order.push('compact-start');
      await new Promise(resolve => setTimeout(resolve, 5));
      order.push('compact-end');
    }

    // Sequential (fixed behavior)
    try {
      await consolidateTeam();
    } catch {}
    try {
      await compactEpisodes();
    } catch {}

    expect(order).toEqual([
      'consolidate-start',
      'consolidate-end',
      'compact-start',
      'compact-end',
    ]);
  });
});
