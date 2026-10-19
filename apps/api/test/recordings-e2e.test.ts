/**
 * Meeting recording with consent (FR-MEET-007, FR-AUD-004, FR-ADM-004; ADR 024) against Postgres
 * and real S3-compatible storage. LiveKit Egress is replaced by a local Twirp fake that checks the
 * token grant and writes the "recorded" MP4 to the staging key with the credentials it was given;
 * webhooks are signed exactly as LiveKit signs them.
 *
 * Covered: off by default, all-participant consent (one no or silence cancels), late joiners and
 * stale tokens, the banner state, encryption at rest, watching only by host/co-hosts/recorded
 * people (audited), withdrawal, failures without leaking errors, retention shredding and RLS.
 *
 * Needs S3_ENDPOINT (+ keys); skipped otherwise.
 */
import 'reflect-metadata';
import { freshCode } from './support/totp.ts';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { io, type Socket } from 'socket.io-client';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { liveKitConfig, signWebhook } from '../src/media/livekit.ts';
import { RecordingsService } from '../src/meetings/recordings.service.ts';
import { JoinResultSchema, MeetingSchema } from '../../../packages/shared/src/meetings/types.ts';
import type { Meeting } from '../../../packages/shared/src/meetings/types.ts';
import { RecordingListSchema, RecordingSchema } from '../../../packages/shared/src/meetings/recording.ts';
import type { Recording } from '../../../packages/shared/src/meetings/recording.ts';
import { CONSENT_NOTICES } from '../../../packages/shared/src/admin/types.ts';

const ORG = 'c7c70000-0000-4000-8000-000000000001';
const OTHER = 'c7c70000-0000-4000-8000-000000000002';
const PORT = 3079;
const PASSWORD = 'ComplexPassword123!';
const SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const NOTICE = CONSENT_NOTICES.RECORDING.version;
const U = {
  admin: { id: 'c7c70000-0000-4000-8000-000000000011', email: 'admin@rec.test', name: 'Ada Admin', role: 'ADMIN', mfa: true },
  host: { id: 'c7c70000-0000-4000-8000-000000000012', email: 'hana@rec.test', name: 'Hana Host', role: 'MANAGER', mfa: false },
  a: { id: 'c7c70000-0000-4000-8000-000000000013', email: 'anna@rec.test', name: 'Anna A', role: 'EMPLOYEE', mfa: false },
  b: { id: 'c7c70000-0000-4000-8000-000000000014', email: 'ben@rec.test', name: 'Ben B', role: 'EMPLOYEE', mfa: false },
  c: { id: 'c7c70000-0000-4000-8000-000000000015', email: 'cleo@rec.test', name: 'Cleo C', role: 'EMPLOYEE', mfa: false },
} as const;
type Who = keyof typeof U;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enabled = !!process.env.S3_ENDPOINT;
const BUCKET = process.env.S3_BUCKET || 'hrvo-documents';
// Stands in for the MP4 that Egress would write (content is opaque to the API).
const MP4 = Buffer.concat([Buffer.from('\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom', 'latin1'), randomBytes(200_000)]);

interface FakeCall { method: string; body: Record<string, unknown>; grant: Record<string, unknown> }

