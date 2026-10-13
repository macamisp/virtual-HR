/**
 * HRVO Heartbeat Validator & Anti-Spoofing Service
 * Reference: docs/SRS.md Section 5.5 (FR-ATT-004, FR-ATT-017) & Section 6.3
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { SystemClock } from '../../../../packages/shared/src/attendance/types.ts';
import type { Clock, HeartbeatPayload } from '../../../../packages/shared/src/attendance/types.ts';
import type { IAttendanceRepository } from './attendance-repository.ts';

export interface HeartbeatValidationResult {
  valid: boolean;
  reason?: string;
}

export class HeartbeatValidator {
  // In-memory nonce cache with timestamps for replay protection (when repository not injected)
  private seenNonces = new Map<string, number>();
  // Device sequence number tracker: orgId:userId:deviceId -> lastSequenceNumber
  private deviceSequences = new Map<string, number>();

  private nonceTtlMs: number;
  private clock: Clock;

  constructor(nonceTtlMs: number = 300_000, clock: Clock = new SystemClock()) {
    this.nonceTtlMs = nonceTtlMs;
    this.clock = clock;
  }

  /**
   * Produce the canonical string representation of the heartbeat for signing
   */
  public getCanonicalString(hb: Omit<HeartbeatPayload, 'signature'>): string {
    return [
      hb.orgId,
      hb.userId,
      hb.deviceId,
      hb.sessionId,
      hb.sequenceNumber,
      hb.nonce,
      hb.activeSeconds,
      hb.idleSeconds,
      hb.tabVisible ? '1' : '0',
      hb.windowFocused ? '1' : '0',
      hb.inCall ? '1' : '0',
      hb.meetingId ?? '',
    ].join(':');
  }

  /**
   * Compute HMAC-SHA256 signature for a payload given a secret key
   */
  public signHeartbeat(hb: Omit<HeartbeatPayload, 'signature'>, secret: string): string {
    const canonical = this.getCanonicalString(hb);
    return createHmac('sha256', secret).update(canonical).digest('hex');
  }

  /**
   * Validate incoming heartbeat synchronously (in-memory)
   */
  public validate(
    hb: HeartbeatPayload,
    secret: string,
    now: Date = this.clock.now(),
  ): HeartbeatValidationResult {
    // 1. Privacy check: Ensure forbidden surveillance content fields are NOT present (FR-ATT-004)
    const raw = hb as Record<string, unknown>;
    if ('keystrokes' in raw || 'screenshots' in raw || 'urls' in raw || 'appName' in raw) {
      return {
        valid: false,
        reason: 'Privacy violation: Heartbeat must contain counters only (FR-ATT-004)',
      };
    }

    // 2. Interval bounds validation
    if (hb.activeSeconds < 0 || hb.idleSeconds < 0) {
      return { valid: false, reason: 'Invalid counter values: cannot be negative' };
    }
    if (hb.activeSeconds + hb.idleSeconds > 35) { // 30s + 5s network jitter allowance
      return {
        valid: false,
        reason: `Invalid counter total: ${hb.activeSeconds + hb.idleSeconds}s exceeds interval threshold`,
      };
    }

    // 3. Monotonic sequence number check per device (scoped by org, user, device)
    const deviceKey = `${hb.orgId}:${hb.userId}:${hb.deviceId}`;
    const lastSeq = this.deviceSequences.get(deviceKey) ?? 0;
    if (hb.sequenceNumber <= lastSeq) {
      return {
        valid: false,
        reason: `Sequence violation: sequence ${hb.sequenceNumber} <= last seen ${lastSeq}`,
      };
    }

    // 4. Nonce replay check
    this.cleanExpiredNonces(now.getTime());
    const nonceKey = `${hb.orgId}:${hb.userId}:${hb.nonce}`;
    if (this.seenNonces.has(nonceKey)) {
      return { valid: false, reason: `Replay attack detected: nonce ${hb.nonce} already used` };
    }

    // 5. Cryptographic signature check (HMAC-SHA256 with constant-time equality)
    const expectedSig = this.signHeartbeat(hb, secret);
    const expectedBuffer = Buffer.from(expectedSig, 'hex');
    const providedBuffer = Buffer.from(hb.signature || '', 'hex');

    if (
      expectedBuffer.length !== providedBuffer.length ||
      !timingSafeEqual(expectedBuffer, providedBuffer)
    ) {
      return { valid: false, reason: 'Invalid HMAC signature: payload tampered or unauthorized' };
    }

    // Passed all checks! Record state
    this.seenNonces.set(nonceKey, now.getTime());
    this.deviceSequences.set(deviceKey, hb.sequenceNumber);

    return { valid: true };
  }

  /**
   * Validate incoming heartbeat asynchronously against PostgreSQL repository
   */
  public async validateAsync(
    hb: HeartbeatPayload,
    secret: string,
    now: Date = this.clock.now(),
    repository?: IAttendanceRepository,
  ): Promise<HeartbeatValidationResult> {
    if (!repository) {
      return this.validate(hb, secret, now);
    }

    // 1. Privacy check
    const raw = hb as Record<string, unknown>;
    if ('keystrokes' in raw || 'screenshots' in raw || 'urls' in raw || 'appName' in raw) {
      return {
        valid: false,
        reason: 'Privacy violation: Heartbeat must contain counters only (FR-ATT-004)',
      };
    }

    // 2. Interval bounds validation
    if (hb.activeSeconds < 0 || hb.idleSeconds < 0) {
      return { valid: false, reason: 'Invalid counter values: cannot be negative' };
    }
    if (hb.activeSeconds + hb.idleSeconds > 35) {
      return {
        valid: false,
        reason: `Invalid counter total: ${hb.activeSeconds + hb.idleSeconds}s exceeds interval threshold`,
      };
    }

    // 3. Monotonic sequence check from PostgreSQL
    const lastSeq = await repository.getLastDeviceSequence(hb.orgId, hb.userId, hb.deviceId);
    if (hb.sequenceNumber <= lastSeq) {
      return {
        valid: false,
        reason: `Sequence violation: sequence ${hb.sequenceNumber} <= last seen ${lastSeq}`,
      };
    }

    // 4. Nonce replay check from PostgreSQL
    const hasNonce = await repository.hasNonce(hb.orgId, hb.userId, hb.nonce);
    if (hasNonce) {
      return { valid: false, reason: `Replay attack detected: nonce ${hb.nonce} already used` };
    }

    // 5. Cryptographic signature check
    const expectedSig = this.signHeartbeat(hb, secret);
    const expectedBuffer = Buffer.from(expectedSig, 'hex');
    const providedBuffer = Buffer.from(hb.signature || '', 'hex');

    if (
      expectedBuffer.length !== providedBuffer.length ||
      !timingSafeEqual(expectedBuffer, providedBuffer)
    ) {
      return { valid: false, reason: 'Invalid HMAC signature: payload tampered or unauthorized' };
    }

    // Passed all checks! Record in PostgreSQL
    await repository.recordNonce(hb.orgId, hb.userId, hb.nonce, now);
    await repository.setDeviceSequence(hb.orgId, hb.userId, hb.deviceId, hb.sequenceNumber);

    return { valid: true };
  }

  private cleanExpiredNonces(currentTimeMs: number): void {
    for (const [nonce, timestamp] of this.seenNonces.entries()) {
      if (currentTimeMs - timestamp > this.nonceTtlMs) {
        this.seenNonces.delete(nonce);
      }
    }
  }

  public reset(): void {
    this.seenNonces.clear();
    this.deviceSequences.clear();
  }
}
