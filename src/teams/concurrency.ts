import type { TeamId } from '../types.js';

const busyTeams = new Map<TeamId, { since: Date; task: string }>();
const queues = new Map<TeamId, (() => void)[]>();

export function isBusy(teamId: TeamId): boolean {
  return busyTeams.has(teamId);
}

export function markBusy(teamId: TeamId, task: string) {
  busyTeams.set(teamId, { since: new Date(), task });
}

export function markFree(teamId: TeamId) {
  busyTeams.delete(teamId);
  const queue = queues.get(teamId);
  if (queue && queue.length > 0) {
    const next = queue.shift()!;
    next();
  }
}

export function waitForFree(teamId: TeamId): Promise<void> {
  if (!isBusy(teamId)) return Promise.resolve();
  return new Promise((resolve) => {
    // Re-check after Promise creation — markFree() may have run between
    // the initial check and this point
    if (!isBusy(teamId)) {
      resolve();
      return;
    }
    if (!queues.has(teamId)) queues.set(teamId, []);
    queues.get(teamId)!.push(resolve);
  });
}

export function isQueued(teamId: TeamId): boolean {
  const queue = queues.get(teamId);
  return !!queue && queue.length > 0;
}

export function getStatus(): Record<string, { busy: boolean; since?: Date; task?: string }> {
  const status: Record<string, { busy: boolean; since?: Date; task?: string }> = {};
  for (const [id, info] of busyTeams) {
    status[id] = { busy: true, ...info };
  }
  return status;
}
