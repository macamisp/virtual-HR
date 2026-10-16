/**
 * Media and meetings end to end (FR-VO-005, 009, 010; FR-MEET-001, 002, 003, 005, 008, 009; ADR 016)
 * against Postgres and a real LiveKit server: token scoping (nobody gets a token for a room they
 * cannot enter), tokens LiveKit accepts, signed webhooks recording join/leave, scheduled meetings
 * with .ics invites, the lobby, host controls, action items to tasks, instant calls and broadcasts.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { generateSync } from 'otplib';
import { io, type Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { MAIL_TRANSPORT, InMemoryMailTransport } from '../src/common/mailer.ts';
import { liveKitConfig, signWebhook } from '../src/media/livekit.ts';
import { OfficeSnapshotSchema } from '../../../packages/shared/src/office/index.ts';
import type { JoinAck, OfficeSnapshot, TeleportAck } from '../../../packages/shared/src/office/index.ts';
import { JoinResultSchema, LobbySchema, MediaTokenSchema, MeetingListSchema, MeetingSchema } from '../../../packages/shared/src/meetings/types.ts';
import type { Meeting, MediaToken } from '../../../packages/shared/src/meetings/types.ts';

const ORG = 'b1b10000-0000-4000-8000-000000000001';
const OTHER = 'b1b10000-0000-4000-8000-000000000002';
const PORT = 3088;
const PASSWORD = 'ComplexPassword123!';
const SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const U = {
  admin: { id: 'b1b10000-0000-4000-8000-000000000011', org: ORG, email: 'admin@meet.test', name: 'Ada Admin', role: 'ADMIN', mfa: true },
  host: { id: 'b1b10000-0000-4000-8000-000000000012', org: ORG, email: 'hana@meet.test', name: 'Hana Host', role: 'MANAGER', mfa: false },
  a: { id: 'b1b10000-0000-4000-8000-000000000013', org: ORG, email: 'anna@meet.test', name: 'Anna A', role: 'EMPLOYEE', mfa: false },
  b: { id: 'b1b10000-0000-4000-8000-000000000014', org: ORG, email: 'ben@meet.test', name: 'Ben B', role: 'EMPLOYEE', mfa: false },
  c: { id: 'b1b10000-0000-4000-8000-000000000015', org: ORG, email: 'cleo@meet.test', name: 'Cleo C', role: 'SUBCONTRACTOR', mfa: false },
  other: { id: 'b1b10000-0000-4000-8000-000000000021', org: OTHER, email: 'otto@meet-other.test', name: 'Otto Other', role: 'EMPLOYEE', mfa: false },
} as const;
type Who = keyof typeof U;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const claims = (t: MediaToken) => jwt.decode(t.token) as { video: { room: string; roomJoin: boolean; canPublish: boolean }; sub: string; exp: number; iat?: number; nbf?: number };

describe('Media and meetings (FR-VO-005, 009, 010; FR-MEET-001..003, 005, 008, 009)', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  let outbox: InMemoryMailTransport;
  const base = `http://localhost:${PORT}`;
  const tokens = {} as Record<Who, string>;
  const sockets: Socket[] = [];
  let snap: OfficeSnapshot;

  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  async function ok<T>(res: Response, status: number, schema?: { parse: (v: unknown) => T }): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return schema ? schema.parse(JSON.parse(text)) : (JSON.parse(text || 'null') as T);
  }
  async function officeSocket(who: Who) {
    const s = io(base, { transports: ['websocket'], reconnection: false, auth: { token: tokens[who], purpose: 'office' } });
    sockets.push(s);
    await new Promise<void>((res, rej) => { s.once('connect', () => res()); s.once('connect_error', rej); });
    const events: Array<{ name: string; payload: unknown }> = [];
    s.onAny((name: string, payload: unknown) => events.push({ name, payload }));
    const join = (await s.emitWithAck('office:join', { positions: true })) as JoinAck;
    assert.ok(join.ok, `${who} joins`);
    const teleport = (dto: unknown) => s.emitWithAck('office:teleport', dto) as Promise<TeleportAck>;
    return { s, events, teleport };
  }
  /** LiveKit itself checks the token (signature, expiry, grant). */
  const liveKitAccepts = async (t: string) => (await fetch(`${liveKitConfig().httpUrl}/rtc/validate?access_token=${encodeURIComponent(t)}`)).status === 200;
  const webhook = async (body: Record<string, unknown>, sign = true) => {
    const raw = JSON.stringify(body);
    return await fetch(`${base}/media/livekit/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/webhook+json', Authorization: sign ? signWebhook(liveKitConfig(), raw) : 'Bearer nope' }, body: raw });
  };
  const room = (name: string) => snap.rooms.find((r) => r.name === name)!;

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Meet Ltd', 'meet-e2e'), ($2, 'Other Ltd', 'meet-other-e2e')`, [ORG, OTHER]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status, mfa_enabled, mfa_secret) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8)`,
        [u.id, u.org, u.email, u.name, u.role, hash, u.mfa, u.mfa ? SECRET : null]);
    }
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    outbox = app.get<InMemoryMailTransport>(MAIL_TRANSPORT, { strict: false });
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD, ...(U[who].mfa ? { totpCode: generateSync({ secret: SECRET }) } : {}) }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
      assert.ok(tokens[who], `login ${who}`);
    }
    snap = await ok(await api('a', '/office'), 200, OfficeSnapshotSchema);
  });

  after(async () => {
    for (const s of sockets) s.disconnect();
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.end();
  });

  describe('Token scoping (FR-MEET-002, FR-VO-005)', { concurrency: false }, () => {
    let A: Awaited<ReturnType<typeof officeSocket>>;
    let B: Awaited<ReturnType<typeof officeSocket>>;

    it('no token outside the office, in the open area, or for a room the user is not in', async () => {
      assert.equal((await api('a', '/media/token', { method: 'POST', body: { kind: 'room' } })).status, 409, 'not in the office');
      A = await officeSocket('a');
      assert.ok((await A.teleport({ kind: 'room', roomId: room('Lounge').id })).ok);
      assert.equal((await api('a', '/media/token', { method: 'POST', body: { kind: 'room' } })).status, 409, 'open areas use proximity');
      assert.equal((await api('a', '/media/token', { method: 'POST', body: { kind: 'room', roomId: room('Board room').id } })).status, 400, 'the client cannot name a room');
      assert.equal((await api('a', '/media/token', { method: 'POST', body: { kind: 'proximity' } })).status, 409, 'nobody near');
    });

    it('inside a meeting room: a 10-minute token for exactly that room, which LiveKit accepts', async () => {
      assert.ok((await A.teleport({ kind: 'room', roomId: room('Meeting room A').id })).ok);
      const t = await ok(await api('a', '/media/token', { method: 'POST', body: { kind: 'room' } }), 200, MediaTokenSchema);
      const c = claims(t);
      const lk = await adminPool.query(`SELECT livekit_room_name FROM rooms WHERE id = $1`, [room('Meeting room A').id]);
      assert.equal(c.video.room, lk.rows[0].livekit_room_name);
      assert.equal(c.sub, U.a.id);
      assert.ok(c.exp - Math.floor(Date.now() / 1000) <= 600 && c.exp - Math.floor(Date.now() / 1000) > 540, 'short-lived');
      assert.equal(t.label, 'Meeting room A');
      assert.equal(await liveKitAccepts(t.token), true, 'LiveKit validates our signature and grant');
      assert.equal(await liveKitAccepts(`${t.token.slice(0, -4)}AAAA`), false, 'a tampered token is refused');
    });

    it('a knock room: no token from outside, even when people are inside; a token once admitted', async () => {
      const Ad = await officeSocket('admin');
      assert.ok((await Ad.teleport({ kind: 'room', roomId: room('Board room').id })).ok);
      const adminToken = await ok(await api('admin', '/media/token', { method: 'POST', body: { kind: 'room' } }), 200, MediaTokenSchema);
      assert.equal(adminToken.canModerate, true);
      B = await officeSocket('b');
      assert.equal(((await B.teleport({ kind: 'room', roomId: room('Board room').id })) as { code?: string }).code, 'KNOCK');
      assert.equal((await api('b', '/media/token', { method: 'POST', body: { kind: 'room' } })).status, 409, 'not inside the board room (standing in the open area): no room token');
      await B.s.emitWithAck('room:knock', { roomId: room('Board room').id });
      await Ad.s.emitWithAck('room:answer', { roomId: room('Board room').id, userId: U.b.id, admit: true });
      assert.ok((await B.teleport({ kind: 'room', roomId: room('Board room').id })).ok);
      const bt = await ok(await api('b', '/media/token', { method: 'POST', body: { kind: 'room' } }), 200, MediaTokenSchema);
      assert.equal(claims(bt).video.room, claims(adminToken).video.room);
      assert.equal(bt.canModerate, false);
      Ad.s.disconnect();
    });

    it('proximity: a token only for your own group; people in another group get another room', async () => {
      assert.ok((await A.teleport({ kind: 'room', roomId: room('Lounge').id })).ok);
      assert.ok((await B.teleport({ kind: 'user', userId: U.a.id })).ok);
      await wait(300);
      const ta = await ok(await api('a', '/media/token', { method: 'POST', body: { kind: 'proximity' } }), 200, MediaTokenSchema);
      const tb = await ok(await api('b', '/media/token', { method: 'POST', body: { kind: 'proximity' } }), 200, MediaTokenSchema);
      assert.equal(claims(ta).video.room, claims(tb).video.room, 'same group, same room');
      assert.match(claims(ta).video.room, new RegExp(`^prox-${ORG}-`));
      const C = await officeSocket('c');
      assert.ok((await C.teleport({ kind: 'room', roomId: room('Reception').id })).ok);
      await wait(300);
      assert.equal((await api('c', '/media/token', { method: 'POST', body: { kind: 'proximity' } })).status, 409, 'Cleo is not in their group');
      await B.s.emitWithAck('office:mode', { roomOnly: true });
      await wait(300);
      assert.equal((await api('a', '/media/token', { method: 'POST', body: { kind: 'proximity' } })).status, 409, 'room-only mode leaves the group');
      await B.s.emitWithAck('office:mode', { roomOnly: false });
      C.s.disconnect();
    });

    it('another organisation never reaches our rooms', async () => {
      assert.equal((await api('other', '/media/token', { method: 'POST', body: { kind: 'room' } })).status, 409);
    });
  });

  describe('Webhooks record join and leave (FR-MEET-009, 002)', { concurrency: false }, () => {
    it('refuses unsigned or altered webhooks', async () => {
      assert.equal((await webhook({ event: 'participant_joined', room: { name: 'x' } }, false)).status, 401);
      const raw = JSON.stringify({ event: 'participant_joined', room: { name: 'x' } });
      const sig = signWebhook(liveKitConfig(), raw);
      const res = await fetch(`${base}/media/livekit/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/webhook+json', Authorization: sig }, body: raw.replace('x', 'y') });
      assert.equal(res.status, 401, 'body changed after signing');
    });

    it('walking into a room starts a ROOM meeting; join and leave times use the server clock', async () => {
      const lk = (await adminPool.query(`SELECT livekit_room_name FROM rooms WHERE id = $1`, [room('Meeting room B').id])).rows[0].livekit_room_name as string;
      assert.equal((await webhook({ event: 'participant_joined', room: { name: lk }, participant: { identity: U.a.id, sid: 'PA_1' } })).status, 200);
      assert.equal((await webhook({ event: 'participant_joined', room: { name: lk }, participant: { identity: U.b.id, sid: 'PA_2' } })).status, 200);
      assert.equal((await webhook({ event: 'participant_joined', room: { name: lk }, participant: { identity: U.b.id, sid: 'PA_2' } })).status, 200, 'retries are idempotent');
      const m = await adminPool.query(`SELECT id, type, status, host_id, started_at FROM meetings WHERE org_id = $1 AND room_id = $2`, [ORG, room('Meeting room B').id]);
      assert.equal(m.rows.length, 1);
      assert.deepEqual([m.rows[0].type, m.rows[0].status, m.rows[0].host_id], ['ROOM', 'LIVE', U.a.id]);
      await wait(1100);
      await webhook({ event: 'participant_left', room: { name: lk }, participant: { identity: U.b.id, sid: 'PA_2' } });
      await webhook({ event: 'room_finished', room: { name: lk } });
      const p = await adminPool.query(`SELECT user_id, left_at IS NOT NULL AS left, duration_seconds FROM meeting_participants WHERE meeting_id = $1 ORDER BY user_id`, [m.rows[0].id]);
      assert.deepEqual(p.rows.map((r) => [r.user_id, r.left]), [[U.a.id, true], [U.b.id, true]]);
      assert.ok(p.rows.every((r) => r.duration_seconds >= 1));
      const ended = await adminPool.query(`SELECT status, ended_at IS NOT NULL AS done FROM meetings WHERE id = $1`, [m.rows[0].id]);
      assert.deepEqual(ended.rows[0], { status: 'ENDED', done: true });
      await webhook({ event: 'participant_joined', room: { name: lk }, participant: { identity: U.a.id, sid: 'PA_3' } });
      assert.equal((await adminPool.query(`SELECT count(*)::int AS n FROM meetings WHERE room_id = $1`, [room('Meeting room B').id])).rows[0].n, 2, 'the next session is a new meeting');
      // Attendance evidence is append-only for the app.
      const c = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGUSER || 'hrvo_app', password: process.env.PGPASSWORD });
      const client = await c.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
        await assert.rejects(client.query(`DELETE FROM meeting_participants`), /permission denied/);
      } finally { await client.query('ROLLBACK'); client.release(); await c.end(); }
    });

    it('a webhook naming a stranger or another organisation\'s user records nothing', async () => {
      const lk = (await adminPool.query(`SELECT livekit_room_name FROM rooms WHERE id = $1`, [room('Meeting room C').id])).rows[0].livekit_room_name as string;
      await webhook({ event: 'participant_joined', room: { name: lk }, participant: { identity: U.other.id, sid: 'PX' } });
      await webhook({ event: 'participant_joined', room: { name: lk }, participant: { identity: 'not-a-uuid', sid: 'PY' } });
      assert.equal((await adminPool.query(`SELECT count(*)::int AS n FROM meetings WHERE room_id = $1`, [room('Meeting room C').id])).rows[0].n, 0);
    });
  });

  describe('Scheduled meetings and invites (FR-MEET-003)', { concurrency: false }, () => {
    let m: Meeting;
    const start = new Date(Date.now() + 86_400_000);
    const end = new Date(start.getTime() + 3_600_000);

    it('validates input; creates the meeting and emails an .ics invite to every attendee', async () => {
      assert.equal((await api('host', '/meetings', { method: 'POST', body: { type: 'SCHEDULED', title: 'Q4 plan' } })).status, 400, 'needs a time');
      assert.equal((await api('host', '/meetings', { method: 'POST', body: { type: 'SCHEDULED', title: 'x', start: end.toISOString(), end: start.toISOString() } })).status, 400);
      assert.equal((await api('host', '/meetings', { method: 'POST', body: { type: 'SCHEDULED', title: 'x', start: start.toISOString(), end: end.toISOString(), attendeeIds: [U.other.id] } })).status, 404, 'other organisation');
      outbox.outbox.length = 0;
      m = await ok(await api('host', '/meetings', { method: 'POST', body: {
        type: 'SCHEDULED', title: 'Q4 planning, part 1', agenda: 'Budget; hiring', start: start.toISOString(), end: end.toISOString(),
        attendeeIds: [U.a.id, U.b.id], cohostIds: [U.a.id], recurrence: { freq: 'WEEKLY', interval: 1, count: 6, byDay: ['MO'] },
      } }), 201, MeetingSchema);
      assert.equal(m.myRole, 'HOST');
      assert.deepEqual(m.attendees.map((x) => [x.id, x.role]).sort(), [[U.a.id, 'COHOST'], [U.b.id, 'ATTENDEE']].sort());
      assert.equal(m.recurrence, 'FREQ=WEEKLY;BYDAY=MO;COUNT=6');
      assert.equal(outbox.outbox.length, 2);
      const mail = outbox.outbox.find((x) => x.to === U.b.email)!;
      assert.match(mail.subject, /^Invitation: Q4 planning, part 1/);
      const ics = { ...mail.attachments![0]!, content: mail.attachments![0]!.content.replace(/\r\n /g, '') }; // unfold
      const raw = mail.attachments![0]!.content;
      assert.equal(ics.contentType, 'text/calendar; method=REQUEST');
      assert.match(ics.content, /^BEGIN:VCALENDAR\r\n/);
      assert.match(ics.content, /METHOD:REQUEST/);
      assert.match(ics.content, new RegExp(`UID:${m.id}@hrvo`));
      assert.match(ics.content, /SUMMARY:Q4 planning\\, part 1/, 'text is escaped');
      assert.match(ics.content, /RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6/);
      assert.match(ics.content, /ATTENDEE;[^\r\n]*mailto:ben@meet\.test/);
      assert.match(ics.content, new RegExp(`/meetings/${m.id}`));
      assert.ok(raw.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'lines are folded');
      const dl = await api('b', `/meetings/${m.id}/invite.ics`);
      assert.equal(dl.status, 200);
      assert.match(dl.headers.get('content-type') ?? '', /text\/calendar/);
    });

    it('only the invited (and admins) see it; lists by scope', async () => {
      assert.equal((await api('c', `/meetings/${m.id}`)).status, 404);
      assert.equal((await api('other', `/meetings/${m.id}`)).status, 404);
      assert.equal((await api('admin', `/meetings/${m.id}`)).status, 200);
      const up = await ok(await api('b', '/meetings?scope=upcoming'), 200, MeetingListSchema);
      assert.deepEqual(up.items.map((x) => x.id), [m.id]);
      assert.equal(up.items[0]!.myRole, 'ATTENDEE');
      assert.deepEqual((await ok(await api('c', '/meetings'), 200, MeetingListSchema)).items, []);
    });

    it('rescheduling sends an update with a higher SEQUENCE; attendees cannot reschedule; notes are open to attendees', async () => {
      assert.equal((await api('b', `/meetings/${m.id}`, { method: 'PUT', body: { title: 'Mine now', version: m.version } })).status, 403);
      const notes = await ok(await api('b', `/meetings/${m.id}`, { method: 'PUT', body: { notes: 'Ben: budget agreed', version: m.version } }), 200, MeetingSchema);
      assert.equal(notes.notes, 'Ben: budget agreed');
      assert.equal((await api('host', `/meetings/${m.id}`, { method: 'PUT', body: { title: 'stale', version: m.version } })).status, 409);
      outbox.outbox.length = 0;
      const later = new Date(start.getTime() + 7_200_000);
      m = await ok(await api('a', `/meetings/${m.id}`, { method: 'PUT', body: { start: later.toISOString(), end: new Date(later.getTime() + 3_600_000).toISOString(), version: notes.version } }), 200, MeetingSchema);
      assert.equal(outbox.outbox.length, 2, 'the co-host may reschedule');
      assert.match(outbox.outbox[0]!.subject, /^Updated: /);
      assert.match(outbox.outbox[0]!.attachments![0]!.content, /SEQUENCE:1/);
      assert.ok((await ok(await api('b', `/meetings/${m.id}/accept`, { method: 'POST' }), 200, MeetingSchema)).attendees.some((x) => x.id === U.b.id && x.response === 'ACCEPTED'));
    });

    it('action items go to attendees and become tasks in one click (FR-MEET-008)', async () => {
      assert.equal((await api('b', `/meetings/${m.id}/action-items`, { method: 'POST', body: { text: 'x', assigneeId: U.c.id } })).status, 400, 'not an attendee');
      const withItem = await ok(await api('b', `/meetings/${m.id}/action-items`, { method: 'POST', body: { text: 'Draft the hiring plan', assigneeId: U.a.id, dueDate: '2026-11-30' } }), 201, MeetingSchema);
      const item = withItem.actionItems[0]!;
      assert.equal(item.taskId, null);
      // Task rules still apply: the host may only assign to people they may assign tasks to.
      const notMine = await api('host', `/meetings/${m.id}/action-items/${item.id}/task`, { method: 'POST' });
      assert.equal(notMine.status, 403, 'Anna does not report to Hana yet');
      await adminPool.query(`UPDATE users SET manager_id = $1 WHERE id = $2`, [U.host.id, U.a.id]);
      const converted = await ok(await api('host', `/meetings/${m.id}/action-items/${item.id}/task`, { method: 'POST' }), 201, MeetingSchema);
      const taskId = converted.actionItems[0]!.taskId!;
      const task = await adminPool.query(`SELECT title, assignee_id, reporter_id, to_char(due_date, 'YYYY-MM-DD') AS due FROM tasks WHERE id = $1`, [taskId]);
      assert.deepEqual(task.rows[0], { title: 'Draft the hiring plan', assignee_id: U.a.id, reporter_id: U.host.id, due: '2026-11-30' });
      assert.equal((await api('host', `/meetings/${m.id}/action-items/${item.id}/task`, { method: 'POST' })).status, 409);
      assert.equal((await api('c', `/meetings/${m.id}/action-items`, { method: 'POST', body: { text: 'x' } })).status, 404);
    });

    it('cancelling sends METHOD:CANCEL and closes the meeting', async () => {
      assert.equal((await api('a', `/meetings/${m.id}`, { method: 'DELETE' })).status, 403, 'co-hosts do not cancel');
      outbox.outbox.length = 0;
      const cancelled = await ok(await api('host', `/meetings/${m.id}`, { method: 'DELETE' }), 200, MeetingSchema);
      assert.equal(cancelled.status, 'CANCELLED');
      assert.match(outbox.outbox[0]!.subject, /^Cancelled: /);
      assert.match(outbox.outbox[0]!.attachments![0]!.content, /METHOD:CANCEL/);
      assert.equal((await ok(await api('b', `/meetings/${m.id}/join`, { method: 'POST' }), 200, JoinResultSchema)).status, 'DENIED');
    });
  });

  describe('Lobby, host controls and instant calls (FR-MEET-001, 005)', { concurrency: false }, () => {
    let meeting: Meeting;
    let hostSock: Awaited<ReturnType<typeof officeSocket>>;

    it('an instant call rings the invited; they go straight in, others wait in the lobby', async () => {
      hostSock = await officeSocket('host');
      const bSock = io(base, { transports: ['websocket'], reconnection: false, auth: { token: tokens.b, purpose: 'office' } });
      sockets.push(bSock);
      const rings: unknown[] = [];
      bSock.on('meeting:ring', (r: unknown) => rings.push(r));
      await new Promise<void>((res) => bSock.once('connect', () => res()));
      meeting = await ok(await api('host', '/meetings', { method: 'POST', body: { type: 'INSTANT', title: 'Quick sync', attendeeIds: [U.b.id] } }), 201, MeetingSchema);
      await wait(200);
      assert.equal(rings.length, 1, 'ringing');
      const bJoin = await ok(await api('b', `/meetings/${meeting.id}/join`, { method: 'POST' }), 200, JoinResultSchema);
      assert.equal(bJoin.status, 'READY');
      assert.equal(bJoin.status === 'READY' && claims(bJoin.token).video.room, `meet-${ORG}-${meeting.id}`);
      assert.equal(bJoin.status === 'READY' && bJoin.token.canModerate, false);
      const hJoin = await ok(await api('host', `/meetings/${meeting.id}/join`, { method: 'POST' }), 200, JoinResultSchema);
      assert.equal(hJoin.status === 'READY' && hJoin.token.canModerate, true);
      assert.equal(hJoin.status === 'READY' && await liveKitAccepts(hJoin.token.token), true);
      const cJoin = await ok(await api('c', `/meetings/${meeting.id}/join`, { method: 'POST' }), 200, JoinResultSchema);
      assert.equal(cJoin.status, 'WAITING');
      assert.equal((await api('c', '/media/token', { method: 'POST', body: { kind: 'meeting', meetingId: meeting.id } })).status, 401, 'no token from the lobby');
      await wait(200);
      assert.ok(hostSock.events.some((e) => e.name === 'meeting:lobby'), 'the host is told');
    });

    it('only hosts see and decide the lobby; admitted people get a token, denied ones do not', async () => {
      assert.equal((await api('b', `/meetings/${meeting.id}/lobby`)).status, 403);
      const lobby = await ok(await api('host', `/meetings/${meeting.id}/lobby`), 200, LobbySchema);
      assert.deepEqual(lobby.items.map((x) => x.userId), [U.c.id]);
      await ok(await api('host', `/meetings/${meeting.id}/lobby`, { method: 'POST', body: { userId: U.c.id, admit: true } }), 200);
      const cJoin = await ok(await api('c', `/meetings/${meeting.id}/join`, { method: 'POST' }), 200, JoinResultSchema);
      assert.equal(cJoin.status, 'READY');
      const aJoin = await ok(await api('a', `/meetings/${meeting.id}/join`, { method: 'POST' }), 200, JoinResultSchema);
      assert.equal(aJoin.status, 'WAITING');
      await ok(await api('host', `/meetings/${meeting.id}/lobby`, { method: 'POST', body: { userId: U.a.id, admit: false } }), 200);
      assert.equal((await ok(await api('a', `/meetings/${meeting.id}/join`, { method: 'POST' }), 200, JoinResultSchema)).status, 'DENIED');
      assert.equal((await api('host', `/meetings/${meeting.id}/lobby`, { method: 'POST', body: { userId: U.a.id, admit: true } })).status, 404, 'already decided');
    });

    it('host controls: mute all and remove; attendees cannot; removal sends people back to the lobby', async () => {
      assert.equal((await api('b', `/meetings/${meeting.id}/mute-all`, { method: 'POST' })).status, 403);
      const muted = await ok<{ muted: number }>(await api('host', `/meetings/${meeting.id}/mute-all`, { method: 'POST' }), 200);
      assert.equal(muted.muted, 0, 'nobody is publishing in this test');
      assert.equal((await api('b', `/meetings/${meeting.id}/remove`, { method: 'POST', body: { userId: U.c.id } })).status, 403);
      await ok(await api('host', `/meetings/${meeting.id}/remove`, { method: 'POST', body: { userId: U.c.id } }), 200);
      assert.equal((await ok(await api('c', `/meetings/${meeting.id}/join`, { method: 'POST' }), 200, JoinResultSchema)).status, 'DENIED');
      assert.equal((await api('host', `/meetings/${meeting.id}/remove`, { method: 'POST', body: { userId: U.host.id } })).status, 403);
      const audit = await adminPool.query(`SELECT action FROM audit_logs WHERE org_id = $1 AND entity_id = $2 ORDER BY id`, [ORG, meeting.id]);
      assert.deepEqual(audit.rows.map((r) => r.action), ['MEETING_CREATED', 'MEETING_LOBBY_ADMITTED', 'MEETING_LOBBY_DENIED', 'MEETING_MUTE_ALL', 'MEETING_PARTICIPANT_REMOVED']);
    });

    it('a meeting without a lobby lets anyone in the organisation join', async () => {
      const open = await ok(await api('host', '/meetings', { method: 'POST', body: { type: 'INSTANT', title: 'All hands', lobby: false } }), 201, MeetingSchema);
      assert.equal((await ok(await api('c', `/meetings/${open.id}/join`, { method: 'POST' }), 200, JoinResultSchema)).status, 'READY');
      assert.equal((await api('other', `/meetings/${open.id}/join`, { method: 'POST' })).status, 404, 'but not another organisation');
    });
  });

  describe('Announcements (FR-VO-010)', { concurrency: false }, () => {
    it('managers and admins broadcast to everyone online; employees cannot; audited', async () => {
      const listener = io(base, { transports: ['websocket'], reconnection: false, auth: { token: tokens.c } });
      sockets.push(listener);
      const got: Array<{ message: string; from: string }> = [];
      listener.on('office:broadcast', (m: { message: string; from: string }) => got.push(m));
      await new Promise<void>((res) => listener.once('connect', () => res()));
      assert.equal((await api('a', '/office/broadcast', { method: 'POST', body: { message: 'hi' } })).status, 403);
      assert.equal((await api('host', '/office/broadcast', { method: 'POST', body: { message: '' } })).status, 400);
      await ok(await api('host', '/office/broadcast', { method: 'POST', body: { message: 'Fire drill at 3 pm' } }), 201);
      await wait(200);
      assert.deepEqual(got.map((g) => [g.message, g.from]), [['Fire drill at 3 pm', U.host.name]]);
      const otherListener = io(base, { transports: ['websocket'], reconnection: false, auth: { token: tokens.other } });
      sockets.push(otherListener);
      const theirs: unknown[] = [];
      otherListener.on('office:broadcast', (m: unknown) => theirs.push(m));
      await new Promise<void>((res) => otherListener.once('connect', () => res()));
      await ok(await api('host', '/office/broadcast', { method: 'POST', body: { message: 'Second' } }), 201);
      await wait(200);
      assert.equal(theirs.length, 0, 'other organisations hear nothing');
    });
  });
});
