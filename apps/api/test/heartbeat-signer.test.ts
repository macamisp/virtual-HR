/**
 * FR-ATT-004 / FR-ATT-017: the browser-compatible WebCrypto signer in packages/shared must
 * produce byte-identical signatures to the Node validator, and the validator must accept them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { HeartbeatValidator } from '../src/attendance/heartbeat-validator.ts';
import {
  heartbeatCanonicalString,
  signHeartbeatPayload,
  signHeartbeatWebCrypto,
} from '../../../packages/shared/src/attendance/heartbeat-signer.ts';
import type { UnsignedHeartbeat } from '../../../packages/shared/src/attendance/heartbeat-signer.ts';

function randomHeartbeat(seq: number): UnsignedHeartbeat {
  const active = randomInt(0, 31);
  return {
    orgId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    deviceId: `device-${randomBytes(4).toString('hex')}`,
    sessionId: crypto.randomUUID(),
    sequenceNumber: seq,
    nonce: randomBytes(16).toString('hex'),
    activeSeconds: active,
    idleSeconds: randomInt(0, 31 - active),
    tabVisible: randomInt(0, 2) === 1,
    windowFocused: randomInt(0, 2) === 1,
    inCall: randomInt(0, 2) === 1,
    meetingId: randomInt(0, 2) === 1 ? `meet-${randomBytes(3).toString('hex')}` : undefined,
  };
}

describe('Browser heartbeat signer (WebCrypto) vs Node validator', () => {
  const validator = new HeartbeatValidator();

  it('uses the same canonical string as the validator', () => {
    const hb = randomHeartbeat(1);
    assert.equal(heartbeatCanonicalString(hb), validator.getCanonicalString(hb));
  });

  it('produces identical HMAC-SHA256 signatures for 200 random payloads', async () => {
    for (let i = 1; i <= 200; i++) {
      const hb = randomHeartbeat(i);
      const secret = randomBytes(32).toString('hex');
      const web = await signHeartbeatWebCrypto(hb, secret);
      assert.equal(web, validator.signHeartbeat(hb, secret));
      assert.equal(web, createHmac('sha256', secret).update(heartbeatCanonicalString(hb)).digest('hex'));
    }
  });

  it('matches for non-ASCII device ids and secrets (UTF-8 encoding)', async () => {
    const hb = { ...randomHeartbeat(7), deviceId: 'laptop-ශ්‍රී-東京-✓' };
    const secret = 'sécret-ключ-🔑';
    assert.equal(await signHeartbeatWebCrypto(hb, secret), validator.signHeartbeat(hb, secret));
  });

  it('treats a missing meetingId like the validator does', async () => {
    const hb = randomHeartbeat(3);
    delete hb.meetingId;
    const secret = randomBytes(32).toString('hex');
    assert.equal(await signHeartbeatWebCrypto(hb, secret), validator.signHeartbeat(hb, secret));
  });

  it('a WebCrypto-signed payload passes validation; a tampered one fails', async () => {
    const v = new HeartbeatValidator();
    const secret = randomBytes(32).toString('hex');
    const signed = await signHeartbeatPayload(randomHeartbeat(1), secret);
    assert.deepEqual(v.validate(signed, secret), { valid: true });
    const tampered = { ...(await signHeartbeatPayload(randomHeartbeat(2), secret)), activeSeconds: 0, idleSeconds: 1 };
    assert.equal(v.validate(tampered, secret).valid, false);
  });
});
