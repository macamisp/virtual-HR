/**
 * Virtual office REST and Socket.IO contract (SRS 8.4, ADR 015).
 */
import { z } from 'zod';
import { ACCESS_MODES, OfficeDefinitionSchema, ROOM_TYPES } from './map.ts';

// ---------------------------------------------------------------- presence (FR-VO-003)

export const VO_STATUSES = ['ACTIVE', 'IDLE', 'IN_MEETING', 'ON_BREAK', 'AWAY', 'DND', 'OFFLINE'] as const;
export type VoStatus = (typeof VO_STATUSES)[number];
export const MANUAL_STATUSES = ['AUTO', 'AWAY', 'DND'] as const;
export type ManualStatus = (typeof MANUAL_STATUSES)[number];

export const VO_STATUS_LABEL: Record<VoStatus, string> = {
  ACTIVE: 'Active', IDLE: 'Idle', IN_MEETING: 'In meeting', ON_BREAK: 'On break', AWAY: 'Away', DND: 'Do not disturb', OFFLINE: 'Offline',
};

/**
 * The status shown on an avatar. The attendance engine is the source of truth for Active, Idle,
 * Break and Offline; Away and Do-not-disturb are the user's own choice and win over Active/Idle.
 */
export function displayStatus(attendanceState: string | null, manual: ManualStatus, online: boolean): VoStatus {
  if (!online) return 'OFFLINE';
  if (manual === 'DND') return 'DND';
  switch (attendanceState) {
    case 'ON_BREAK': return 'ON_BREAK';
    case 'IN_MEETING': return 'IN_MEETING';
    case 'OFFLINE': return manual === 'AWAY' ? 'AWAY' : 'OFFLINE';
    case 'PAUSED':
    case 'DISCONNECTED': return 'AWAY';
    case 'IDLE': return manual === 'AWAY' ? 'AWAY' : 'IDLE';
    default: return manual === 'AWAY' ? 'AWAY' : 'ACTIVE';
  }
}

// ---------------------------------------------------------------- REST


export const RoomSchema = z.object({
  id: z.string(),
  floorId: z.string(),
  name: z.string(),
  type: z.enum(ROOM_TYPES),
  capacity: z.number().int(),
  accessMode: z.enum(ACCESS_MODES),
  bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  /** May the viewer enter without asking (open room, invited, password already given, or admin). */
  canEnter: z.boolean(),
  occupants: z.number().int(),
});
export type Room = z.infer<typeof RoomSchema>;

export const DeskSchema = z.object({
  id: z.string(),
  floorId: z.string(),
  label: z.string(),
  bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  assignee: z.object({ id: z.string(), displayName: z.string().nullable() }).nullable(),
});
export type Desk = z.infer<typeof DeskSchema>;

export const OfficeSnapshotSchema = z.object({
  office: z.object({ id: z.string(), name: z.string(), proximityRadius: z.number().int(), version: z.number().int() }),
  floors: z.array(z.object({ id: z.string(), name: z.string(), map: z.unknown() })),
  rooms: z.array(RoomSchema),
  desks: z.array(DeskSchema),
  me: z.object({ id: z.string(), deskId: z.string().nullable(), manualStatus: z.enum(MANUAL_STATUSES), statusMessage: z.string() }),
  canManage: z.boolean(),
});
export type OfficeSnapshot = z.infer<typeof OfficeSnapshotSchema>;

export const PersonSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  email: z.string(),
  role: z.string(),
  teamName: z.string().nullable(),
  online: z.boolean(),
  status: z.enum(VO_STATUSES),
  statusMessage: z.string(),
  floorId: z.string().nullable(),
  roomId: z.string().nullable(),
  roomName: z.string().nullable(),
  deskLabel: z.string().nullable(),
});
export type Person = z.infer<typeof PersonSchema>;
export const PeopleListSchema = z.object({ items: z.array(PersonSchema) });

