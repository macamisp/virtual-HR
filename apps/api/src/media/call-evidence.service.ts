import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.ts';
import { OfficeRegistry } from '../office/office-registry.ts';
import { AttendanceService } from '../attendance/attendance.service.ts';
import type { CallEvidence } from '../attendance/call-evidence.ts';
import type { CallKind } from '../../../../packages/shared/src/attendance/types.ts';
import { isClosedRoom, type RoomType } from '../../../../packages/shared/src/office/index.ts';
import { liveKitConfig, roomService } from './livekit.ts';

/** What the check reads from the office world (the in-memory registry). */
export interface OfficeView {
  avatars: ReadonlyMap<string, { roomId: string | null }>;
  rooms: ReadonlyArray<{ id: string; type: RoomType }>;
  groupByUser: ReadonlyMap<string, { id: string; members: string[] }>;
}

export interface CallEvidenceDeps {
  world(orgId: string): OfficeView | null;
  /** The LiveKit room of a meeting in this organisation that has not ended or been cancelled. */
  meetingRoom(orgId: string, meetingId: string): Promise<string | null>;
  /** Identities connected to a LiveKit room. Throws when LiveKit cannot be reached. */
  participants(roomName: string): Promise<string[]>;
  now(): number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One LiveKit question per room per 30 s at most, however many people in it send heartbeats. */
export const PARTICIPANTS_TTL_MS = 30_000;
/** When LiveKit cannot be reached, the last answer stands this long, then the call is not counted. */
export const PARTICIPANTS_GRACE_MS = 90_000;

/**
 * ADR 049 §1b (FR-WT-001, FR-WT-002). A call counts as meeting time only when the server can see
 * at least one other person in it:
 *   - office room: another avatar in the same closed room (registry, in memory);
 *   - proximity: the server-computed group has two or more members (in memory);
 *   - meeting: LiveKit lists this person and someone else in the meeting's room (cached 30 s).
 * The client never names an office room; a meeting id it names is checked against this
 * organisation's meetings and against who LiveKit says is connected.
 */
export class ServerCallEvidence implements CallEvidence {
  private readonly cache = new Map<string, { at: number; ok: boolean; identities: Set<string> }>();
  private readonly inflight = new Map<string, Promise<Set<string> | null>>();

  constructor(private readonly deps: CallEvidenceDeps) {}

  async verify(q: { orgId: string; userId: string; meetingId: string | null }): Promise<CallKind | null> {
    if (q.meetingId) return (await this.inMeeting(q.orgId, q.userId, q.meetingId)) ? 'MEETING' : null;
    const world = this.deps.world(q.orgId);
    const me = world?.avatars.get(q.userId);
    if (!world || !me) return null;
    const room = me.roomId ? world.rooms.find((r) => r.id === me.roomId) : undefined;
    if (room && isClosedRoom(room)) {
      for (const [id, a] of world.avatars) if (id !== q.userId && a.roomId === room.id) return 'ROOM';
      return null; // alone in the room
    }
    const g = world.groupByUser.get(q.userId);
    return g && !g.id.startsWith('room:') && g.members.length >= 2 && g.members.includes(q.userId) ? 'PROXIMITY' : null;
  }

  private async inMeeting(orgId: string, userId: string, meetingId: string): Promise<boolean> {
    if (!UUID.test(meetingId)) return false;
    const room = await this.deps.meetingRoom(orgId, meetingId);
    if (!room) return false;
    const ids = await this.connected(room);
    if (!ids || !ids.has(userId)) return false;
    for (const id of ids) if (id !== userId) return true;
    return false;
  }

  private async connected(room: string): Promise<Set<string> | null> {
    const now = this.deps.now();
    const hit = this.cache.get(room);
    if (hit && hit.ok && now - hit.at < PARTICIPANTS_TTL_MS) return hit.identities;
    const running = this.inflight.get(room);
    if (running) return running;
    const p = (async () => {
      try {
        const identities = new Set(await this.deps.participants(room));
        this.cache.set(room, { at: now, ok: true, identities });
        return identities;
      } catch {
        // Fail closed after the grace period; never longer than that on a stale answer.
        return hit && now - hit.at < PARTICIPANTS_GRACE_MS ? hit.identities : null;
      } finally {
        this.inflight.delete(room);
      }
    })();
    this.inflight.set(room, p);
    if (this.cache.size > 1000) for (const [k, v] of this.cache) if (now - v.at > PARTICIPANTS_GRACE_MS) this.cache.delete(k);
    return p;
  }
}

/** Registers the server's call check with attendance (ADR 049 §1b). */
@Injectable()
export class CallEvidenceRegistrar implements OnModuleInit {
  private readonly log = new Logger('CallEvidence');

  constructor(
    private readonly attendance: AttendanceService,
    private readonly registry: OfficeRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.attendance.setCallEvidence(new ServerCallEvidence({
      world: (orgId) => this.registry.peek(orgId),
      meetingRoom: async (orgId, meetingId) => {
        const r = await this.prisma.runWithTenantContext(orgId, (db) => db.query<{ livekit_room_name: string }>(
          `SELECT livekit_room_name FROM meetings WHERE id = $1 AND status NOT IN ('ENDED', 'CANCELLED')`, [meetingId]));
        return r.rows[0]?.livekit_room_name ?? null;
      },
      participants: async (room) => {
        try {
          const res = await roomService<{ participants?: Array<{ identity?: string }> }>(liveKitConfig(), 'ListParticipants', room, {});
          return (res.participants ?? []).map((p) => p.identity ?? '').filter(Boolean);
        } catch (err) {
          this.log.warn(`LiveKit participant check failed: ${err instanceof Error ? err.message : 'unknown error'}`);
          throw err;
        }
      },
      now: () => Date.now(),
    }));
  }
}
