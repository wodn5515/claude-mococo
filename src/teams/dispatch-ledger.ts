import crypto from 'node:crypto';
import type { DispatchRecord } from '../types.js';

const MAX_RECORDS = 200;
/** 해결된 레코드 만료 시간 (기본 1시간) */
const EXPIRE_MS = 60 * 60 * 1000; // 1 hour
/** 미해결 레코드 강제 만료 시간 — EXPIRE_MS의 배수로 설정 (기본 3배 = 3시간) */
const HARD_CUTOFF_MULTIPLIER = 3;

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
   * For system-dispatched records (fromTeam='system'), any response from toTeam
   * auto-resolves since teams cannot mention 'system'.
   */
  resolve(toTeam: string, mentionedTeamIds: string[]): void {
    for (const rec of this.records) {
      if (rec.toTeam === toTeam && !rec.resolved) {
        if (rec.fromTeam === 'system' || mentionedTeamIds.includes(rec.fromTeam)) {
          rec.resolved = true;
          rec.resolvedAt = Date.now();
        }
      }
    }
  }

  /** Resolve a specific record by ID (for system auto-resolution). */
  resolveById(recordId: string): void {
    const rec = this.records.find(r => r.id === recordId);
    if (rec && !rec.resolved) {
      rec.resolved = true;
      rec.resolvedAt = Date.now();
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
    const hardCutoff = Date.now() - EXPIRE_MS * HARD_CUTOFF_MULTIPLIER;
    this.records = this.records
      .filter(r => {
        if (r.dispatchedAt < hardCutoff) return false; // force expire old unresolved
        return r.dispatchedAt > cutoff || !r.resolved;
      })
      .slice(-MAX_RECORDS);
  }
}

// Singleton
export const ledger = new DispatchLedger();
