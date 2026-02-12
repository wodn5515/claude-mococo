import crypto from 'node:crypto';
import type { DispatchRecord } from '../types.js';

const MAX_RECORDS = 200;
const EXPIRE_MS = 60 * 60 * 1000; // 1 hour

class DispatchLedger {
  private records: DispatchRecord[] = [];

  record(
    chainId: string,
    fromTeam: string,
    toTeam: string,
    channelId: string,
    reason: string,
  ): DispatchRecord {
    const rec: DispatchRecord = {
      id: crypto.randomUUID(),
      chainId,
      fromTeam,
      toTeam,
      channelId,
      reason: reason.slice(0, 200),
      dispatchedAt: Date.now(),
      resolved: false,
    };
    this.records.push(rec);
    this.cleanup();
    return rec;
  }

  /**
   * Mark records resolved when toTeam's output mentions fromTeam.
   */
  resolve(toTeam: string, mentionedTeamIds: string[]): void {
    for (const rec of this.records) {
      if (rec.toTeam === toTeam && !rec.resolved && mentionedTeamIds.includes(rec.fromTeam)) {
        rec.resolved = true;
        rec.resolvedAt = Date.now();
      }
    }
  }

  /**
   * Get unresolved dispatches, optionally filtered by age.
   */
  getUnresolved(olderThanMs?: number): DispatchRecord[] {
    const now = Date.now();
    return this.records.filter(r => {
      if (r.resolved) return false;
      if (olderThanMs && (now - r.dispatchedAt) < olderThanMs) return false;
      return true;
    });
  }

  /**
   * Remove expired records to prevent memory growth.
   */
  private cleanup(): void {
    const cutoff = Date.now() - EXPIRE_MS;
    this.records = this.records
      .filter(r => r.dispatchedAt > cutoff || !r.resolved)
      .slice(-MAX_RECORDS);
  }
}

// Singleton
export const ledger = new DispatchLedger();
