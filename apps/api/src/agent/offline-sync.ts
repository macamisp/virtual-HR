/**
 * Offline buffering and sync for the desktop agent (FR-ATT-012; ADR 018).
 *
 * Exception to "server clock only", agreed with the product owner: offline time cannot be seen
 * by the server, so it is reconstructed — but never from the device's wall clock. Every
 * heartbeat acknowledgement carries a server-signed anchor (server time, HMAC over org, user,
 * device and time). Offline, the agent records 30-second intervals as offsets on a monotonic
 * timer from that anchor. On sync the server rebuilds each interval's time from its own anchor,
 * keeps only what lies in its own heartbeat gaps, caps the window at 12 hours, and the result is
 * flagged OFFLINE_SYNCED for review. Changing the PC clock has no effect.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { formatInTimeZone } from 'date-fns-tz';

export interface AnchorContext { orgId: string; userId: string; deviceId: string }
export interface OfflineInterval { offsetMs: number; activeSeconds: number; idleSeconds: number }
export interface Span { start: Date; end: Date }

export type RejectReason = 'INVALID' | 'FUTURE' | 'TOO_OLD' | 'OVERLAP' | 'STALE_ANCHOR' | 'OVER_LIMIT';

export interface PlannedSegment { state: 'ACTIVE' | 'IDLE'; start: Date; end: Date }
export interface PlannedSession {
  workDate: string;
  start: Date;
  end: Date;
  activeSeconds: number;
  idleSeconds: number;
  segments: PlannedSegment[];
}
export interface OfflinePlan {
  accepted: number;
  rejected: Partial<Record<RejectReason, number>>;
  sessions: PlannedSession[];
}

const INTERVAL_MS = 30_000;
/** A pause in the buffer longer than this starts a new session (same as the missed-heartbeat timeout). */
const SESSION_GAP_MS = 90_000;
export const MAX_INTERVALS = 1440; // 12 h of 30-second intervals

/** Anchor key, derived from the JWT secret so no extra secret has to be managed. */
export function anchorKey(jwtSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', jwtSecret, 'hrvo', 'hrvo-agent-anchor-v1', 32));
}

const anchorMessage = (c: AnchorContext, serverMs: number) => `anchor:v1:${c.orgId}:${c.userId}:${c.deviceId}:${serverMs}`;

export function signAnchor(key: Buffer, c: AnchorContext, serverMs: number): string {
  return createHmac('sha256', key).update(anchorMessage(c, serverMs)).digest('hex');
}

export function verifyAnchor(key: Buffer, c: AnchorContext, serverMs: number, signature: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(signAnchor(key, c, serverMs), 'hex');
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

/**
 * Pure planning step: which intervals are accepted and how they become sessions and segments.
 * `covered` = time the server already accounts for (its own sessions), so synced time only fills gaps.
 */
export function planOfflineSync(p: {
  anchorServerMs: number;
  intervals: OfflineInterval[];
  nowMs: number;
  covered: Span[];
  maxWindowSeconds: number;
  timeZone: string;
}): OfflinePlan {
  const rejected: Partial<Record<RejectReason, number>> = {};
  const reject = (r: RejectReason, n = 1) => { rejected[r] = (rejected[r] ?? 0) + n; };
  const windowMs = p.maxWindowSeconds * 1000;
  // An anchor older than the window plus a day of travel time cannot produce acceptable time.
  if (p.anchorServerMs > p.nowMs || p.nowMs - p.anchorServerMs > windowMs + 24 * 3600_000) {
    reject('STALE_ANCHOR', p.intervals.length || 1);
    return { accepted: 0, rejected, sessions: [] };
  }

  const ok: Span[] = [];
  const kinds: Array<'ACTIVE' | 'IDLE'> = [];
  const counters: Array<{ a: number; i: number }> = [];
  let lastEnd = -Infinity;
  for (const [index, iv] of p.intervals.entries()) {
    if (index >= MAX_INTERVALS) { reject('OVER_LIMIT'); continue; }
    const valid = Number.isInteger(iv.offsetMs) && iv.offsetMs >= 0 && Number.isInteger(iv.activeSeconds) && Number.isInteger(iv.idleSeconds) &&
      iv.activeSeconds >= 0 && iv.idleSeconds >= 0 && iv.activeSeconds + iv.idleSeconds <= 30 && iv.activeSeconds + iv.idleSeconds > 0;
    const startMs = p.anchorServerMs + iv.offsetMs;
    if (!valid || startMs < lastEnd) { reject('INVALID'); continue; }
    const endMs = startMs + INTERVAL_MS;
    if (iv.offsetMs + INTERVAL_MS > windowMs) { reject('TOO_OLD'); continue; }
    if (endMs > p.nowMs) { reject('FUTURE'); continue; }
    const span = { start: new Date(startMs), end: new Date(endMs) };
    if (p.covered.some((c) => overlaps(c, span))) { reject('OVERLAP'); lastEnd = endMs; continue; }
    lastEnd = endMs;
    ok.push(span);
    kinds.push(iv.activeSeconds > 0 ? 'ACTIVE' : 'IDLE');
    counters.push({ a: iv.activeSeconds, i: iv.idleSeconds });
  }

  const sessions: PlannedSession[] = [];
  let cur: PlannedSession | null = null;
  ok.forEach((span, k) => {
    const workDate = formatInTimeZone(span.start, p.timeZone, 'yyyy-MM-dd');
    const startNew = !cur || cur.workDate !== workDate || span.start.getTime() - cur.end.getTime() > SESSION_GAP_MS;
    if (startNew) {
      cur = { workDate, start: span.start, end: span.end, activeSeconds: 0, idleSeconds: 0, segments: [] };
      sessions.push(cur);
    }
    const s = cur!;
    s.end = span.end;
    s.activeSeconds += counters[k]!.a;
    s.idleSeconds += counters[k]!.i;
    const last = s.segments[s.segments.length - 1];
    if (last && last.state === kinds[k] && span.start.getTime() - last.end.getTime() <= SESSION_GAP_MS) last.end = span.end;
    else s.segments.push({ state: kinds[k]!, start: span.start, end: span.end });
  });
  return { accepted: ok.length, rejected, sessions };
}