describe('Meeting recording with consent (FR-MEET-007)', { concurrency: false, skip: enabled ? false : 'S3_ENDPOINT is not set' }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  let fake: http.Server;
  let s3: S3Client;
  const calls: FakeCall[] = [];
  let failNextStart = false;
  const base = `http://localhost:${PORT}`;
  const tokens = {} as Record<Who, string>;
  const sockets: Socket[] = [];
  let meeting: Meeting;
  let roomName = '';
  let sidNo = 0;
  const sids = new Map<Who, string>();

  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}`, 'User-Agent': 'rec-e2e/1.0' }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  async function ok<T>(res: Response, status: number, schema?: { parse: (v: unknown) => T }): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return schema ? schema.parse(JSON.parse(text)) : (JSON.parse(text || 'null') as T);
  }
  const webhook = async (body: Record<string, unknown>) => {
    const raw = JSON.stringify(body);
    const res = await fetch(`${base}/media/livekit/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/webhook+json', Authorization: signWebhook(liveKitConfig(), raw) }, body: raw });
    assert.equal(res.status, 200, await res.text());
  };
  const joined = async (who: Who) => {
    const sid = `PA_${++sidNo}`;
    sids.set(who, sid);
    await webhook({ event: 'participant_joined', room: { name: roomName }, participant: { identity: U[who].id, sid } });
  };
  const left = async (who: Who) => webhook({ event: 'participant_left', room: { name: roomName }, participant: { identity: U[who].id, sid: sids.get(who) } });
  const consent = (who: Who, id: string, granted: boolean, noticeVersion = NOTICE) => api(who, `/recordings/${id}/consent`, { method: 'POST', body: { granted, noticeVersion } });
  const row = async (id: string) => (await adminPool.query(`SELECT * FROM meeting_recordings WHERE id = $1`, [id])).rows[0];
  const exists = async (key: string) => { try { await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); return true; } catch { return false; } };
  async function until<T>(f: () => Promise<T>, pred: (v: T) => boolean, ms = 15_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await f();
      if (pred(v) || Date.now() > end) return v;
      await wait(150);
    }
  }
  const egressEnded = (egressId: string, status = 'EGRESS_COMPLETE', size = MP4.length) => webhook({
    event: 'egress_ended', id: `EV_${egressId}_${status}`,
    egressInfo: { egressId, roomName, status, error: status === 'EGRESS_COMPLETE' ? '' : 's3 upload failed: AccessKey AKIAEXAMPLE denied', fileResults: size ? [{ filename: 'x.mp4', size: String(size), duration: '61000000000' }] : [] },
  });
  const audit = async (action: string) => (await adminPool.query(`SELECT 1 FROM audit_logs WHERE org_id = $1 AND action = $2`, [ORG, action])).rowCount ?? 0;

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    process.env.S3_CREATE_BUCKET = 'true';
    s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION || 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY || '', secretAccessKey: process.env.S3_SECRET_KEY || '' } });

    // The LiveKit Egress / RoomService fake: verifies the API's token, "records" into S3.
    fake = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString(); });
      req.on('end', () => void (async () => {
        const method = req.url!.split('/').pop()!;
        let grant: Record<string, unknown> = {};
        try { grant = (jwt.verify((req.headers.authorization ?? '').replace('Bearer ', ''), liveKitConfig().apiSecret) as { video: Record<string, unknown> }).video; } catch { res.writeHead(401).end('{}'); return; }
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        calls.push({ method, body, grant });
        if (method === 'StartRoomCompositeEgress') {
          if (failNextStart) { failNextStart = false; res.writeHead(503).end('{"msg":"no egress available"}'); return; }
          const out = (body.file_outputs as Array<{ filepath: string; s3: { access_key: string; secret: string; bucket: string; endpoint: string } }>)[0]!;
          const client = new S3Client({ endpoint: out.s3.endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: out.s3.access_key, secretAccessKey: out.s3.secret } });
          await client.send(new PutObjectCommand({ Bucket: out.s3.bucket, Key: out.filepath, Body: MP4 }));
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ egress_id: `EG_${calls.length}`, room_name: body.room_name, status: 'EGRESS_STARTING' }));
          return;
        }
        if (method === 'StopEgress') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ egress_id: body.egress_id, status: 1 })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      })());
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
    process.env.LIVEKIT_HTTP_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

    const pgBase = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev' };
    adminPool = new pg.Pool({ ...pgBase, user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    appPool = new pg.Pool({ ...pgBase, user: process.env.PGUSER || 'hrvo_app', password: process.env.PGPASSWORD || 'hrvo_app_pass' });
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Rec Ltd', 'rec-e2e'), ($2, 'Other Ltd', 'rec-other-e2e')`, [ORG, OTHER]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status, mfa_enabled, mfa_secret) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8)`,
        [u.id, ORG, u.email, u.name, u.role, hash, u.mfa, u.mfa ? SECRET : null]);
    }
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD, ...(U[who].mfa ? { totpCode: await freshCode(SECRET) } : {}) }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
      assert.ok(tokens[who], `login ${who}`);
    }
    meeting = await ok(await api('host', '/meetings', { method: 'POST', body: { type: 'INSTANT', title: 'Quarterly review', attendeeIds: [U.a.id, U.b.id, U.c.id], lobby: true, sendInvites: false } }), 201, MeetingSchema);
    roomName = (await adminPool.query(`SELECT livekit_room_name FROM meetings WHERE id = $1`, [meeting.id])).rows[0].livekit_room_name;
  });

  after(async () => {
    for (const s of sockets) s.disconnect();
    await app?.close();
    await new Promise((r) => fake?.close(r));
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.end();
    await appPool.end();
  });

  it('is off by default; only an admin turns it on (audited)', async () => {
    await joined('host');
    await joined('a');
    assert.equal((await ok(await api('host', `/meetings/${meeting.id}`), 200, MeetingSchema)).canRecord, false);
    assert.equal((await api('host', `/meetings/${meeting.id}/recordings`, { method: 'POST' })).status, 403);
    assert.equal((await api('host', '/admin/recording', { method: 'PUT', body: { enabled: true } })).status, 403);
    assert.deepEqual(await ok(await api('admin', '/admin/recording'), 200), { enabled: false });
    assert.equal((await api('admin', '/admin/recording', { method: 'PUT', body: { enabled: 'yes' } })).status, 400);
    assert.deepEqual(await ok(await api('admin', '/admin/recording', { method: 'PUT', body: { enabled: true } }), 200), { enabled: true });
    assert.equal(await audit('RECORDING_SETTINGS_UPDATED'), 1);
    const m = await ok(await api('host', `/meetings/${meeting.id}`), 200, MeetingSchema);
    assert.equal(m.canRecord, true);
    assert.equal(m.recording, null);
    assert.equal((await ok(await api('a', `/meetings/${meeting.id}`), 200, MeetingSchema)).canRecord, false, 'attendees cannot record');
  });

  it('retention for recordings is a data type of its own (7..3650 days, default 90)', async () => {
    const r = await ok<{ recordingsDays: number; notAvailable: string[] }>(await api('admin', '/admin/retention'), 200);
    assert.equal(r.recordingsDays, 90);
    assert.ok(!r.notAvailable.includes('Meeting recordings'));
    assert.equal((await api('admin', '/admin/retention', { method: 'PUT', body: { presenceDays: 90, notificationsDays: 365, recordingsDays: 3 } })).status, 400);
    assert.equal((await ok<{ recordingsDays: number }>(await api('admin', '/admin/retention', { method: 'PUT', body: { presenceDays: 90, notificationsDays: 365, recordingsDays: 30 } }), 200)).recordingsDays, 30);
  });

  let rec: Recording;
  it('a request asks everyone in the call; nothing is recorded until all agree', async () => {
    assert.equal((await api('a', `/meetings/${meeting.id}/recordings`, { method: 'POST' })).status, 403, 'an attendee cannot start');
    const s = io(base, { transports: ['websocket'], reconnection: false, auth: { token: tokens.a, purpose: 'office' } });
    sockets.push(s);
    await new Promise<void>((res, rej) => { s.once('connect', () => res()); s.once('connect_error', rej); });
    const asked = new Promise<{ recordingId: string }>((res) => s.once('meeting:recording-consent', res));
    rec = await ok(await api('host', `/meetings/${meeting.id}/recordings`, { method: 'POST' }), 201, RecordingSchema);
    assert.equal(rec.status, 'CONSENT');
    assert.deepEqual(rec.waitingFor.map((p) => p.id), [U.a.id], 'the host asked, so only Anna is waiting');
    assert.equal((await asked).recordingId, rec.id);
    assert.equal((await api('host', `/meetings/${meeting.id}/recordings`, { method: 'POST' })).status, 409, 'one at a time');
    assert.equal(calls.filter((c) => c.method === 'StartRoomCompositeEgress').length, 0, 'Egress not started yet');
    const banner = await ok(await api('a', `/meetings/${meeting.id}`), 200, MeetingSchema);
    assert.equal(banner.recording?.status, 'CONSENT');
    assert.equal(banner.recording?.myConsent, null);
    assert.equal((await consent('a', rec.id, true, 'v0.1')).status, 409, 'the current notice must have been shown');
    assert.equal((await api('b', `/recordings/${rec.id}`)).status, 200, 'an invitee at the join gate may read what they are asked');
  });

  it('a person who is not in the call is asked at the door, not counted until they agree', async () => {
    const j = await ok(await api('b', `/meetings/${meeting.id}/join`, { method: 'POST' }), 200, JoinResultSchema);
    assert.equal(j.status, 'CONSENT_REQUIRED');
    assert.equal(j.status === 'CONSENT_REQUIRED' && j.recordingId, rec.id);
  });

  it('the last yes starts Egress with a record-only token into the staging key', async () => {
    const r = await ok(await consent('a', rec.id, true), 200, RecordingSchema);
    assert.equal(r.status, 'RECORDING');
    const start = calls.find((c) => c.method === 'StartRoomCompositeEgress')!;
    assert.equal(start.grant.roomRecord, true);
    assert.equal(start.grant.roomAdmin, undefined, 'no admin rights for recording');
    assert.equal(start.body.room_name, roomName);
    const out = (start.body.file_outputs as Array<{ filepath: string; file_type: string }>)[0]!;
    assert.equal(out.file_type, 'MP4');
    assert.equal(out.filepath, `_recordings_staging/${ORG}/${rec.id}.mp4`, 'the top-level staging prefix the upload-only key is limited to');
    const db = await row(rec.id);
    assert.ok(db.egress_id && db.started_at);
    assert.equal((await ok(await api('host', `/meetings/${meeting.id}`), 200, MeetingSchema)).recording?.status, 'RECORDING', 'the banner shows recording');
    assert.equal(await audit('RECORDING_STARTED'), 1);
  });

  it('late joiners must agree before getting a token; a stale token is thrown out', async () => {
    assert.equal((await ok(await api('b', `/meetings/${meeting.id}/join`, { method: 'POST' }), 200, JoinResultSchema)).status, 'CONSENT_REQUIRED');
    await ok(await consent('b', rec.id, true), 200, RecordingSchema);
    assert.equal((await ok(await api('b', `/meetings/${meeting.id}/join`, { method: 'POST' }), 200, JoinResultSchema)).status, 'READY');
    await joined('b');
    assert.ok(!calls.some((c) => c.method === 'RemoveParticipant' && c.body.identity === U.b.id));
    // Cleo got a token earlier and connects without having agreed.
    await joined('c');
    const removed = calls.find((c) => c.method === 'RemoveParticipant' && c.body.identity === U.c.id);
    assert.ok(removed, 'Cleo is removed from the LiveKit room');
    assert.equal(removed!.body.room, roomName);
    await left('c');
  });

  it('stopping hands the file to processing: encrypted at rest, staging deleted, fingerprinted', async () => {
    assert.equal((await api('a', `/recordings/${rec.id}/stop`, { method: 'POST' })).status, 403);
    const stopped = await ok(await api('host', `/recordings/${rec.id}/stop`, { method: 'POST' }), 200, RecordingSchema);
    assert.equal(stopped.status, 'PROCESSING');
    assert.ok(calls.some((c) => c.method === 'StopEgress'));
    const db0 = await row(rec.id);
    await egressEnded(db0.egress_id);
    const db = await until(() => row(rec.id), (r) => r.status === 'READY');
    assert.equal(db.status, 'READY');
    assert.equal(db.duration_seconds, 61);
    assert.equal(db.sha256, createHash('sha256').update(MP4).digest('hex'));
    assert.equal(Number(db.size_bytes), MP4.length);
    assert.equal(await exists(`_recordings_staging/${ORG}/${rec.id}.mp4`), false, 'the plaintext staging copy is gone');
    const stored = Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: db.storage_key }))).Body!.transformToByteArray());
    assert.equal(stored.length, MP4.length);
    assert.ok(!stored.subarray(0, 64).equals(MP4.subarray(0, 64)), 'stored encrypted');
    assert.ok(!stored.includes(Buffer.from('ftypmp42')));
    const days = Math.round((db.expires_at.getTime() - db.ended_at.getTime()) / 86_400_000);
    assert.equal(days, 30, 'kept for the organisation retention');
    // A repeated webhook does nothing.
    await egressEnded(db0.egress_id);
    assert.equal((await row(rec.id)).status, 'READY');
  });

  it('host, co-hosts and recorded people may watch (audited); others may not', async () => {
    const res = await api('a', `/recordings/${rec.id}/content`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(MP4), 'decrypts to the original');
    assert.equal((await api('host', `/recordings/${rec.id}/content`)).status, 200);
    assert.equal((await api('c', `/recordings/${rec.id}/content`)).status, 404, 'Cleo was never recorded');
    assert.equal(await audit('RECORDING_VIEWED'), 2);
    const list = await ok(await api('c', `/meetings/${meeting.id}/recordings`), 200, RecordingListSchema);
    assert.equal(list.items.length, 0, 'not listed for Cleo');
    const mine = await ok(await api('a', `/meetings/${meeting.id}/recordings`), 200, RecordingListSchema);
    assert.equal(mine.items[0]!.canWatch, true);
    assert.equal(mine.items[0]!.canDelete, false);
  });

  it('one "no" means nothing is recorded; the consent log keeps every answer', async () => {
    const r2 = await ok(await api('host', `/meetings/${meeting.id}/recordings`, { method: 'POST' }), 201, RecordingSchema);
    assert.deepEqual(new Set(r2.waitingFor.map((p) => p.id)), new Set([U.a.id, U.b.id]));
    await ok(await consent('a', r2.id, true), 200, RecordingSchema);
    const refused = await ok(await consent('b', r2.id, false), 200, RecordingSchema);
    assert.equal(refused.status, 'CANCELLED');
    assert.match(refused.detail ?? '', /Ben B declined/);
    assert.equal(calls.filter((c) => c.method === 'StartRoomCompositeEgress').length, 1, 'never started');
    const log = await adminPool.query(`SELECT user_id, granted, notice_version, ip FROM recording_consents WHERE recording_id = $1 ORDER BY at, id`, [r2.id]);
    assert.deepEqual(log.rows.map((x) => [x.user_id, x.granted]), [[U.host.id, true], [U.a.id, true], [U.b.id, false]]);
    assert.ok(log.rows.every((x) => x.notice_version === NOTICE && x.ip));
  });

  it('silence for two minutes cancels; the maintenance job tidies up', async () => {
    const r3 = await ok(await api('host', `/meetings/${meeting.id}/recordings`, { method: 'POST' }), 201, RecordingSchema);
    await adminPool.query(`UPDATE meeting_recordings SET consent_deadline = now() - interval '1 second' WHERE id = $1`, [r3.id]);
    const out = await app.get(RecordingsService).maintenance();
    assert.ok(out.expired >= 1);
    const db = await row(r3.id);
    assert.equal(db.status, 'CANCELLED');
    assert.match(db.detail, /not everyone answered/);
  });

  it('withdrawing consent while recording stops it; a failed Egress stores no error text', async () => {
    const r4 = await ok(await api('host', `/meetings/${meeting.id}/recordings`, { method: 'POST' }), 201, RecordingSchema);
    await ok(await consent('a', r4.id, true), 200, RecordingSchema);
    assert.equal((await ok(await consent('b', r4.id, true), 200, RecordingSchema)).status, 'RECORDING');
    const w = await ok(await consent('b', r4.id, false), 200, RecordingSchema);
    assert.equal(w.status, 'PROCESSING');
    assert.match(w.detail ?? '', /withdrew consent/);
    await egressEnded((await row(r4.id)).egress_id, 'EGRESS_FAILED', 0);
    const db = await row(r4.id);
    assert.equal(db.status, 'FAILED');
    assert.ok(!/AKIA|s3/i.test(db.detail ?? ''), 'LiveKit error text is not stored');
    // Egress unavailable at start: FAILED, not stuck.
    failNextStart = true;
    const r5 = await ok(await api('host', `/meetings/${meeting.id}/recordings`, { method: 'POST' }), 201, RecordingSchema);
    await ok(await consent('a', r5.id, true), 200, RecordingSchema);
    const f = await ok(await consent('b', r5.id, true), 200, RecordingSchema);
    assert.equal(f.status, 'FAILED');
    assert.match(f.detail ?? '', /could not start/);
  });

  it('a recording past its retention is crypto-shredded; the host can delete one earlier', async () => {
    const before = await row(rec.id);
    await adminPool.query(`UPDATE meeting_recordings SET expires_at = now() - interval '1 minute' WHERE id = $1`, [rec.id]);
    const out = await app.get(RecordingsService).maintenance();
    assert.equal(out.shredded, 1);
    const db = await row(rec.id);
    assert.equal(db.status, 'DELETED');
    assert.equal(db.dek_wrapped, null);
    assert.equal(await exists(before.storage_key), false);
    assert.equal((await api('host', `/recordings/${rec.id}/content`)).status, 409);
    assert.equal(await audit('RECORDING_EXPIRED'), 1);
    const failed = (await adminPool.query(`SELECT id FROM meeting_recordings WHERE meeting_id = $1 AND status = 'FAILED' LIMIT 1`, [meeting.id])).rows[0].id;
    assert.equal((await api('a', `/recordings/${failed}`, { method: 'DELETE' })).status, 403);
    assert.equal((await ok(await api('host', `/recordings/${failed}`, { method: 'DELETE' }), 200, RecordingSchema)).status, 'DELETED');
  });

  it('RLS: another organisation sees nothing; the app cannot delete recordings or edit the consent log', async () => {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [OTHER]);
      assert.equal((await c.query(`SELECT 1 FROM meeting_recordings`)).rowCount, 0);
      assert.equal((await c.query(`SELECT 1 FROM recording_consents`)).rowCount, 0);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
      assert.ok((await c.query(`SELECT 1 FROM recording_consents`)).rowCount! > 3);
      await assert.rejects(c.query(`UPDATE recording_consents SET granted = true`), /permission denied/);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
      await assert.rejects(c.query(`DELETE FROM meeting_recordings`), /permission denied/);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [OTHER]);
      await assert.rejects(c.query(`INSERT INTO recording_consents (org_id, recording_id, user_id, granted, notice_version) VALUES ($1, $2, $3, true, 'v1')`, [ORG, rec.id, U.a.id]), /row-level security/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });
});
