/**
 * Pure vault rules (FR-DOC-005, 006, 017).
 */

/** FR-DOC-005: a re-authentication counts for `minutes` (org setting, default 10). */
export function reauthValid(at: Date | null, now: Date, minutes: number): boolean {
  if (!at) return false;
  const age = now.getTime() - at.getTime();
  return age >= 0 && age < minutes * 60_000;
}

export const PASSWORD_MAX_FAILURES = 3;
export const PASSWORD_LOCK_MINUTES = 15;

/** FR-DOC-006: after the 3rd wrong document password the user is locked out of it for 15 minutes. */
export function lockoutAfterFailure(previousFailures: number, now: Date): { failures: number; lockedUntil: Date | null; justLocked: boolean } {
  const failures = previousFailures + 1;
  if (failures < PASSWORD_MAX_FAILURES) return { failures, lockedUntil: null, justLocked: false };
  return { failures: 0, lockedUntil: new Date(now.getTime() + PASSWORD_LOCK_MINUTES * 60_000), justLocked: true };
}

function addYears(d: Date, years: number): Date {
  const out = new Date(d);
  out.setUTCFullYear(out.getUTCFullYear() + years);
  return out;
}

/** FR-DOC-017: the date until which a document must be kept, if that is still in the future. */
export function retentionBlocksDelete(createdAt: Date, minYears: number | null, now: Date, legalHold: boolean): Date | null {
  void legalHold; // a legal hold blocks deletion separately, whatever the retention rule
  if (!minYears) return null;
  const until = addYears(createdAt, minYears);
  return until.getTime() > now.getTime() ? until : null;
}

/** FR-DOC-017: shredded automatically once older than the category's maximum, unless on hold. */
export function autoShredDue(createdAt: Date, autoShredYears: number | null, now: Date, legalHold: boolean): boolean {
  if (legalHold || !autoShredYears) return false;
  return addYears(createdAt, autoShredYears).getTime() <= now.getTime();
}

/** Deleted documents stay in the trash (restorable) for 30 days, then are crypto-shredded. */
export const TRASH_DAYS = 30;

export function trashExpired(deletedAt: Date | null, now: Date): boolean {
  return !!deletedAt && now.getTime() - deletedAt.getTime() >= TRASH_DAYS * 86_400_000;
}
