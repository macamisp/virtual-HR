import { verifySync } from 'otplib';

/**
 * Clock-drift tolerance for 2FA codes: one 30-second step either side (RFC 6238 §5.2), so a phone
 * whose clock is up to ~30 s off, or a code typed as the step changes, is still accepted.
 */
export const TOTP_EPOCH_TOLERANCE_SECONDS = 30;
const TOTP_STEP_SECONDS = 30;

/**
 * The 30-second time step a code belongs to, or null when the code is wrong. otplib throws on
 * non-6-digit input, so only TOTP-shaped codes reach it.
 */
export function totpStep(secret: string, code: string, nowMs: number = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const epoch = Math.floor(nowMs / 1000);
  const r = verifySync({ token: code, secret, epochTolerance: TOTP_EPOCH_TOLERANCE_SECONDS, epoch });
  // delta is the matched step relative to the server's current one (-1, 0 or +1).
  return r.valid ? Math.floor(epoch / TOTP_STEP_SECONDS) + r.delta : null;
}

export function verifyTotp(secret: string, code: string, nowMs: number = Date.now()): boolean {
  return totpStep(secret, code, nowMs) !== null;
}

interface Db { query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }> }

/**
 * Single use: records the step as the person's newest and returns true only when it is newer than
 * the last one used. One conditional UPDATE, so two simultaneous requests with the same code
 * cannot both win.
 */
export async function consumeTotpStep(db: Db, userId: string, step: number): Promise<boolean> {
  const res = await db.query(
    `UPDATE users SET mfa_last_used_step = $2 WHERE id = $1 AND (mfa_last_used_step IS NULL OR mfa_last_used_step < $2)`,
    [userId, step],
  );
  return (res.rowCount ?? 0) === 1;
}
