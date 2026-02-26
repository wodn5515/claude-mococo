import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { TeamsConfig, TeamConfig } from '../../types.js';

// Mock concurrency module before importing the module under test
vi.mock('../../teams/concurrency.js', () => ({
  isBusy: vi.fn(() => false),
  isQueued: vi.fn(() => false),
}));

// Mock modules that inbox-compactor imports but we don't need
vi.mock('../../utils/haiku.js', () => ({ runHaiku: vi.fn() }));
vi.mock('../../utils/fs.js', () => ({ atomicWriteSync: vi.fn() }));
vi.mock('../../teams/dispatch-ledger.js', () => ({
  ledger: { getUnresolved: vi.fn(() => []), resolveById: vi.fn() },
}));
vi.mock('../../teams/context.js', () => ({ addMessage: vi.fn() }));
vi.mock('../client.js', () => ({ newChain: vi.fn() }));

import { parseHeartbeatMd, getDueHeartbeatTasks } from '../inbox-compactor.js';
import { isBusy, isQueued } from '../../teams/concurrency.js';

function makeTeamConfig(overrides: Partial<TeamConfig> & { id: string; name: string }): TeamConfig {
  return {
    color: 0,
    avatar: '',
    engine: 'claude',
    model: 'sonnet',
    maxBudget: 10,
    prompt: '',
    git: { name: 'test', email: 'test@test.com' },
    discordToken: '',
    permissions: {},
    ...overrides,
  };
}

function makeConfig(teams: Record<string, TeamConfig>): TeamsConfig {
  return {
    teams,
    globalDeny: [],
    conversationWindow: 30,
    workspacePath: '',
  };
}

describe('parseHeartbeatMd', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses periodic tasks with assignees', () => {
    fs.writeFileSync(path.join(tmpDir, 'heartbeat.md'), `
## Periodic
- [ ] Kil-biseo 개선점 조사 @스택코코
- [ ] SetMate-APP 개선점 조사 @브러쉬코코
`);

    const tasks = parseHeartbeatMd(tmpDir);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toEqual({
      section: 'periodic',
      content: 'Kil-biseo 개선점 조사',
      assignee: '스택코코',
    });
    expect(tasks[1]).toEqual({
      section: 'periodic',
      content: 'SetMate-APP 개선점 조사',
      assignee: '브러쉬코코',
    });
  });

  it('ignores completed tasks', () => {
    fs.writeFileSync(path.join(tmpDir, 'heartbeat.md'), `
## Periodic
- [x] 완료된 작업 @스택코코
- [ ] 활성 작업 @브러쉬코코
`);

    const tasks = parseHeartbeatMd(tmpDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assignee).toBe('브러쉬코코');
  });

  it('handles tasks without assignee', () => {
    fs.writeFileSync(path.join(tmpDir, 'heartbeat.md'), `
## Periodic
- [ ] 담당자 없는 작업
`);

    const tasks = parseHeartbeatMd(tmpDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assignee).toBeNull();
  });

  it('parses hourly tasks', () => {
    fs.writeFileSync(path.join(tmpDir, 'heartbeat.md'), `
## Hourly
- [ ] 코드 분석 @체커코코
- [ ] 이슈 관리 @대장코코
`);

    const tasks = parseHeartbeatMd(tmpDir);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toEqual({
      section: 'hourly',
      content: '코드 분석',
      assignee: '체커코코',
    });
    expect(tasks[1]).toEqual({
      section: 'hourly',
      content: '이슈 관리',
      assignee: '대장코코',
    });
  });

  it('parses all section types together', () => {
    fs.writeFileSync(path.join(tmpDir, 'heartbeat.md'), `
## Daily
- [ ] 일일 작업

## Weekly
- [ ] 주간 작업

## Hourly
- [ ] 시간별 작업

## Periodic
- [ ] 상시 작업
`);

    const tasks = parseHeartbeatMd(tmpDir);
    expect(tasks).toHaveLength(4);
    expect(tasks.map(t => t.section)).toEqual(['daily', 'weekly', 'hourly', 'periodic']);
  });

  it('returns empty when file does not exist', () => {
    const tasks = parseHeartbeatMd(path.join(tmpDir, 'nonexistent'));
    expect(tasks).toEqual([]);
  });
});

