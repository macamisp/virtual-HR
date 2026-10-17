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
  roomRecord?: boolean;
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

/** Where Egress uploads the plaintext MP4 (a staging prefix only; the API encrypts it afterwards). */
export interface EgressS3 {
  accessKey: string;
  secret: string;
  region: string;
  endpoint?: string;
  bucket: string;
  forcePathStyle: boolean;
}

/** LiveKit EgressInfo as JSON: Twirp answers with proto names, webhooks with camelCase. Both are read. */
export interface LkEgressInfo {
  egressId: string;
  roomName: string;
  status: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  file?: { filename: string; size: number; durationSeconds: number; location?: string };
}

const pick = <T>(o: Record<string, unknown>, a: string, b: string): T | undefined => (o[a] ?? o[b]) as T | undefined;
const STATUS_NAMES = ['EGRESS_STARTING', 'EGRESS_ACTIVE', 'EGRESS_ENDING', 'EGRESS_COMPLETE', 'EGRESS_FAILED', 'EGRESS_ABORTED', 'EGRESS_LIMIT_REACHED'];
/** int64 times arrive as numbers or strings, in nanoseconds. */
const nanos = (v: unknown): number | undefined => (v === undefined || v === null || v === '' || v === '0' || v === 0 ? undefined : Number(BigInt(String(v)) / 1_000_000n));

export function parseEgressInfo(raw: unknown): LkEgressInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const egressId = pick<string>(o, 'egress_id', 'egressId');
  if (!egressId) return null;
  const st = pick<string | number>(o, 'status', 'status');
  const files = (pick<Array<Record<string, unknown>>>(o, 'file_results', 'fileResults') ?? []);
  const legacy = pick<Record<string, unknown>>(o, 'file', 'file');
  const f = files[0] ?? legacy;
  return {
    egressId,
    roomName: pick<string>(o, 'room_name', 'roomName') ?? '',
    status: typeof st === 'number' ? STATUS_NAMES[st] ?? 'UNKNOWN' : st ?? 'EGRESS_STARTING',
    error: pick<string>(o, 'error', 'error') || undefined,
    startedAt: nanos(pick(o, 'started_at', 'startedAt')),
    endedAt: nanos(pick(o, 'ended_at', 'endedAt')),
    file: f ? {
      filename: String(f.filename ?? ''),
      size: Number(f.size ?? 0),
      durationSeconds: Math.round(Number(BigInt(String(f.duration ?? 0)) / 1_000_000n) / 1000),
      location: f.location ? String(f.location) : undefined,
    } : undefined,
  };
}

/** Twirp call to the LiveKit Egress service (needs a token with roomRecord). */
async function egressService(cfg: LiveKitConfig, method: 'StartRoomCompositeEgress' | 'StopEgress', room: string, body: Record<string, unknown>): Promise<LkEgressInfo> {
  const { token } = accessToken(cfg, 'hrvo-api', 'HR Virtual Office', { room, roomRecord: true }, 60);
  const res = await fetch(`${cfg.httpUrl}/twirp/livekit.Egress/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  // Never echo the body: a failed start request may be about the upload credentials.
  if (!res.ok) throw new Error(`LiveKit ${method} failed (${res.status})`);
  const info = parseEgressInfo(await res.json());
  if (!info) throw new Error(`LiveKit ${method} returned no egress`);
  return info;
}

/** Composite (grid) recording of a room into one MP4 at `filepath` in the staging bucket. */
export async function startRoomRecording(cfg: LiveKitConfig, room: string, filepath: string, s3: EgressS3): Promise<LkEgressInfo> {
  return await egressService(cfg, 'StartRoomCompositeEgress', room, {
    room_name: room,
    layout: 'grid',
    file_outputs: [{
      file_type: 'MP4',
      filepath,
      disable_manifest: true,
      s3: { access_key: s3.accessKey, secret: s3.secret, region: s3.region, endpoint: s3.endpoint ?? '', bucket: s3.bucket, force_path_style: s3.forcePathStyle },
    }],
  });
}

export async function stopRecording(cfg: LiveKitConfig, room: string, egressId: string): Promise<LkEgressInfo> {
  return await egressService(cfg, 'StopEgress', room, { egress_id: egressId });
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
