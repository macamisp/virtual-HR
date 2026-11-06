/**
 * ADR 049 §1d (FR-WT-003): one browser, several tabs. The tab that owns the call is not always the
 * heartbeat leader (two independent Web Locks, ADR 006 and 048), so the owner broadcasts its call
 * state and the leader reports a call when its own tab, or a fresh broadcast, says so.
 */
export interface TabCallState {
  inCall: boolean;
  meetingId: string | null;
  /** Wall-clock ms in the browser when the state was broadcast (used only to expire it). */
  at: number;
}

/** How often the owning tab repeats its call state, and when a silent tab's state expires. */
export const CALL_SHARE_REPEAT_MS = 15_000;
export const CALL_SHARE_STALE_MS = 45_000;
export const CALL_SHARE_CHANNEL = 'hrvo-call-state';

export function effectiveCall(local: { inCall: boolean; meetingId: string | null }, remotes: Iterable<TabCallState>, now: number): { inCall: boolean; meetingId: string | null } {
  if (local.inCall) return { inCall: true, meetingId: local.meetingId };
  let best: TabCallState | null = null;
  for (const r of remotes) {
    if (!r.inCall || now - r.at > CALL_SHARE_STALE_MS || r.at - now > CALL_SHARE_STALE_MS) continue;
    if (!best || r.at > best.at) best = r;
  }
  return best ? { inCall: true, meetingId: best.meetingId } : { inCall: false, meetingId: null };
}
