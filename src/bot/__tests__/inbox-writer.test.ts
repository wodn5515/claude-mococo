import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendToInbox, clearInbox, _resetInboxQueue } from '../inbox-writer.js';

describe('inbox-writer', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-test-'));
    _resetInboxQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('appendToInbox', () => {
    it('writes a message to the inbox file', async () => {
      const promise = appendToInbox('team1', 'Alice', 'Hello world', tmpDir, 'ch123');
      // Let the microtask queue flush (processInboxWriteQueue runs via Promise)
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      const file = path.resolve(tmpDir, '.mococo/inbox/team1.md');
      const content = fs.readFileSync(file, 'utf-8');
      expect(content).toContain('Alice: Hello world');
      expect(content).toContain('#ch:ch123');
    });

    it('flattens multi-line content', async () => {
      const promise = appendToInbox('team1', 'Bob', 'line1\nline2\r\nline3', tmpDir, 'ch1');
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      const file = path.resolve(tmpDir, '.mococo/inbox/team1.md');
      const content = fs.readFileSync(file, 'utf-8');
      expect(content).toContain('Bob: line1 line2 line3');
      // Should be a single line
      expect(content.trim().split('\n')).toHaveLength(1);
    });

    it('queues multiple writes sequentially', async () => {
      const p1 = appendToInbox('team1', 'A', 'msg1', tmpDir, 'ch1');
      const p2 = appendToInbox('team1', 'B', 'msg2', tmpDir, 'ch1');
      const p3 = appendToInbox('team1', 'C', 'msg3', tmpDir, 'ch1');
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all([p1, p2, p3]);

      const file = path.resolve(tmpDir, '.mococo/inbox/team1.md');
      const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('A: msg1');
      expect(lines[1]).toContain('B: msg2');
      expect(lines[2]).toContain('C: msg3');
    });

    it('rejects on timeout when task is cancelled before execution', async () => {
      // Simulate: task is enqueued but timeout fires before queue processes it
      // We do this by making the queue busy with a slow task
      let slowResolve: () => void;
      const slowPromise = new Promise<void>(r => { slowResolve = r; });
      vi.spyOn(fs.promises, 'appendFile').mockImplementationOnce(async () => {
        await slowPromise;
      });

      // First task blocks the queue
      const blocking = appendToInbox('team1', 'Slow', 'blocking', tmpDir, 'ch1');
      await vi.advanceTimersByTimeAsync(0); // Start processing (hits the mock)

      // Second task queued — its timeout will fire while waiting
      // Attach catch handler immediately to prevent unhandled rejection
      const waiting = appendToInbox('team2', 'Waiter', 'waiting', tmpDir, 'ch2');
      const waitingResult = waiting.catch(err => err);

      // Advance 30s — timeout fires for the waiting task
      await vi.advanceTimersByTimeAsync(30_001);

      // The waiting task should have been rejected by timeout
      const err = await waitingResult;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('Timed out');

      // Unblock the first task and let it complete
      vi.spyOn(fs.promises, 'appendFile').mockRestore();
      slowResolve!();
      // Use real timer briefly to let the blocking promise settle
      vi.useRealTimers();
      await blocking.catch(() => {}); // May resolve or reject depending on mock state
    });

    it('does not reject after successful write (race condition fix)', async () => {
      // The key fix: clearTimeout is called when task starts executing,
      // so a slow but successful write won't be rejected by timeout
      const promise = appendToInbox('team1', 'User', 'data', tmpDir, 'ch1');

      // Process the task (this clears the timeout)
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      // Even if we advance past 30s, no rejection should occur
      await vi.advanceTimersByTimeAsync(30_001);

      // Verify file was written
      const file = path.resolve(tmpDir, '.mococo/inbox/team1.md');
      expect(fs.existsSync(file)).toBe(true);
    });
  });

  describe('clearInbox', () => {
    it('deletes the inbox file', async () => {
      // Create an inbox file first
      const promise = appendToInbox('team1', 'X', 'msg', tmpDir, 'ch1');
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      const file = path.resolve(tmpDir, '.mococo/inbox/team1.md');
      expect(fs.existsSync(file)).toBe(true);

      clearInbox('team1', tmpDir);
      expect(fs.existsSync(file)).toBe(false);
    });

    it('does not throw for non-existent file', () => {
      expect(() => clearInbox('nonexistent', tmpDir)).not.toThrow();
    });
  });
});