export const PeopleQuerySchema = z.object({ q: z.string().trim().max(100).optional(), onlineOnly: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') });
export type PeopleQuery = z.infer<typeof PeopleQuerySchema>;

export const StatusDtoSchema = z.object({ status: z.enum(MANUAL_STATUSES), message: z.string().trim().max(100).default('') }).strict();
export type StatusDto = z.input<typeof StatusDtoSchema>;

export const DeskAssignDtoSchema = z.object({ userId: z.string().uuid().nullable() }).strict();
export type DeskAssignDto = z.infer<typeof DeskAssignDtoSchema>;

export const RoomUpdateDtoSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    capacity: z.number().int().min(1).max(500).optional(),
    accessMode: z.enum(ACCESS_MODES).optional(),
    /** Required when switching to PASSWORD; null clears it. Never returned. */
    password: z.string().min(6).max(128).nullable().optional(),
  })
  .strict();
export type RoomUpdateDto = z.infer<typeof RoomUpdateDtoSchema>;

export const RoomInvitesDtoSchema = z.object({ userIds: z.array(z.string().uuid()).max(500) }).strict();
export type RoomInvitesDto = z.infer<typeof RoomInvitesDtoSchema>;
export const RoomInvitesSchema = z.object({ userIds: z.array(z.string()) });

export const OfficeMapDtoSchema = OfficeDefinitionSchema;

// ---------------------------------------------------------------- Socket.IO

export const JoinDtoSchema = z.object({
  /** false = list view: presence and rooms only, no position stream (FR-VO-012). */
  positions: z.boolean().default(true),
  floorId: z.string().max(32).optional(),
});
export const MoveDtoSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  dir: z.number().int().min(0).max(7).default(0),
  /** Client clock, echoed to observers for latency measurement only (never authoritative). */
  ct: z.number().finite().optional(),
});
export type MoveDto = z.input<typeof MoveDtoSchema>;
export const TeleportDtoSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('desk') }),
  z.object({ kind: z.literal('user'), userId: z.string().uuid() }),
  z.object({ kind: z.literal('room'), roomId: z.string().uuid(), password: z.string().max(128).optional() }),
  z.object({ kind: z.literal('floor'), floorId: z.string().max(32) }),
]);
export type TeleportDto = z.infer<typeof TeleportDtoSchema>;
export const RoomKnockDtoSchema = z.object({ roomId: z.string().uuid() });
export const RoomAnswerDtoSchema = z.object({ roomId: z.string().uuid(), userId: z.string().uuid(), admit: z.boolean() });
export const ModeDtoSchema = z.object({ roomOnly: z.boolean() });

/**
 * One avatar in office:positions, as a tuple to keep the 10 Hz stream small:
 * [userId, x, y, direction 0..7, status, roomId | null, echo of the mover's client clock | null].
 */
export type PositionEntry = [string, number, number, number, VoStatus, string | null, number | null];

export interface PositionsMessage {
  /** Server time (ms). */
  st: number;
  floorId: string;
  /** Avatars that entered the neighbourhood or changed since the last message. */
  u: PositionEntry[];
  /** Ids that left the neighbourhood (or the floor / office). */
  gone: string[];
}

export interface ProximityMessage {
  /** Stable group id, or null when alone. */
  groupId: string | null;
  members: string[];
}

export interface RosterEntry {
  id: string;
  name: string;
  status: VoStatus;
  statusMessage: string;
  floorId: string | null;
  roomId: string | null;
}

export type MoveAck = { ok: true } | { ok: false; reason: string; x: number; y: number; floorId: string };
export type JoinAck =
  | { ok: true; self: { x: number; y: number; floorId: string; roomId: string | null }; roster: RosterEntry[] }
  | { ok: false; error: string };
export type TeleportAck = { ok: true; x: number; y: number; floorId: string; roomId: string | null } | { ok: false; error: string; code?: 'KNOCK' | 'INVITE' | 'PASSWORD' | 'FULL' | 'NOT_FOUND' | 'BAD_PASSWORD' | 'RATE_LIMITED' };
