/**
 * Heartbeat signing shared by the browser client and the Node validator (FR-ATT-004, FR-ATT-017).
 *
 * The canonical string is the single definition used by both sides. Signing uses the
 * WebCrypto API (globalThis.crypto.subtle), which exists in browsers and Node >= 19,
 * so this module has no Node-only imports and can be bundled into apps/web.
 *
 * Key material: the UTF-8 bytes of the per-session secret string issued at login,
 * matching Node's createHmac('sha256', secret).
 */
import type { HeartbeatPayload } from './types.ts';

export type UnsignedHeartbeat = Omit<HeartbeatPayload, 'signature'>;

export function heartbeatCanonicalString(hb: UnsignedHeartbeat): string {
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

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** HMAC-SHA256 over the canonical string, hex-encoded. */
export async function signHeartbeatWebCrypto(
  hb: UnsignedHeartbeat,
  sessionSecret: string,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await subtle.importKey(
    'raw',
    encoder.encode(sessionSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await subtle.sign('HMAC', key, encoder.encode(heartbeatCanonicalString(hb)));
  return toHex(signature);
}

/** Convenience for clients: returns the payload with its signature attached. */
export async function signHeartbeatPayload(
  hb: UnsignedHeartbeat,
  sessionSecret: string,
  subtle?: SubtleCrypto,
): Promise<HeartbeatPayload> {
  return { ...hb, signature: await signHeartbeatWebCrypto(hb, sessionSecret, subtle) };
}