describe('getDueHeartbeatTasks — periodic occupied filter', () => {
  let tmpDir: string;
  const stackTeam = makeTeamConfig({ id: 'stack', name: '스택코코' });
  const brushTeam = makeTeamConfig({ id: 'brush', name: '브러쉬코코' });
  const config = makeConfig({ stack: stackTeam, brush: brushTeam });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-test-'));
    vi.mocked(isBusy).mockReturnValue(false);
    vi.mocked(isQueued).mockReturnValue(false);

    // Write heartbeat state to avoid daily/weekly/hourly tasks triggering
    const mocoDir = path.join(tmpDir, '.mococo');
    fs.mkdirSync(mocoDir, { recursive: true });
    fs.writeFileSync(
      path.join(mocoDir, 'heartbeat-state.json'),
      JSON.stringify({ lastDaily: new Date().toISOString(), lastWeekly: new Date().toISOString(), lastHourly: new Date().toISOString() }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('includes periodic tasks when assignees are free', () => {
    fs.writeFileSync(path.join(tmpDir, 'heartbeat.md'), `
## Periodic
- [ ] Kil-biseo 개선점 조사 @스택코코
- [ ] SetMate-APP 개선점 조사 @브러쉬코코
`);

    const tasks = getDueHeartbeatTasks(tmpDir, config);
    expect(tasks).toHaveLength(2);
  });

  it('filters out periodic task when assignee is busy', () => {
    fs.writeFileSync(path.join(tmpDir, 'heartbeat.md'), `
## Periodic
- [ ] Kil-biseo 개선점 조사 @스택코코
- [ ] SetMate-APP 개선점 조사 @브러쉬코코
`);

    vi.mocked(isBusy).mockImplementation((id: string) => id === 'stack');

    const tasks = getDueHeartbeatTasks(tmpDir, config);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assignee).toBe('브러쉬코코');
  });

  it('filters out periodic task when assignee is queued', () => {
    fs.writeFileSync(path.join(tmpDir, 'heartbeat.md'), `
## Periodic
- [ ] Kil-biseo 개선점 조사 @스택코코
- [ ] SetMate-APP 개선점 조사 @브러쉬코코
`);

    vi.mocked(isQueued).mockImplementation((id: string) => id === 'brush');

    const tasks = getDueHeartbeatTasks(tmpDir, config);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assignee).toBe('스택코코');
  });

  it('filters all periodic tasks when all assignees are occupied', () => {
    fs.writeFileSync(path.join(tmpDir, 'heartbeat.md'), `
## Periodic
- [ ] Kil-biseo 개선점 조사 @스택코코
- [ ] SetMate-APP 개선점 조사 @브러쉬코코
`);

    vi.mocked(isBusy).mockReturnValue(true);

    const tasks = getDueHeartbeatTasks(tmpDir, config);
    expect(tasks).toHaveLength(0);
  });

  it('includes periodic tasks without assignee regardless of occupancy', () => {
    fs.writeFileSync(path.join(tmpDir, 'heartbeat.md'), `
## Periodic
- [ ] 담당자 없는 모니터링 작업
`);

    vi.mocked(isBusy).mockReturnValue(true);

    const tasks = getDueHeartbeatTasks(tmpDir, config);
    expect(tasks).toHaveLength(1);
  });

  it('includes all periodic tasks when config is not provided (backward compat)', () => {
    fs.writeFileSync(path.join(tmpDir, 'heartbeat.md'), `
## Periodic
- [ ] Kil-biseo 개선점 조사 @스택코코
- [ ] SetMate-APP 개선점 조사 @브러쉬코코
`);

    vi.mocked(isBusy).mockReturnValue(true);

    // No config passed — should not filter
    const tasks = getDueHeartbeatTasks(tmpDir);
    expect(tasks).toHaveLength(2);
  });
});

