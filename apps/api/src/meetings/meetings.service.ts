import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { MAIL_TRANSPORT } from '../common/mailer.ts';
import type { MailTransport } from '../common/mailer.ts';
import { AttendanceGateway } from '../attendance/attendance.gateway.ts';
import { TasksService } from '../tasks/tasks.service.ts';
import { Permission, userCan } from '../../../../packages/shared/src/auth/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import type {
  ActionItemDto, AttendeeRole, JoinResult, Meeting, MeetingCreateDto, MeetingStatus, MeetingType, MeetingUpdateDto,
} from '../../../../packages/shared/src/meetings/types.ts';
import { MediaService } from '../media/media.service.ts';
import { liveKitConfig, roomNames, roomService } from '../media/livekit.ts';
import { CallsService } from './calls.service.ts';
import { RecordingsService } from './recordings.service.ts';
import type { LkParticipant } from '../media/livekit.ts';
import { buildIcs, nextOccurrence, rruleOf } from './ics.ts';
import { CreateTaskDtoSchema } from '../../../../packages/shared/src/tasks/types.ts';

interface MeetingRow {
  id: string;
  type: MeetingType;
  status: MeetingStatus;
  title: string;
  agenda: string;
  notes: string;
  host_id: string;
  room_id: string | null;
  scheduled_start: Date | null;
  scheduled_end: Date | null;
  started_at: Date | null;
  ended_at: Date | null;
  recurrence_rule: string | null;
  lobby: boolean;
  livekit_room_name: string;
  ics_sequence: number;
  version: number;
}

type Role = AttendeeRole | 'NONE';
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * FR-MEET-001, 003, 005, 008, 009 (ADR 016). Hosts and co-hosts moderate; invited people go
 * straight in; others wait in the lobby when it is on. Join/leave times come from LiveKit
 * webhooks (MediaService).
 */
