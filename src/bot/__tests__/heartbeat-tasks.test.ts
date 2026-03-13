import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAllTasks,
  getTasksBySchedule,
  addRuntimeTask,
  removeRuntimeTask,
  listRuntimeTasks,
  toHeartbeatTasks,
  _resetRuntimeForTesting,
} from '../heartbeat-tasks.js';

describe('heartbeat-tasks TaskRegistry', () => {
  beforeEach(() => {
    _resetRuntimeForTesting();
  });

  // TC-11: getDueHeartbeatTasks('daily') returns daily tasks
  it('TC-11: getTasksBySchedule returns only tasks of given schedule', () => {
    const daily = getTasksBySchedule('daily');
    expect(daily.length).toBeGreaterThan(0);
    expect(daily.every(t => t.schedule === 'daily')).toBe(true);
  });

  // TC-13: Task count matches heartbeat.md
  it('TC-13: all static tasks are present (5 daily + 3 weekly + 4 periodic = 12)', () => {
    const all = getAllTasks();
    expect(all.length).toBe(12);

    expect(getTasksBySchedule('daily').length).toBe(5);
    expect(getTasksBySchedule('weekly').length).toBe(3);
    expect(getTasksBySchedule('periodic').length).toBe(4);
    expect(getTasksBySchedule('hourly').length).toBe(0);
    expect(getTasksBySchedule('on-demand').length).toBe(0);
  });

  it('toHeartbeatTasks returns backward-compatible format', () => {
    const tasks = toHeartbeatTasks();
    expect(tasks.length).toBe(12);
    expect(tasks[0]).toHaveProperty('section');
    expect(tasks[0]).toHaveProperty('content');
    expect(tasks[0]).toHaveProperty('assignee');
  });

  it('addRuntimeTask adds a task visible in getAllTasks', () => {
    const task = addRuntimeTask('테스트 작업', 'hourly', '스택코코');
    expect(task.id).toMatch(/^runtime-/);

    const all = getAllTasks();
    expect(all.length).toBe(13); // 12 static + 1 runtime

    const hourly = getTasksBySchedule('hourly');
    expect(hourly.length).toBe(1);
    expect(hourly[0].description).toBe('테스트 작업');
  });

  it('removeRuntimeTask removes the task', () => {
    const task = addRuntimeTask('삭제 대상', 'daily');
    expect(getAllTasks().length).toBe(13);

    const removed = removeRuntimeTask(task.id);
    expect(removed).toBe(true);
    expect(getAllTasks().length).toBe(12);
  });

  it('removeRuntimeTask returns false for non-existent id', () => {
    expect(removeRuntimeTask('nonexistent')).toBe(false);
  });

  it('listRuntimeTasks returns only runtime tasks', () => {
    addRuntimeTask('런타임 1', 'periodic');
    addRuntimeTask('런타임 2', 'daily');

    const runtime = listRuntimeTasks();
    expect(runtime.length).toBe(2);
    expect(runtime.every(t => t.id.startsWith('runtime-'))).toBe(true);
  });

  // TC-15: heartbeat.md existence doesn't affect TaskRegistry
  it('TC-15: TaskRegistry operates independently of heartbeat.md', () => {
    // TaskRegistry doesn't read files — it's purely code-defined
    const tasks = getAllTasks();
    expect(tasks.length).toBe(12);
  });
});
