import fs from 'node:fs';
import path from 'node:path';

interface InboxTask {
  fn: () => Promise<void>;
  cancelled: boolean;
}

const inboxWriteQueue: InboxTask[] = [];
let isProcessingInboxQueue = false;
let inboxQueueHead = 0;

async function processInboxWriteQueue() {
  if (isProcessingInboxQueue || inboxQueueHead >= inboxWriteQueue.length) return;
  isProcessingInboxQueue = true;

  try {
    while (inboxQueueHead < inboxWriteQueue.length) {
      const task = inboxWriteQueue[inboxQueueHead];
      inboxWriteQueue[inboxQueueHead] = null as any; // Release reference for GC
      inboxQueueHead++;
      if (task.cancelled) continue;
      try {
        await task.fn();
      } catch (err) {
        console.error('[inbox-queue] Write failed:', err);
      }
    }
  } finally {
    isProcessingInboxQueue = false;
    if (inboxQueueHead < inboxWriteQueue.length) {
      processInboxWriteQueue().catch(err => console.error('[inbox-queue] Drain error:', err));
    } else {
      inboxWriteQueue.length = 0;
      inboxQueueHead = 0;
    }
  }
}

export function appendToInbox(teamId: string, from: string, content: string, workspacePath: string, channelId: string) {
  return new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      task.cancelled = true;
      console.warn(`[inbox-queue] Timed out writing to ${teamId} inbox (30s)`);
      reject(new Error(`[inbox-queue] Timed out writing to ${teamId} inbox`));
    }, 30_000);

    const task: InboxTask = {
      fn: async () => {
        // Clear timeout when task starts executing — prevents "write succeeds but promise rejects" race
        clearTimeout(timeoutId);
        if (task.cancelled) return;
        try {
          const dir = path.resolve(workspacePath, '.mococo/inbox');
          fs.mkdirSync(dir, { recursive: true });
          const file = path.resolve(dir, `${teamId}.md`);
          const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
          // Flatten multi-line content into single line to prevent summarizeInbox parse failures
          const flat = content.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ');
          await fs.promises.appendFile(file, `[${ts} #ch:${channelId}] ${from}: ${flat}\n`);
          resolve();
        } catch (err) {
          reject(err);
        }
      },
      cancelled: false,
    };

    inboxWriteQueue.push(task);
    processInboxWriteQueue().catch(err => console.error('[inbox-queue] Queue error:', err));
  });
}

export function clearInbox(teamId: string, workspacePath: string) {
  const file = path.resolve(workspacePath, '.mococo/inbox', `${teamId}.md`);
  try {
    fs.unlinkSync(file);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      console.error(`[clearInbox] Failed to delete ${file}:`, err);
    }
  }
}

/** Reset queue state — for testing only */
export function _resetInboxQueue() {
  inboxWriteQueue.length = 0;
  inboxQueueHead = 0;
  isProcessingInboxQueue = false;
}