@Injectable()
export class MeetingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly gateway: AttendanceGateway,
    private readonly tasks: TasksService,
    @Inject(MAIL_TRANSPORT) private readonly mailer: MailTransport,
    private readonly recordings: RecordingsService,
    private readonly calls: CallsService,
  ) {}

  private webUrl(): string {
    return (process.env.APP_WEB_URL || 'http://localhost:3000').replace(/\/$/, '');
  }

  private async row(db: pg.PoolClient, id: string, lock = false): Promise<MeetingRow> {
    const r = await db.query<MeetingRow>(`SELECT * FROM meetings WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!r.rows[0]) throw new NotFoundException('Meeting not found');
    return r.rows[0];
  }

  private async roleOf(db: pg.PoolClient, m: MeetingRow, userId: string): Promise<Role> {
    if (m.host_id === userId) return 'HOST';
    const a = await db.query<{ role: AttendeeRole }>(`SELECT role FROM meeting_attendees WHERE meeting_id = $1 AND user_id = $2`, [m.id, userId]);
    return a.rows[0]?.role ?? 'NONE';
  }

  /** Who can see a meeting: host, attendees, anyone who took part, admins; others get 404. */
  private async assertVisible(db: pg.PoolClient, user: AuthenticatedUser, m: MeetingRow): Promise<Role> {
    const role = await this.roleOf(db, m, user.id);
    if (role !== 'NONE') return role;
    if (userCan(user, Permission.ORG_MANAGE)) return 'NONE';
    const took = await db.query(`SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2 LIMIT 1`, [m.id, user.id]);
    const waited = await db.query(`SELECT 1 FROM meeting_lobby WHERE meeting_id = $1 AND user_id = $2`, [m.id, user.id]);
    if (took.rows[0] || waited.rows[0] || m.type === 'ROOM') return 'NONE';
    throw new NotFoundException('Meeting not found');
  }

  private moderates(role: Role, user: AuthenticatedUser, m: MeetingRow): boolean {
    return role === 'HOST' || role === 'COHOST' || (m.type === 'ROOM' && userCan(user, Permission.ORG_MANAGE));
  }

  async create(user: AuthenticatedUser, dto: MeetingCreateDto): Promise<Meeting> {
    const id = randomUUID();
    const attendeeIds = [...new Set((dto.attendeeIds ?? []).filter((x) => x !== user.id))];
    const cohosts = new Set((dto.cohostIds ?? []).filter((x) => x !== user.id));
    for (const c of cohosts) if (!attendeeIds.includes(c)) attendeeIds.push(c);
    const scheduled = dto.type === 'SCHEDULED';
    const rrule = scheduled ? rruleOf(dto.recurrence ?? null) : null;
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      if (attendeeIds.length) {
        const found = await db.query<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE'`, [attendeeIds]);
        if (found.rows.length !== attendeeIds.length) throw new NotFoundException('Some attendees were not found');
      }
      await db.query(
        `INSERT INTO meetings (id, org_id, type, status, title, agenda, host_id, scheduled_start, scheduled_end, recurrence_rule, lobby, livekit_room_name)
         VALUES ($1, $2, $3, 'SCHEDULED', $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, user.orgId, dto.type, dto.title, dto.agenda ?? '', user.id, scheduled ? dto.start : null, scheduled ? dto.end : null, rrule, dto.lobby ?? true, roomNames.meeting(user.orgId, id)],
      );
      for (const a of attendeeIds) {
        await db.query(`INSERT INTO meeting_attendees (org_id, meeting_id, user_id, role) VALUES ($1, $2, $3, $4)`, [user.orgId, id, a, cohosts.has(a) ? 'COHOST' : 'ATTENDEE']);
      }
      if (!scheduled) await this.calls.start(db, user, id, attendeeIds);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'MEETING_CREATED', entityType: 'MEETING', entityId: id, after: { type: dto.type, attendees: attendeeIds.length, recurring: !!rrule } });
    });
    if (dto.type === 'INSTANT') {
      // FR-MEET-001: ring the people invited to an instant call.
      await this.calls.announce(user.orgId, id);
    } else if (dto.sendInvites !== false) await this.sendInvites(user, id, 'REQUEST');
    return await this.get(user, id);
  }

  async get(user: AuthenticatedUser, id: string): Promise<Meeting> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const m = await this.row(db, id);
      const role = await this.assertVisible(db, user, m);
      const people = await db.query<{ id: string; display_name: string | null; email: string; role: AttendeeRole; response: 'NEEDS_ACTION' | 'ACCEPTED' | 'DECLINED' }>(
        `SELECT u.id, u.display_name, u.email, a.role, a.response FROM meeting_attendees a JOIN users u ON u.id = a.user_id WHERE a.meeting_id = $1 ORDER BY a.role, COALESCE(u.display_name, u.email)`, [id]);
      const host = (await db.query<{ id: string; display_name: string | null; email: string }>(`SELECT id, display_name, email FROM users WHERE id = $1`, [m.host_id])).rows[0]!;
      const parts = await db.query<{ id: string; display_name: string | null; email: string; joined_at: Date; left_at: Date | null; duration_seconds: number }>(
        `SELECT u.id, u.display_name, u.email, p.joined_at, p.left_at, p.duration_seconds FROM meeting_participants p JOIN users u ON u.id = p.user_id WHERE p.meeting_id = $1 ORDER BY p.joined_at`, [id]);
      const items = await db.query<{ id: string; text: string; assignee_id: string | null; display_name: string | null; email: string | null; due_date: string | null; task_id: string | null; created_at: Date }>(
        `SELECT i.id, i.text, i.assignee_id, u.display_name, u.email, to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.task_id, i.created_at
         FROM meeting_action_items i LEFT JOIN users u ON u.id = i.assignee_id WHERE i.meeting_id = $1 ORDER BY i.created_at`, [id]);
      const ref = (p: { id: string; display_name: string | null; email: string }) => ({ id: p.id, displayName: p.display_name, email: p.email });
      const myRole = role === 'NONE' ? 'NONE' : role;
      const recording = await this.recordings.active(db, user, m.id, role);
      const canRecord = m.type !== 'ROOM' && (role === 'HOST' || role === 'COHOST') && (await this.recordings.enabled(db, user.orgId));
      return {
        id: m.id, type: m.type, status: m.status, title: m.title, agenda: m.agenda, notes: m.notes, host: ref(host), roomId: m.room_id,
        scheduledStart: iso(m.scheduled_start), scheduledEnd: iso(m.scheduled_end), startedAt: iso(m.started_at), endedAt: iso(m.ended_at),
        recurrence: m.recurrence_rule, lobby: m.lobby,
        attendees: people.rows.map((p) => ({ ...ref(p), role: p.role, response: p.response })),
        participants: parts.rows.map((p) => ({ ...ref(p), joinedAt: p.joined_at.toISOString(), leftAt: iso(p.left_at), durationSeconds: p.duration_seconds })),
        actionItems: items.rows.map((i) => ({ id: i.id, text: i.text, assignee: i.assignee_id ? { id: i.assignee_id, displayName: i.display_name, email: i.email ?? '' } : null, dueDate: i.due_date, taskId: i.task_id, createdAt: i.created_at.toISOString() })),
        joinUrl: `${this.webUrl()}/meetings/${m.id}`,
        myRole,
        canEdit: this.moderates(role, user, m),
        version: m.version,
        recording,
        canRecord,
      };
    });
  }

  async list(user: AuthenticatedUser, scope: 'upcoming' | 'past' | 'live', limit: number) {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const res = await db.query<MeetingRow & { host_name: string | null; host_email: string; my_role: string | null }>(
        `SELECT m.*, h.display_name AS host_name, h.email AS host_email,
                CASE WHEN m.host_id = $1 THEN 'HOST' ELSE a.role END AS my_role
         FROM meetings m JOIN users h ON h.id = m.host_id LEFT JOIN meeting_attendees a ON a.meeting_id = m.id AND a.user_id = $1
         WHERE m.type <> 'ROOM' AND (m.host_id = $1 OR a.user_id IS NOT NULL)
           AND CASE $2::text
                 WHEN 'live' THEN m.status = 'LIVE'
                 WHEN 'past' THEN m.status IN ('ENDED', 'CANCELLED') OR (m.type = 'SCHEDULED' AND m.recurrence_rule IS NULL AND m.scheduled_end < now())
                 ELSE m.status IN ('SCHEDULED', 'LIVE') AND (m.type = 'INSTANT' OR m.recurrence_rule IS NOT NULL OR m.scheduled_end >= now())
               END
         ORDER BY COALESCE(m.scheduled_start, m.created_at) ${scope === 'past' ? 'DESC' : 'ASC'} LIMIT $3`,
        [user.id, scope, limit],
      );
      const now = new Date();
      return {
        items: res.rows.map((m) => {
          const next = m.scheduled_start && m.scheduled_end && m.recurrence_rule ? nextOccurrence(m.scheduled_start, m.scheduled_end, m.recurrence_rule, now) : null;
          return {
            id: m.id, type: m.type, status: m.status, title: m.title, host: { id: m.host_id, displayName: m.host_name, email: m.host_email },
            scheduledStart: iso(next?.start ?? m.scheduled_start), scheduledEnd: iso(next?.end ?? m.scheduled_end), startedAt: iso(m.started_at),
            myRole: (m.my_role ?? 'NONE') as Meeting['myRole'], recurrence: m.recurrence_rule,
          };
        }),
      };
    });
  }

  async update(user: AuthenticatedUser, id: string, dto: MeetingUpdateDto): Promise<Meeting> {
    let reinvite = false;
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const m = await this.row(db, id, true);
      const role = await this.assertVisible(db, user, m);
      const onlyNotes = Object.keys(dto).every((k) => k === 'notes' || k === 'version');
      // Notes: anyone in the meeting; everything else: host and co-hosts.
      if (!(this.moderates(role, user, m) || (onlyNotes && role !== 'NONE'))) throw new ForbiddenException('Only the host and co-hosts can change this meeting');
      if (dto.version !== m.version) throw new ConflictException('Someone else changed this meeting. Reload and try again.');
      if ((dto.start || dto.end) && m.type !== 'SCHEDULED') throw new BadRequestException('Only scheduled meetings have a time');
      const start = dto.start ?? iso(m.scheduled_start);
      const end = dto.end ?? iso(m.scheduled_end);
      if (m.type === 'SCHEDULED' && start && end && Date.parse(end) <= Date.parse(start)) throw new BadRequestException('The end must be after the start');
      reinvite = m.type === 'SCHEDULED' && (dto.start !== undefined || dto.end !== undefined || dto.title !== undefined || dto.attendeeIds !== undefined);
      await db.query(
        `UPDATE meetings SET title = $2, agenda = $3, notes = $4, scheduled_start = $5, scheduled_end = $6, lobby = $7,
           ics_sequence = ics_sequence + $8, version = version + 1, updated_at = now() WHERE id = $1`,
        [id, dto.title ?? m.title, dto.agenda ?? m.agenda, dto.notes ?? m.notes, start, end, dto.lobby ?? m.lobby, reinvite ? 1 : 0],
      );
      if (dto.attendeeIds || dto.cohostIds) {
        const current = (await db.query<{ user_id: string; role: AttendeeRole }>(`SELECT user_id, role FROM meeting_attendees WHERE meeting_id = $1`, [id])).rows;
        const cohosts = new Set((dto.cohostIds ?? current.filter((c) => c.role === 'COHOST').map((c) => c.user_id)).filter((x) => x !== m.host_id));
        const wanted = new Set([...(dto.attendeeIds ?? current.map((c) => c.user_id)), ...cohosts].filter((x) => x !== m.host_id));
        const found = wanted.size ? await db.query<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE'`, [[...wanted]]) : { rows: [] };
        if (found.rows.length !== wanted.size) throw new NotFoundException('Some attendees were not found');
        await db.query(`DELETE FROM meeting_attendees WHERE meeting_id = $1 AND NOT (user_id = ANY($2::uuid[]))`, [id, [...wanted]]);
        for (const u of wanted) {
          await db.query(`INSERT INTO meeting_attendees (org_id, meeting_id, user_id, role) VALUES ($1, $2, $3, $4) ON CONFLICT (meeting_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
            [user.orgId, id, u, cohosts.has(u) ? 'COHOST' : 'ATTENDEE']);
        }
      }
      if (!onlyNotes) await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'MEETING_UPDATED', entityType: 'MEETING', entityId: id, after: { fields: Object.keys(dto).filter((k) => k !== 'version' && k !== 'notes') } });
    });
    if (reinvite) await this.sendInvites(user, id, 'REQUEST');
    return await this.get(user, id);
  }

  async cancel(user: AuthenticatedUser, id: string): Promise<Meeting> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const m = await this.row(db, id, true);
      const role = await this.assertVisible(db, user, m);
      if (role !== 'HOST' && !userCan(user, Permission.ORG_MANAGE)) throw new ForbiddenException('Only the host can cancel');
      if (m.status === 'CANCELLED' || m.status === 'ENDED') throw new ConflictException(`This meeting is ${m.status.toLowerCase()}`);
      await db.query(`UPDATE meetings SET status = 'CANCELLED', ics_sequence = ics_sequence + 1, version = version + 1, updated_at = now() WHERE id = $1`, [id]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'MEETING_CANCELLED', entityType: 'MEETING', entityId: id });
    });
    await this.sendInvites(user, id, 'CANCEL');
    await roomService(liveKitConfig(), 'DeleteRoom', (await this.lkName(user, id)), {}).catch(() => undefined);
    return await this.get(user, id);
  }

  async respond(user: AuthenticatedUser, id: string, accept: boolean): Promise<Meeting> {
    const instant = await this.prisma.runWithTenantContext(user.orgId, async (db) => (await this.row(db, id)).type === 'INSTANT');
    if (instant) {
      await this.calls.respond(user, id, accept);
      await this.calls.cancel(user, id);
    return this.get(user, id);
    }
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const res = await db.query(`UPDATE meeting_attendees SET response = $3 WHERE meeting_id = $1 AND user_id = $2`, [id, user.id, accept ? 'ACCEPTED' : 'DECLINED']);
      if (res.rowCount === 0) throw new NotFoundException('You are not invited to this meeting');
    });
    return await this.get(user, id);
  }

  private async lkName(user: AuthenticatedUser, id: string): Promise<string> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => (await this.row(db, id)).livekit_room_name);
  }

  /** The .ics for one meeting (download, and what the invite email carries). */
  async ics(user: AuthenticatedUser, id: string, method: 'REQUEST' | 'CANCEL' = 'REQUEST'): Promise<string> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const m = await this.row(db, id);
      await this.assertVisible(db, user, m);
      if (m.type !== 'SCHEDULED' || !m.scheduled_start || !m.scheduled_end) throw new BadRequestException('Only scheduled meetings have a calendar invite');
      return await this.icsFor(db, m, method);
    });
  }

  private async icsFor(db: pg.PoolClient, m: MeetingRow, method: 'REQUEST' | 'CANCEL'): Promise<string> {
    const people = (await db.query<{ display_name: string | null; email: string }>(`SELECT u.display_name, u.email FROM meeting_attendees a JOIN users u ON u.id = a.user_id WHERE a.meeting_id = $1`, [m.id])).rows;
    const host = (await db.query<{ display_name: string | null; email: string }>(`SELECT display_name, email FROM users WHERE id = $1`, [m.host_id])).rows[0]!;
    return buildIcs({
      uid: `${m.id}@hrvo`, sequence: m.ics_sequence, method, title: m.title, description: m.agenda, start: m.scheduled_start!, end: m.scheduled_end!,
      organizer: { name: host.display_name ?? host.email, email: host.email }, attendees: people.map((p) => ({ name: p.display_name ?? p.email, email: p.email })),
      url: `${this.webUrl()}/meetings/${m.id}`, rrule: m.recurrence_rule,
    });
  }

  /** FR-MEET-003: invite email with the .ics attached, to every attendee. */
  private async sendInvites(user: AuthenticatedUser, id: string, method: 'REQUEST' | 'CANCEL'): Promise<void> {
    const mails = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const m = await this.row(db, id);
      if (m.type !== 'SCHEDULED' || !m.scheduled_start) return [];
      const ics = await this.icsFor(db, m, method);
      const people = (await db.query<{ email: string; display_name: string | null }>(`SELECT u.email, u.display_name FROM meeting_attendees a JOIN users u ON u.id = a.user_id WHERE a.meeting_id = $1 AND u.status = 'ACTIVE'`, [id])).rows;
      const when = m.scheduled_start.toISOString().replace('T', ' ').slice(0, 16);
      return people.map((p) => ({
        to: p.email,
        subject: `${method === 'CANCEL' ? 'Cancelled: ' : m.ics_sequence > 0 ? 'Updated: ' : 'Invitation: '}${m.title} (${when} UTC)`,
        text: `Hello ${p.display_name ?? p.email},\n\n${method === 'CANCEL' ? 'This meeting has been cancelled.' : `You are invited to “${m.title}”.`}\n\n${m.agenda ? `${m.agenda}\n\n` : ''}Join: ${this.webUrl()}/meetings/${m.id}\n\nThe calendar invite is attached.`,
        attachments: [{ filename: 'invite.ics', contentType: `text/calendar; method=${method}`, content: ics }],
      }));
    });
    for (const mail of mails) await this.mailer.send(mail).catch((err: unknown) => console.error('Meeting invite failed:', err instanceof Error ? err.message : 'unknown error'));
  }

  // ---------------------------------------------------------------- joining and the lobby (FR-MEET-005)

  async join(user: AuthenticatedUser, id: string): Promise<JoinResult> {
    const out = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const m = await this.row(db, id);
      if (m.type === 'ROOM') return { kind: 'denied' as const, message: 'Room meetings are joined by walking into the room' };
      if (m.status === 'CANCELLED') return { kind: 'denied' as const, message: 'This meeting was cancelled' };
      if (m.status === 'ENDED' && !m.recurrence_rule && m.type === 'INSTANT') return { kind: 'denied' as const, message: 'This call has ended' };
      const role = await this.roleOf(db, m, user.id);
      // FR-MEET-007: nobody enters a call that is being recorded without agreeing first.
      const ready = async () => {
        const recordingId = await this.recordings.joinBlocker(db, id, user.id);
        return recordingId ? { kind: 'consent' as const, recordingId } : { kind: 'ready' as const, m, role };
      };
      if (role !== 'NONE' || !m.lobby) return await ready();
      const entry = (await db.query<{ state: string }>(`SELECT state FROM meeting_lobby WHERE meeting_id = $1 AND user_id = $2`, [id, user.id])).rows[0];
      if (entry?.state === 'ADMITTED') return await ready();
      if (entry?.state === 'DENIED') return { kind: 'denied' as const, message: 'The host did not let you in' };
      if (!entry) await db.query(`INSERT INTO meeting_lobby (org_id, meeting_id, user_id) VALUES ($1, $2, $3)`, [user.orgId, id, user.id]);
      const hosts = (await db.query<{ user_id: string }>(`SELECT $2::uuid AS user_id UNION SELECT user_id FROM meeting_attendees WHERE meeting_id = $1 AND role = 'COHOST'`, [id, m.host_id])).rows.map((r) => r.user_id);
      const name = (await db.query<{ n: string }>(`SELECT COALESCE(display_name, email) AS n FROM users WHERE id = $1`, [user.id])).rows[0]!.n;
      return { kind: 'waiting' as const, hosts, name, title: m.title };
    });
    if (out.kind === 'denied') return { status: 'DENIED', message: out.message };
    if (out.kind === 'consent') return { status: 'CONSENT_REQUIRED', recordingId: out.recordingId, message: 'This meeting is being recorded. Join only if you agree to be recorded.' };
    if (out.kind === 'waiting') {
      for (const h of out.hosts) this.gateway.notifyUser(h, 'meeting:lobby', { meetingId: id, userId: user.id, name: out.name, title: out.title });
      return { status: 'WAITING', message: 'Waiting for the host to let you in' };
    }
    const canModerate = this.moderates(out.role, user, out.m);
    return { status: 'READY', token: await this.media.meetingToken(user, { id: out.m.id, title: out.m.title, livekitRoomName: out.m.livekit_room_name }, canModerate) };
  }

  private async assertModerator(db: pg.PoolClient, user: AuthenticatedUser, id: string): Promise<MeetingRow> {
    const m = await this.row(db, id);
    const role = await this.roleOf(db, m, user.id);
    if (!this.moderates(role, user, m)) throw new ForbiddenException('Only the host and co-hosts can do this');
    return m;
  }

  async lobby(user: AuthenticatedUser, id: string) {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await this.assertModerator(db, user, id);
      const r = await db.query<{ user_id: string; display_name: string | null; email: string; requested_at: Date }>(
        `SELECT l.user_id, u.display_name, u.email, l.requested_at FROM meeting_lobby l JOIN users u ON u.id = l.user_id WHERE l.meeting_id = $1 AND l.state = 'WAITING' ORDER BY l.requested_at`, [id]);
      return { items: r.rows.map((x) => ({ userId: x.user_id, displayName: x.display_name, email: x.email, requestedAt: x.requested_at.toISOString() })) };
    });
  }

  async decide(user: AuthenticatedUser, id: string, userId: string, admit: boolean): Promise<{ ok: true }> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await this.assertModerator(db, user, id);
      const r = await db.query(`UPDATE meeting_lobby SET state = $3, decided_by = $4, decided_at = now() WHERE meeting_id = $1 AND user_id = $2 AND state = 'WAITING'`, [id, userId, admit ? 'ADMITTED' : 'DENIED', user.id]);
      if (r.rowCount === 0) throw new NotFoundException('Nobody is waiting with this id');
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: admit ? 'MEETING_LOBBY_ADMITTED' : 'MEETING_LOBBY_DENIED', entityType: 'MEETING', entityId: id, after: { userId } });
    });
    this.gateway.notifyUser(userId, 'meeting:lobby-decision', { meetingId: id, admit });
    return { ok: true };
  }

  /** Host control: mute every other participant's microphone. */
  async muteAll(user: AuthenticatedUser, id: string): Promise<{ muted: number }> {
    const m = await this.prisma.runWithTenantContext(user.orgId, (db) => this.assertModerator(db, user, id));
    const cfg = liveKitConfig();
    const room = m.type === 'ROOM' ? await this.officeRoomName(user, m) : m.livekit_room_name;
    // A room nobody has joined yet does not exist in LiveKit: nothing to mute.
    const list = await roomService<{ participants?: LkParticipant[] }>(cfg, 'ListParticipants', room, {}).catch(() => ({ participants: [] as LkParticipant[] }));
    let muted = 0;
    for (const p of list.participants ?? []) {
      if (p.identity === user.id) continue;
      for (const t of p.tracks ?? []) {
        const isMic = t.source === 'MICROPHONE' || t.source === 2 || t.type === 'AUDIO' || t.type === 0;
        if (isMic && !t.muted) { await roomService(cfg, 'MutePublishedTrack', room, { identity: p.identity, track_sid: t.sid, muted: true }); muted += 1; }
      }
    }
    await this.prisma.runWithTenantContext(user.orgId, (db) => appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'MEETING_MUTE_ALL', entityType: 'MEETING', entityId: id, after: { muted } }));
    return { muted };
  }

  /** Host control: remove someone; people who were not invited cannot come back without a new admission. */
  async remove(user: AuthenticatedUser, id: string, userId: string): Promise<{ ok: true }> {
    const m = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const row = await this.assertModerator(db, user, id);
      if (userId === row.host_id) throw new ForbiddenException('The host cannot be removed');
      await db.query(`INSERT INTO meeting_lobby (org_id, meeting_id, user_id, state, decided_by, decided_at) VALUES ($1, $2, $3, 'DENIED', $4, now())
                      ON CONFLICT (meeting_id, user_id) DO UPDATE SET state = 'DENIED', decided_by = EXCLUDED.decided_by, decided_at = now()`, [user.orgId, id, userId, user.id]).catch(() => undefined);
      await db.query(`DELETE FROM channel_members WHERE user_id = $1 AND channel_id IN (SELECT id FROM channels WHERE meeting_id = $2)`, [userId, id]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'MEETING_PARTICIPANT_REMOVED', entityType: 'MEETING', entityId: id, after: { userId } });
      return row;
    });
    const room = m.type === 'ROOM' ? await this.officeRoomName(user, m) : m.livekit_room_name;
    await roomService(liveKitConfig(), 'RemoveParticipant', room, { identity: userId }).catch(() => undefined);
    this.gateway.notifyUser(userId, 'meeting:removed', { meetingId: id });
    return { ok: true };
  }

  private async officeRoomName(user: AuthenticatedUser, m: MeetingRow): Promise<string> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => (await db.query<{ livekit_room_name: string }>(`SELECT livekit_room_name FROM rooms WHERE id = $1`, [m.room_id])).rows[0]!.livekit_room_name);
  }

  // ---------------------------------------------------------------- notes and action items (FR-MEET-008)

  async addActionItem(user: AuthenticatedUser, id: string, dto: ActionItemDto): Promise<Meeting> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const m = await this.row(db, id);
      const role = await this.assertVisible(db, user, m);
      if (role === 'NONE' && !userCan(user, Permission.ORG_MANAGE)) throw new ForbiddenException('Only people in the meeting add action items');
      if (dto.assigneeId) {
        const ok = await db.query(`SELECT 1 WHERE $2::uuid = $3::uuid OR EXISTS (SELECT 1 FROM meeting_attendees WHERE meeting_id = $1 AND user_id = $2)`, [id, dto.assigneeId, m.host_id]);
        if (!ok.rows[0]) throw new BadRequestException('Action items are assigned to attendees');
      }
      await db.query(`INSERT INTO meeting_action_items (org_id, meeting_id, text, assignee_id, due_date, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [user.orgId, id, dto.text, dto.assigneeId ?? null, dto.dueDate ?? null, user.id]);
    });
    return await this.get(user, id);
  }

  /** One click: the action item becomes a task assigned to the attendee (normal task rules apply). */
  async convertToTask(user: AuthenticatedUser, id: string, itemId: string): Promise<Meeting> {
    const item = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const m = await this.row(db, id);
      const role = await this.assertVisible(db, user, m);
      if (role === 'NONE' && !userCan(user, Permission.ORG_MANAGE)) throw new ForbiddenException();
      const i = (await db.query<{ text: string; assignee_id: string | null; due_date: string | null; task_id: string | null }>(
        `SELECT text, assignee_id, to_char(due_date, 'YYYY-MM-DD') AS due_date, task_id FROM meeting_action_items WHERE id = $1 AND meeting_id = $2 FOR UPDATE`, [itemId, id])).rows[0];
      if (!i) throw new NotFoundException('Action item not found');
      if (i.task_id) throw new ConflictException('This action item is already a task');
      return { ...i, title: m.title };
    });
    const task = await this.tasks.create(user, CreateTaskDtoSchema.parse({
      title: item.text.slice(0, 300),
      description: `From the meeting “${item.title}”.`,
      assigneeId: item.assignee_id,
      dueDate: item.due_date,
    }));
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`UPDATE meeting_action_items SET task_id = $2 WHERE id = $1`, [itemId, task.id]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'MEETING_ACTION_TO_TASK', entityType: 'MEETING', entityId: id, after: { itemId, taskId: task.id } });
    });
    return await this.get(user, id);
  }
}
