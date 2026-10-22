/**
 * Re-authentication for sensitive actions (ownership transfer, removing an owner; ADR 037): the
 * person confirms with their current password or, for accounts without one (Google sign-in),
 * with a 2FA code. Framework-free so it can be ported with the auth services.
 */
import { UnauthorizedException } from '@nestjs/common';
import argon2 from 'argon2';
import { consumeTotpStep, totpStep } from './totp.ts';

interface Db { query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }> }

export async function verifyReauth(db: Db, userId: string, proof: { password?: string; totpCode?: string }): Promise<void> {
  const row = (await db.query(`SELECT password_hash, mfa_enabled, mfa_secret FROM users WHERE id = $1`, [userId])).rows[0] as
    { password_hash: string | null; mfa_enabled: boolean; mfa_secret: string | null } | undefined;
  if (!row) throw new UnauthorizedException('Re-authentication failed');
  if (proof.password && row.password_hash) {
    if (await argon2.verify(row.password_hash, proof.password)) return;
    throw new UnauthorizedException('The password is not correct');
  }
  if (proof.totpCode && row.mfa_enabled && row.mfa_secret) {
    const step = totpStep(row.mfa_secret, proof.totpCode);
    if (step !== null && await consumeTotpStep(db, userId, step)) return;
    throw new UnauthorizedException('The 2FA code is not correct');
  }
  throw new UnauthorizedException(row.password_hash ? 'Confirm with your password' : 'Confirm with a 2FA code');
}