describe('getDueHeartbeatTasks — periodic cooldown', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-periodic-cd-'));
    vi.mocked(isBusy).mockReturnValue(false);
    vi.mocked(isQueued).mockReturnValue(false);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeState(dir: string, state: { lastDaily?: string; lastWeekly?: string; lastPeriodic?: string | null; lastHourly?: string | null }) {
    const mocoDir = path.join(dir, '.mococo');
    fs.mkdirSync(mocoDir, { recursive: true });
    fs.writeFileSync(
      path.join(mocoDir, 'heartbeat-state.json'),
      JSON.stringify({
        lastDaily: state.lastDaily ?? new Date().toISOString(),
        lastWeekly: state.lastWeekly ?? new Date().toISOString(),
        lastPeriodic: state.lastPeriodic ?? null,
        lastHourly: state.lastHourly ?? null,
      }),
    );
  }

  function writePeriodicHeartbeat(dir: string) {
    fs.writeFileSync(path.join(dir, 'heartbeat.md'), `
## Periodic
- [ ] 서버 상태 확인
- [ ] 코드 품질 모니터링
`);
  }

  it('includes periodic tasks when lastPeriodic is null (never run)', () => {
    writePeriodicHeartbeat(tmpDir);
    writeState(tmpDir, { lastPeriodic: null });

    const tasks = getDueHeartbeatTasks(tmpDir);
    const periodicTasks = tasks.filter(t => t.section === 'periodic');
    expect(periodicTasks).toHaveLength(2);
  });

  it('excludes periodic tasks when within cooldown period (30min)', () => {
    writePeriodicHeartbeat(tmpDir);
    // Set lastPeriodic to 5 minutes ago — within 30min cooldown
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    writeState(tmpDir, { lastPeriodic: fiveMinAgo });

    const tasks = getDueHeartbeatTasks(tmpDir);
    const periodicTasks = tasks.filter(t => t.section === 'periodic');
    expect(periodicTasks).toHaveLength(0);
  });

  it('includes periodic tasks when cooldown expired', () => {
    writePeriodicHeartbeat(tmpDir);
    // Set lastPeriodic to 31 minutes ago — cooldown expired
    const thirtyOneMinAgo = new Date(Date.now() - 31 * 60_000).toISOString();
    writeState(tmpDir, { lastPeriodic: thirtyOneMinAgo });

    const tasks = getDueHeartbeatTasks(tmpDir);
    const periodicTasks = tasks.filter(t => t.section === 'periodic');
    expect(periodicTasks).toHaveLength(2);
  });

  it('does not affect daily/weekly tasks when periodic is on cooldown', () => {
    fs.writeFileSync(path.join(tmpDir, 'heartbeat.md'), `
## Daily
- [ ] 일일 점검

## Periodic
- [ ] 상시 모니터링
`);
    // Periodic on cooldown, daily not run today
    writeState(tmpDir, {
      lastDaily: '2020-01-01T00:00:00Z',
      lastPeriodic: new Date().toISOString(),
    });

    const tasks = getDueHeartbeatTasks(tmpDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].section).toBe('daily');
  });

  it('handles state file without lastPeriodic field (backward compat)', () => {
    writePeriodicHeartbeat(tmpDir);
    // Write state without lastPeriodic — simulates old format
    const mocoDir = path.join(tmpDir, '.mococo');
    fs.mkdirSync(mocoDir, { recursive: true });
    fs.writeFileSync(
      path.join(mocoDir, 'heartbeat-state.json'),
      JSON.stringify({ lastDaily: new Date().toISOString(), lastWeekly: new Date().toISOString() }),
    );

    const tasks = getDueHeartbeatTasks(tmpDir);
    const periodicTasks = tasks.filter(t => t.section === 'periodic');
    // Should treat missing lastPeriodic as null → periodic is due
    expect(periodicTasks).toHaveLength(2);
  });
});

