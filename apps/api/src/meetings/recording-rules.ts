/**
 * Meeting recording rules (FR-MEET-007, ADR 024). Pure functions; the service supplies the data.
 */

/** How long the people in a meeting have to answer a recording request. */
export const CONSENT_WINDOW_SECONDS = 120;

export type ConsentOutcome = 'PENDING' | 'START' | 'REFUSED' | 'EXPIRED';

/**
 * Recording starts only when every required person's latest answer is yes. One no refuses it;
 * silence past the deadline expires it. Answers from people who are not required are ignored.
 */
export function consentOutcome(required: string[], answers: Array<{ userId: string; granted: boolean }>, deadline: Date, now: Date): ConsentOutcome {
  if (!required.length) return 'PENDING';
  const latest = new Map<string, boolean>();
  for (const a of answers) latest.set(a.userId, a.granted);
  const need = new Set(required);
  if ([...need].some((u) => latest.get(u) === false)) return 'REFUSED';
  if ([...need].every((u) => latest.get(u) === true)) return 'START';
  return now.getTime() >= deadline.getTime() ? 'EXPIRED' : 'PENDING';
}

/** Host and co-hosts, and anyone who was recorded (they consented), may watch. */
export function canWatchRecording(p: { role: 'HOST' | 'COHOST' | 'ATTENDEE' | 'NONE'; consented: boolean }): boolean {
  return p.role === 'HOST' || p.role === 'COHOST' || p.consented;
}

export function recordingExpiry(endedAt: Date, retentionDays: number): Date {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error('Retention must be at least one day');
  return new Date(endedAt.getTime() + retentionDays * 86_400_000);
}
