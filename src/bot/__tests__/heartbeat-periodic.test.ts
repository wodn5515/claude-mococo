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

    // Write heartbeat state to avoid daily/weekly tasks triggering
    const mocoDir = path.join(tmpDir, '.mococo');
    fs.mkdirSync(mocoDir, { recursive: true });
    fs.writeFileSync(
      path.join(mocoDir, 'heartbeat-state.json'),
      JSON.stringify({ lastDaily: new Date().toISOString(), lastWeekly: new Date().toISOString() }),
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
