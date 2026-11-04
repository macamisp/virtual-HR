import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { OfficeRegistry } from '../office/office-registry.ts';
import { isClosedRoom } from '../../../../packages/shared/src/office/index.ts';
import { Permission, userCan } from '../../../../packages/shared/src/auth/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import type { MediaToken } from '../../../../packages/shared/src/meetings/types.ts';
import { accessToken, liveKitConfig, orgOfRoomName, parseEgressInfo, roomNames } from './livekit.ts';
import { RecordingsService } from '../meetings/recordings.service.ts';
import type { VideoGrant } from './livekit.ts';

const PUBLISH: VideoGrant['canPublishSources'] = ['camera', 'microphone', 'screen_share', 'screen_share_audio'];

export interface WebhookEvent {
  event: string;
  id?: string;
  room?: { name?: string; sid?: string };
  participant?: { identity?: string; sid?: string };
  egressInfo?: unknown;
}

/**
 * FR-VO-005, FR-MEET-002, 009 (ADR 016). Tokens are issued for exactly one LiveKit room that the
 * server chooses from the caller's state; the client never names a room:
 *   room       the office room the avatar is standing in right now (meeting/private rooms only)
 *   proximity  the user's current proximity group in the open area
 *   meeting    via MeetingsService, after the lobby
 * Join and leave times come from LiveKit webhooks, stamped with the API server's clock.
 */
