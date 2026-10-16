/**
 * Desktop agent API (SRS 5.5 FR-ATT-011, FR-ATT-012; ADR 018).
 * Pairing: the signed-in web user creates a short code; the agent exchanges it (with the user's
 * explicit consent) for its own device-bound session. Offline sync never carries wall-clock times.
 */
import { z } from 'zod';

export const AGENT_PLATFORMS = ['WINDOWS', 'MACOS', 'LINUX', 'OTHER'] as const;
export type AgentPlatform = (typeof AGENT_PLATFORMS)[number];

/** Unambiguous alphabet (no 0/O, 1/I/L); 8 characters shown as XXXX-XXXX (~39 bits). */
export const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-?[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;
export const PAIRING_TTL_SECONDS = 300;

export const PairingCodeSchema = z.object({ code: z.string(), expiresAt: z.string() });
export type PairingCode = z.infer<typeof PairingCodeSchema>;

export const PairDtoSchema = z
  .object({
    code: z.string().trim().toUpperCase().regex(PAIRING_CODE_PATTERN, 'Enter the 8-character code from the web app'),
    deviceName: z.string().trim().min(1).max(100),
    platform: z.enum(AGENT_PLATFORMS),
    agentVersion: z.string().trim().min(1).max(40),
    /** The agent's consent screen (FR-ATT-011): the notice version the user accepted. */
    consentNoticeVersion: z.string().trim().min(1).max(20),
  })
  .strict();
export type PairDto = z.input<typeof PairDtoSchema>;

/** What the agent keeps (refresh token in the OS keychain via Electron safeStorage). */
export const AgentSessionSchema = z.object({
  deviceId: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
  sessionId: z.string(),
  sessionSecret: z.string(),
  user: z.object({ id: z.string(), orgId: z.string(), email: z.string(), displayName: z.string().nullable() }),
});
export type AgentSession = z.infer<typeof AgentSessionSchema>;

export const AgentTokenDtoSchema = z.object({ deviceId: z.string().uuid(), refreshToken: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type AgentTokenDto = z.infer<typeof AgentTokenDtoSchema>;

export const AgentDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.enum(AGENT_PLATFORMS),
  agentVersion: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type AgentDevice = z.infer<typeof AgentDeviceSchema>;
export const AgentDeviceListSchema = z.object({ items: z.array(AgentDeviceSchema) });

/**
 * Sent back with every agent heartbeat acknowledgement: the server's time and an HMAC over
 * org, user, device and that time. Offline intervals are offsets from the last anchor.
 */
export const AnchorSchema = z.object({ serverTimeMs: z.number().int().positive(), signature: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type Anchor = z.infer<typeof AnchorSchema>;

export const OfflineIntervalSchema = z
  .object({
    /** Milliseconds after the anchor on the agent's monotonic clock (not the wall clock). */
    offsetMs: z.number().int().min(0).max(13 * 3600_000),
    activeSeconds: z.number().int().min(0).max(30),
    idleSeconds: z.number().int().min(0).max(30),
  })
  .strict();
export type OfflineInterval = z.infer<typeof OfflineIntervalSchema>;

export const OfflineSyncDtoSchema = z
  .object({
    batchId: z.string().uuid(),
    anchor: AnchorSchema,
    intervals: z.array(OfflineIntervalSchema).min(1).max(1440),
  })
  .strict();
export type OfflineSyncDto = z.infer<typeof OfflineSyncDtoSchema>;

export const OfflineSyncResultSchema = z.object({
  batchId: z.string(),
  accepted: z.number().int(),
  rejected: z.record(z.string(), z.number().int()),
  sessionIds: z.array(z.string()),
  /** true when this batch had been applied before (idempotent retry). */
  duplicate: z.boolean(),
});
export type OfflineSyncResult = z.infer<typeof OfflineSyncResultSchema>;
