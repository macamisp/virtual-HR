import { verifySync } from 'otplib';

/**
 * Clock-drift tolerance for 2FA codes: one 30-second step either side (RFC 6238 §5.2), so a phone
 * whose clock is up to ~30 s off, or a code typed as the step changes, is still accepted.
 */
export const TOTP_EPOCH_TOLERANCE_SECONDS = 30;

/** otplib throws on non-6-digit input, so only TOTP-shaped codes reach it. */
export function verifyTotp(secret: string, code: string, nowMs: number = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  return verifySync({ token: code, secret, epochTolerance: TOTP_EPOCH_TOLERANCE_SECONDS, epoch: Math.floor(nowMs / 1000) }).valid;
}
