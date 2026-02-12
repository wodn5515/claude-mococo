import crypto from 'node:crypto';
import type { DispatchRecord } from '../types.js';

const MAX_RECORDS = 200;
/** 해결된 레코드 만료 시간 (기본 1시간) */
const EXPIRE_MS = 60 * 60 * 1000; // 1 hour
/** 미해결 레코드 강제 만료 시간 기본값 (6시간) */
const DEFAULT_HARD_CUTOFF_MS = 6 * 60 * 60 * 1000; // 6 hours

class DispatchLedger {
  private records: (DispatchRecord & { hardCutoffMs?: number })[] = [];
  private hardCutoffMs = DEFAULT_HARD_CUTOFF_MS;

  /** Override default hard cutoff (e.g., based on team maxBudget). */
  setHardCutoffMs(ms: number): void {
    this.hardCutoffMs = ms;
  }

  record(
    chainId: string,
    fromTeam: string,
    toTeam: string,
    channelId: string,
    reason: string,
    hardCutoffMs?: number,
  ): DispatchRecord {
    const rec: DispatchRecord & { hardCutoffMs?: number } = {
      id: crypto.randomUUID(),
      chainId,
      fromTeam,
      toTeam,
      channelId,
      reason: reason.slice(0, 200),
      dispatchedAt: Date.now(),
      resolved: false,
      hardCutoffMs,
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
    const now = Date.now();
    const cutoff = now - EXPIRE_MS;
    this.records = this.records
      .filter(r => {
        const recCutoff = now - (r.hardCutoffMs ?? this.hardCutoffMs);
        if (r.dispatchedAt < recCutoff) {
          if (!r.resolved) {
            const elapsedMin = Math.round((now - r.dispatchedAt) / 60_000);
            const cutoffMin = Math.round((r.hardCutoffMs ?? this.hardCutoffMs) / 60_000);
            console.warn(`[dispatch-ledger] Force-expiring unresolved record: ${r.fromTeam}→${r.toTeam} (${r.reason.slice(0, 50)}) — ${elapsedMin}분 경과 (timeout: ${cutoffMin}분)`);
          }
          return false;
        }
        return r.dispatchedAt > cutoff || !r.resolved;
      })
      .slice(-MAX_RECORDS);
  }
}

// Singleton
export const ledger = new DispatchLedger();
