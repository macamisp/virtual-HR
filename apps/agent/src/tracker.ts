/**
 * Activity measurement and offline buffering for the desktop agent (FR-ATT-011, FR-ATT-012; ADR 018).
 * No Electron imports: the main process feeds it OS idle time and a monotonic clock.
 */
import { randomUUID } from 'node:crypto';
import { AnchorSchema, OfflineIntervalSchema } from '../../../packages/shared/src/agent/types.ts';
import type { Anchor, OfflineInterval } from '../../../packages/shared/src/agent/types.ts';

export const INTERVAL_SECONDS = 30;
export const MAX_INTERVALS_PER_BATCH = 1440; // 12 hours
const INTERVAL_MS = INTERVAL_SECONDS * 1000;

export interface Counters { activeSeconds: number; idleSeconds: number }

/**
 * Counters for the last interval from the OS idle time (seconds since the last keyboard or
 * mouse input anywhere on the computer). Only this number is read, never the input itself.
 */
export function measureInterval(osIdleSeconds: number, locked: boolean): Counters {
  if (locked || !Number.isFinite(osIdleSeconds)) return { activeSeconds: 0, idleSeconds: INTERVAL_SECONDS };
  const idle = Math.min(INTERVAL_SECONDS, Math.max(0, Math.round(osIdleSeconds)));
  return { activeSeconds: INTERVAL_SECONDS - idle, idleSeconds: idle };
}

export interface PendingBatch { batchId: string; anchor: Anchor; intervals: OfflineInterval[] }
export type RecordResult = 'BUFFERED' | 'NO_ANCHOR' | 'FULL';

interface Live { anchor: Anchor; monoAtAnchor: number; batchId: string }

/**
 * Intervals recorded while offline, grouped by the server anchor they are measured from. The
 * agent never stores or sends wall-clock times: an interval is the offset of its start from the
 * anchor on a monotonic clock. A monotonic clock restarts with the process, so after a restart
 * the old anchor cannot be extended (its batches survive and are still uploaded).
 */
export class OfflineBuffer {
  private batches: PendingBatch[] = [];
  private live: Live | null = null;

  get size(): number {
    return this.batches.reduce((n, b) => n + b.intervals.length, 0);
  }

  /** A fresh anchor from a heartbeat acknowledgement; later offline time is measured from it. */
  setAnchor(anchor: Anchor, monoNowMs: number): void {
    this.live = { anchor, monoAtAnchor: monoNowMs, batchId: randomUUID() };
  }

  /** Record the interval that ended at `monoNowMs` (called only when the heartbeat could not be sent). */
  record(monoNowMs: number, c: Counters): RecordResult {
    const live = this.live;
    if (!live) return 'NO_ANCHOR';
    let batch = this.batches.find((b) => b.batchId === live.batchId);
    if (!batch) {
      batch = { batchId: live.batchId, anchor: live.anchor, intervals: [] };
      this.batches.push(batch);
    }
    if (batch.intervals.length >= MAX_INTERVALS_PER_BATCH) return 'FULL';
    const last = batch.intervals[batch.intervals.length - 1];
    const earliest = last ? last.offsetMs + INTERVAL_MS : 0;
    const offsetMs = Math.max(earliest, Math.round(monoNowMs - INTERVAL_MS - live.monoAtAnchor));
    batch.intervals.push({ offsetMs, activeSeconds: c.activeSeconds, idleSeconds: c.idleSeconds });
    return 'BUFFERED';
  }

  /** Batches waiting for upload, oldest first. */
  pending(): PendingBatch[] {
    return this.batches.filter((b) => b.intervals.length > 0).map((b) => ({ ...b, intervals: [...b.intervals] }));
  }

  /** The server applied (or had already applied) this batch. */
  acknowledge(batchId: string): void {
    this.batches = this.batches.filter((b) => b.batchId !== batchId);
    if (this.live?.batchId === batchId) this.live = { ...this.live, batchId: randomUUID() };
  }

  /** What is saved to disk (encrypted by the caller). The live anchor is not saved on purpose. */
  toJSON(): { batches: PendingBatch[] } {
    return { batches: this.pending() };
  }

  static fromJSON(raw: unknown): OfflineBuffer {
    const b = new OfflineBuffer();
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { batches?: unknown }).batches) ? (raw as { batches: unknown[] }).batches : [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const { batchId, anchor, intervals } = item as Partial<PendingBatch>;
      const a = AnchorSchema.safeParse(anchor);
      const ivs = Array.isArray(intervals) ? intervals.map((i) => OfflineIntervalSchema.safeParse(i)) : [];
      if (typeof batchId !== 'string' || !/^[0-9a-f-]{36}$/.test(batchId) || !a.success || !ivs.length || ivs.some((r) => !r.success)) continue;
      b.batches.push({ batchId, anchor: a.data, intervals: ivs.map((r) => r.data!).slice(0, MAX_INTERVALS_PER_BATCH) });
    }
    return b;
  }
}
