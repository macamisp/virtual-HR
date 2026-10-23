/**
 * ADR 038: bounded retry of a whole transaction that Postgres aborted because of a deadlock
 * (40P01) or a serialization failure (40001). Only for idempotent work: the callback must open,
 * run and commit its own transaction, and have no side effect outside the database before the
 * commit, because the aborted attempt is rolled back and the callback runs again from the start.
 *
 * Every retry is counted (conflictRetryStats) and logged as one JSON line without parameters:
 *   {"event":"db_conflict_retry","op":"attendance.saveSession","kind":"deadlock","code":"40P01","attempt":1,"maxAttempts":3}
 */
const RETRYABLE: Readonly<Record<string, 'deadlock' | 'serialization'>> = { '40P01': 'deadlock', '40001': 'serialization' };
const counts = new Map<string, number>();

export function conflictKind(err: unknown): 'deadlock' | 'serialization' | null {
  const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? (RETRYABLE[code] ?? null) : null;
}

/** Retries so far in this process, keyed `op:kind` (for tests and operations). */
export function conflictRetryStats(): Record<string, number> {
  return Object.fromEntries(counts);
}

export function totalConflictRetries(): number {
  let n = 0;
  for (const v of counts.values()) n += v;
  return n;
}

export async function withConflictRetry<T>(op: string, fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const kind = conflictKind(err);
      if (!kind || attempt >= maxAttempts) throw err;
      const key = `${op}:${kind}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      console.warn(JSON.stringify({ event: 'db_conflict_retry', op, kind, code: (err as { code: string }).code, attempt, maxAttempts }));
      // Short jittered back-off: the other transaction usually commits within milliseconds.
      await new Promise((r) => setTimeout(r, attempt * (10 + Math.floor(Math.random() * 40))));
    }
  }
}
