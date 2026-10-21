/** FR-AUTH-004: 2FA codes tolerate one 30-second step of clock drift, and no more. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecret, generateSync } from 'otplib';
import { verifyTotp } from '../src/auth/totp.ts';

describe('verifyTotp clock-drift tolerance', () => {
  const secret = generateSecret();
  const now = 1_800_000_015_000; // mid-step
  const codeAt = (offsetSeconds: number) => generateSync({ secret, epoch: Math.floor(now / 1000) + offsetSeconds });

  it('accepts the current code', () => assert.equal(verifyTotp(secret, codeAt(0), now), true));
  it('accepts the previous and the next step (phone clock 30 s off)', () => {
    assert.equal(verifyTotp(secret, codeAt(-30), now), true);
    assert.equal(verifyTotp(secret, codeAt(30), now), true);
  });
  it('refuses codes two or more steps away', () => {
    assert.equal(verifyTotp(secret, codeAt(-60), now), false);
    assert.equal(verifyTotp(secret, codeAt(60), now), false);
  });
  it('refuses malformed input without throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 456']) assert.equal(verifyTotp(secret, bad, now), false);
  });
});