@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: OfficeRegistry,
    private readonly recordings: RecordingsService,
  ) {}

  private sign(user: AuthenticatedUser, name: string, room: string, label: string, canModerate: boolean, meetingId: string | null): MediaToken {
    const cfg = liveKitConfig();
    const { token, expiresAt } = accessToken(cfg, user.id, name, { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: PUBLISH, canUpdateOwnMetadata: false });
    return { url: cfg.url, token, roomName: room, canPublish: true, canModerate, expiresAt: expiresAt.toISOString(), label, meetingId };
  }

  private async displayName(user: AuthenticatedUser): Promise<string> {
    const r = await this.prisma.runWithTenantContext(user.orgId, (db) => db.query<{ display_name: string | null; email: string }>(`SELECT display_name, email FROM users WHERE id = $1`, [user.id]));
    return r.rows[0]?.display_name ?? r.rows[0]?.email ?? 'Someone';
  }

  /** FR-MEET-002: walking into a room joins its session; a user not inside gets nothing. */
  async roomToken(user: AuthenticatedUser): Promise<MediaToken> {
    const world = this.registry.peek(user.orgId);
    const a = world?.avatars.get(user.id);
    if (!world || !a) throw new ConflictException('Enter the office first');
    const room = a.roomId ? world.rooms.find((r) => r.id === a.roomId) : null;
    if (!room) throw new ForbiddenException('You are not in a room');
    if (!isClosedRoom(room)) throw new ConflictException('Open areas use proximity audio');
    // The avatar is inside, which the server only allows when entry was permitted; re-check anyway.
    if (world.mayEnter(user.id, room, a.isAdmin, true)) throw new ForbiddenException('You may not join this room');
    const lk = await this.prisma.runWithTenantContext(user.orgId, (db) => db.query<{ livekit_room_name: string }>(`SELECT livekit_room_name FROM rooms WHERE id = $1`, [room.id]));
    if (!lk.rows[0]) throw new NotFoundException('Room not found');
    return this.sign(user, a.name, lk.rows[0].livekit_room_name, room.name, userCan(user, Permission.ORG_MANAGE), null);
  }

  /** FR-VO-005: only for the group the server put you in; anyone else's conversation stays closed. */
  async proximityToken(user: AuthenticatedUser): Promise<MediaToken> {
    const world = this.registry.peek(user.orgId);
    const a = world?.avatars.get(user.id);
    if (!world || !a) throw new ConflictException('Enter the office first');
    const g = world.groupByUser.get(user.id);
    if (!g || g.id.startsWith('room:') || g.members.length < 2) throw new ConflictException('Nobody is near you');
    return this.sign(user, a.name, roomNames.proximity(user.orgId, g.id), 'Nearby', false, null);
  }

  /** Used by MeetingsService once the caller may join (attendee, host or admitted from the lobby). */
  async meetingToken(user: AuthenticatedUser, meeting: { id: string; title: string; livekitRoomName: string }, canModerate: boolean): Promise<MediaToken> {
    return this.sign(user, await this.displayName(user), meeting.livekitRoomName, meeting.title, canModerate, meeting.id);
  }

  // ---------------------------------------------------------------- webhooks (FR-MEET-009)

  async handleWebhook(e: WebhookEvent): Promise<void> {
    // FR-MEET-007 (ADR 024): Egress reports on recordings; the room name carries the organisation.
    if (e.event.startsWith('egress_')) {
      const info = parseEgressInfo(e.egressInfo);
      const owner = info ? orgOfRoomName(info.roomName) : null;
      if (!info || owner?.kind !== 'meeting') return;
      const done = await this.prisma.runWithTenantContext(owner.orgId, (db) => this.recordings.onEgress(db, owner.orgId, info));
      if (done) await this.recordings.afterEgress(owner.orgId, done);
      return;
    }
    const roomName = e.room?.name;
    if (!roomName) return;
    const owner = orgOfRoomName(roomName);
    if (!owner || owner.kind === 'proximity') return; // proximity talk is credited through inCall only
    const userId = e.participant?.identity;
    const sid = e.participant?.sid;
    let joined: string | null = null;
    await this.prisma.runWithTenantContext(owner.orgId, async (db) => {
      const meetingId = owner.kind === 'office'
        ? await this.liveRoomMeeting(db, owner.orgId, roomName, e.event === 'participant_joined' ? userId : undefined)
        : (await db.query<{ id: string }>(`SELECT id FROM meetings WHERE livekit_room_name = $1`, [roomName])).rows[0]?.id ?? null;
      if (!meetingId) return;
      if (e.event === 'participant_joined' && userId && sid) {
        const ok = await db.query(`SELECT 1 FROM users WHERE id = $1`, [isUuid(userId) ? userId : '00000000-0000-0000-0000-000000000000']);
        if (!ok.rows[0]) return;
        await db.query(`UPDATE meetings SET status = 'LIVE', started_at = COALESCE(started_at, now()), ended_at = NULL, updated_at = now() WHERE id = $1 AND status IN ('SCHEDULED', 'LIVE')`, [meetingId]);
        await db.query(
          `INSERT INTO meeting_participants (org_id, meeting_id, user_id, livekit_sid, joined_at) VALUES ($1, $2, $3, $4, now()) ON CONFLICT (meeting_id, livekit_sid) DO NOTHING`,
          [owner.orgId, meetingId, userId, sid],
        );
        if (owner.kind === 'meeting') joined = meetingId;
      } else if (e.event === 'participant_left' && sid) {
        await db.query(
          `UPDATE meeting_participants SET left_at = now(), duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (now() - joined_at)))::int
           WHERE meeting_id = $1 AND livekit_sid = $2 AND left_at IS NULL`,
          [meetingId, sid],
        );
      } else if (e.event === 'room_finished') {
        await db.query(
          `UPDATE meeting_participants SET left_at = now(), duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (now() - joined_at)))::int WHERE meeting_id = $1 AND left_at IS NULL`,
          [meetingId],
        );
        // A recurring meeting goes back to SCHEDULED for its next occurrence; its history stays.
        await db.query(
          `UPDATE meetings SET status = CASE WHEN recurrence_rule IS NOT NULL AND type = 'SCHEDULED' THEN 'SCHEDULED' ELSE 'ENDED' END,
             ended_at = now(), updated_at = now() WHERE id = $1 AND status = 'LIVE'`,
          [meetingId],
        );
      }
    });
    // Someone in the call who has not agreed to a running recording is removed (ADR 024).
    if (joined && userId) await this.recordings.enforceOnJoin(owner.orgId, joined, userId, roomName);
  }

  /** The live ROOM meeting of an office room, created on the first join. */
  private async liveRoomMeeting(db: pg.PoolClient, orgId: string, roomName: string, firstUser: string | undefined): Promise<string | null> {
    const room = (await db.query<{ id: string; name: string }>(`SELECT id, name FROM rooms WHERE livekit_room_name = $1`, [roomName])).rows[0];
    if (!room) return null;
    const live = await db.query<{ id: string }>(`SELECT id FROM meetings WHERE room_id = $1 AND type = 'ROOM' AND status = 'LIVE'`, [room.id]);
    if (live.rows[0]) return live.rows[0].id;
    if (!firstUser || !isUuid(firstUser)) return null;
    const host = await db.query(`SELECT 1 FROM users WHERE id = $1`, [firstUser]);
    if (!host.rows[0]) return null;
    // Each room session is its own meeting row; the LiveKit room name is unique per meeting row,
    // so a session gets a suffix while the office room keeps its stable name.
    const created = await db.query<{ id: string }>(
      `INSERT INTO meetings (org_id, type, status, title, host_id, room_id, started_at, lobby, livekit_room_name)
       VALUES ($1, 'ROOM', 'LIVE', $2, $3, $4, now(), false, $5 || '#' || to_char(now(), 'YYYYMMDDHH24MISSMS'))
       ON CONFLICT DO NOTHING RETURNING id`,
      [orgId, room.name, firstUser, room.id, roomName],
    );
    if (created.rows[0]) return created.rows[0].id;
    return (await db.query<{ id: string }>(`SELECT id FROM meetings WHERE room_id = $1 AND type = 'ROOM' AND status = 'LIVE'`, [room.id])).rows[0]?.id ?? null;
  }
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
