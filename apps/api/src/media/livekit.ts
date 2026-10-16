/**
 * LiveKit without the server SDK (ADR 016): access tokens and webhook verification are HS256 JWTs
 * (jsonwebtoken, already used for auth), the room service is Twirp JSON over HTTP.
 * Secrets are never logged.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { isProduction } from '../common/config.ts';

const DEV_SECRET = 'hrvo-dev-secret-change-me-0123456789abcdef'; // gitleaks:allow (local dev key, refused in production)

export interface LiveKitConfig {
  url: string;
  httpUrl: string;
  apiKey: string;
  apiSecret: string;
}

export function liveKitConfig(): LiveKitConfig {
  const apiKey = process.env.LIVEKIT_API_KEY || 'hrvo-dev';
  const apiSecret = process.env.LIVEKIT_API_SECRET || DEV_SECRET;
  if (isProduction() && (apiSecret === DEV_SECRET || apiSecret.length < 32)) {
    throw new Error('LIVEKIT_API_SECRET must be set to a unique value of at least 32 characters in production');
  }
  const url = process.env.LIVEKIT_URL || 'ws://localhost:7880';
  return { url, httpUrl: process.env.LIVEKIT_HTTP_URL || url.replace(/^ws/, 'http'), apiKey, apiSecret };
}

export const TOKEN_TTL_SECONDS = 10 * 60;

export interface VideoGrant {
  room: string;
  roomJoin?: boolean;
  roomAdmin?: boolean;
  roomList?: boolean;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  canPublishSources?: Array<'camera' | 'microphone' | 'screen_share' | 'screen_share_audio'>;
  canUpdateOwnMetadata?: boolean;
  hidden?: boolean;
}

/** A participant token: identity = user id, short-lived, scoped to exactly one room. */
export function accessToken(cfg: LiveKitConfig, identity: string, name: string, grant: VideoGrant, ttlSeconds = TOKEN_TTL_SECONDS): { token: string; expiresAt: Date } {
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    { video: grant, name, sub: identity, jti: `${identity}-${now}-${Math.random().toString(36).slice(2, 8)}` },
    cfg.apiSecret,
    { algorithm: 'HS256', issuer: cfg.apiKey, notBefore: 0, expiresIn: ttlSeconds },
  );
  return { token, expiresAt: new Date((now + ttlSeconds) * 1000) };
}

/** LiveKit signs webhooks with a JWT whose `sha256` claim is the base64 SHA-256 of the raw body. */
export function verifyWebhook(cfg: LiveKitConfig, authorization: string | undefined, rawBody: Buffer): boolean {
  if (!authorization) return false;
  const token = authorization.replace(/^Bearer\s+/i, '');
  let claims: { sha256?: string; iss?: string };
  try {
    claims = jwt.verify(token, cfg.apiSecret, { algorithms: ['HS256'], issuer: cfg.apiKey }) as typeof claims;
  } catch {
    return false;
  }
  if (typeof claims.sha256 !== 'string') return false;
  const expected = createHash('sha256').update(rawBody).digest();
  let given: Buffer;
  try { given = Buffer.from(claims.sha256, 'base64'); } catch { return false; }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Test helper and documentation of the format: how LiveKit signs a webhook body. */
export function signWebhook(cfg: LiveKitConfig, rawBody: string): string {
  const sha256 = createHash('sha256').update(rawBody).digest('base64');
  return jwt.sign({ sha256 }, cfg.apiSecret, { algorithm: 'HS256', issuer: cfg.apiKey, expiresIn: 300 });
}

/** Twirp call to the LiveKit RoomService with a short admin token for one room. */
export async function roomService<T>(cfg: LiveKitConfig, method: 'ListParticipants' | 'MutePublishedTrack' | 'RemoveParticipant' | 'DeleteRoom' | 'UpdateParticipant', room: string, body: Record<string, unknown>): Promise<T> {
  const { token } = accessToken(cfg, 'hrvo-api', 'HR Virtual Office', { room, roomAdmin: true, roomList: true }, 60);
  const res = await fetch(`${cfg.httpUrl}/twirp/livekit.RoomService/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ room, ...body }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`LiveKit ${method} failed (${res.status})`);
  return (await res.json()) as T;
}

export interface LkParticipant {
  sid: string;
  identity: string;
  tracks?: Array<{ sid: string; type?: string | number; source?: string | number; muted?: boolean }>;
}

/** Room names carry the organisation so a webhook can be attributed before any tenant context. */
export const roomNames = {
  proximity: (orgId: string, groupId: string) => `prox-${orgId}-${groupId.replace(/[^a-zA-Z0-9-]/g, '')}`,
  meeting: (orgId: string, meetingId: string) => `meet-${orgId}-${meetingId}`,
};

export function orgOfRoomName(name: string): { kind: 'office' | 'proximity' | 'meeting'; orgId: string } | null {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  let m = new RegExp(`^hrvo-(${uuid})-`).exec(name);
  if (m) return { kind: 'office', orgId: m[1]! };
  m = new RegExp(`^prox-(${uuid})-`).exec(name);
  if (m) return { kind: 'proximity', orgId: m[1]! };
  m = new RegExp(`^meet-(${uuid})-`).exec(name);
  if (m) return { kind: 'meeting', orgId: m[1]! };
  return null;
}