describe('getDueHeartbeatTasks — hourly scheduling', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-hourly-'));
    vi.mocked(isBusy).mockReturnValue(false);
    vi.mocked(isQueued).mockReturnValue(false);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeState(dir: string, state: { lastDaily?: string; lastWeekly?: string; lastPeriodic?: string | null; lastHourly?: string | null }) {
    const mocoDir = path.join(dir, '.mococo');
    fs.mkdirSync(mocoDir, { recursive: true });
    fs.writeFileSync(
      path.join(mocoDir, 'heartbeat-state.json'),
      JSON.stringify({
        lastDaily: state.lastDaily ?? new Date().toISOString(),
        lastWeekly: state.lastWeekly ?? new Date().toISOString(),
        lastPeriodic: state.lastPeriodic ?? null,
        lastHourly: state.lastHourly ?? null,
      }),
    );
  }

  function writeHourlyHeartbeat(dir: string) {
    fs.writeFileSync(path.join(dir, 'heartbeat.md'), `
## Hourly
- [ ] 코드 분석 @체커코코
- [ ] 이슈 관리 @대장코코
`);
  }

  it('includes hourly tasks when lastHourly is null (never run)', () => {
    writeHourlyHeartbeat(tmpDir);
    writeState(tmpDir, { lastHourly: null });

    const tasks = getDueHeartbeatTasks(tmpDir);
    const hourlyTasks = tasks.filter(t => t.section === 'hourly');
    expect(hourlyTasks).toHaveLength(2);
  });

  it('includes hourly tasks when last run was in a previous hour', () => {
    writeHourlyHeartbeat(tmpDir);
    // Set lastHourly to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    writeState(tmpDir, { lastHourly: twoHoursAgo });

    const tasks = getDueHeartbeatTasks(tmpDir);
    const hourlyTasks = tasks.filter(t => t.section === 'hourly');
    expect(hourlyTasks).toHaveLength(2);
  });

  it('excludes hourly tasks when already run this hour', () => {
    writeHourlyHeartbeat(tmpDir);
    // Set lastHourly to current time (same hour)
    writeState(tmpDir, { lastHourly: new Date().toISOString() });

    const tasks = getDueHeartbeatTasks(tmpDir);
    const hourlyTasks = tasks.filter(t => t.section === 'hourly');
    expect(hourlyTasks).toHaveLength(0);
  });

  it('includes hourly tasks at hour boundary', () => {
    writeHourlyHeartbeat(tmpDir);
    // Set lastHourly to 59 minutes ago — if that crosses the hour boundary, it should be due
    const now = new Date();
    const lastHour = new Date(now);
    lastHour.setHours(lastHour.getHours() - 1);
    writeState(tmpDir, { lastHourly: lastHour.toISOString() });

    const tasks = getDueHeartbeatTasks(tmpDir);
    const hourlyTasks = tasks.filter(t => t.section === 'hourly');
    expect(hourlyTasks).toHaveLength(2);
  });

  it('handles mixed sections with hourly correctly', () => {
    fs.writeFileSync(path.join(tmpDir, 'heartbeat.md'), `
## Periodic
- [ ] 상시 모니터링

## Hourly
- [ ] 시간별 작업

## Daily
- [ ] 일일 작업
`);
    // daily+hourly not run, weekly already run
    writeState(tmpDir, { lastHourly: null, lastDaily: '2020-01-01T00:00:00Z', lastWeekly: new Date().toISOString() });

    const tasks = getDueHeartbeatTasks(tmpDir);
    expect(tasks.map(t => t.section).sort()).toEqual(['daily', 'hourly', 'periodic']);
  });
});
