/**
 * Avatar nudge end to end (ADR 058, FR-VO-016) over the real office socket: a nudge reaches only
 * the person nudged; Accept, Ignore, Cancel, expiry and leaving reach both people; it is refused
 * for yourself, someone far away, someone on Do not disturb or not looking at the office, a second
 * one while waiting, again within the cooldown, and beyond the per-minute limit; only the person
 * nudged can answer and only the sender can cancel; another organisation's people do not exist;
 * nothing is stored and attendance is never touched.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { io, type Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import type { JoinAck, MoveAck, NudgeAck, NudgeAnswerAck, NudgeClosedMessage, NudgeRequestMessage, RosterEntry, TeleportAck } from '../../../packages/shared/src/office/index.ts';
import { resetOrgs } from './support/reset-orgs.ts';

const ORG = 'f1f40000-0000-4000-8000-000000000001';
const OTHER = 'f1f40000-0000-4000-8000-000000000002';
const PORT = 3116;
const PASSWORD = 'ComplexPassword123!';
const U = {
  a: { id: 'f1f40000-0000-4000-8000-000000000011', org: ORG, email: 'ana@nudge.test', name: 'Ana Nudge' },
  b: { id: 'f1f40000-0000-4000-8000-000000000012', org: ORG, email: 'bo@nudge.test', name: 'Bo Nudge' },
  c: { id: 'f1f40000-0000-4000-8000-000000000013', org: ORG, email: 'cy@nudge.test', name: 'Cy Nudge' },
  d: { id: 'f1f40000-0000-4000-8000-000000000014', org: ORG, email: 'di@nudge.test', name: 'Di Nudge' },
  e: { id: 'f1f40000-0000-4000-8000-000000000015', org: ORG, email: 'ed@nudge.test', name: 'Ed Nudge' },
  o: { id: 'f1f40000-0000-4000-8000-000000000021', org: OTHER, email: 'oz@nudge-other.test', name: 'Oz Other' },
} as const;
type Who = keyof typeof U;
const COOLDOWN = 1500;
const TTL = 1200;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Avatar nudge over the office socket (ADR 058)', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  const base = `http://localhost:${PORT}`;
  const tokens = {} as Record<Who, string>;
  const sockets: Socket[] = [];

  async function connect(who: Who): Promise<Socket> {
    const s = io(base, { transports: ['websocket'], reconnection: false, auth: { token: tokens[who], purpose: 'office' } });
    sockets.push(s);
    await new Promise<void>((res, rej) => { s.once('connect', () => res()); s.once('connect_error', rej); });
    return s;
  }
  async function office(who: Who) {
    const s = await connect(who);
    const inbox = { requests: [] as NudgeRequestMessage[], closed: [] as NudgeClosedMessage[], presence: [] as RosterEntry[] };
    s.on('office:nudge-request', (m: NudgeRequestMessage) => inbox.requests.push(m));
    s.on('office:nudge-closed', (m: NudgeClosedMessage) => inbox.closed.push(m));
    s.on('office:presence', (m: RosterEntry) => inbox.presence.push(m));
    const join = (await s.emitWithAck('office:join', { positions: true })) as JoinAck;
    assert.ok(join.ok, `${who} joins`);
    const call = <T>(event: string, body: unknown = {}) => s.emitWithAck(event, body) as Promise<T>;
    return {
      s, inbox, join, call,
      nudge: (to: Who | string) => call<NudgeAck>('office:nudge', { to: to in U ? U[to as Who].id : to }),
      answer: (id: string, accept: boolean) => call<NudgeAnswerAck>('office:nudge-answer', { id, accept }),
      cancel: (id: string) => call<NudgeAnswerAck>('office:nudge-cancel', { id }),
    };
  }
  type Office = Awaited<ReturnType<typeof office>>;
  const api = (who: Who, path: string, body: unknown) => fetch(`${base}${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: JSON.stringify(body) });
  /** The outcome both people were told for this nudge. */
  const outcome = (o: Office, id: string) => o.inbox.closed.filter((c) => c.id === id).map((c) => c.outcome);

  let A: Office;
  let B: Office;
  let C: Office;
  let D: Office;
  let E: Office;
  let O: Office;

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    process.env.OFFICE_LEAVE_GRACE_MS = '1500';
    process.env.OFFICE_NUDGE_COOLDOWN_MS = String(COOLDOWN);
    process.env.OFFICE_NUDGE_TTL_MS = String(TTL);
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await resetOrgs(adminPool, [ORG, OTHER]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Nudge Ltd', 'nudge-e2e'), ($2, 'Nudge Other Ltd', 'nudge-other-e2e')`, [ORG, OTHER]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status) VALUES ($1, $2, $3, $4, 'EMPLOYEE', $5, 'ACTIVE')`, [u.id, u.org, u.email, u.name, hash]);
    }
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
      assert.ok(tokens[who], `login ${who}`);
    }
    A = await office('a');
    B = await office('b');
    C = await office('c');
    D = await office('d');
    E = await office('e');
    O = await office('o');
  });

  after(async () => {
    for (const s of sockets) s.disconnect();
    await app?.close();
    await resetOrgs(adminPool, [ORG, OTHER]);
    await adminPool.end();
    delete process.env.OFFICE_NUDGE_COOLDOWN_MS;
    delete process.env.OFFICE_NUDGE_TTL_MS;
  });

  it('the join acknowledgement carries the rules in force', () => {
    assert.deepEqual(A.join.ok && A.join.nudge, { reachPx: 160, cooldownMs: COOLDOWN, ttlMs: TTL });
  });

  it('a nudge reaches only the person nudged; only they can answer; Accept reaches both', async () => {
    const sent = await A.nudge('b');
    assert.ok(sent.ok, JSON.stringify(sent));
    assert.equal(sent.expiresInMs, TTL);
    await wait(150);
    assert.deepEqual(B.inbox.requests.map((r) => ({ id: r.id, from: r.from, fromName: r.fromName })), [{ id: sent.id, from: U.a.id, fromName: U.a.name }]);
    for (const other of [A, C, D, E, O]) assert.equal(other.inbox.requests.length, 0, 'nobody else is told');
    // Someone else cannot answer it, the person nudged cannot cancel it, another organisation cannot touch it.
    for (const [who, r] of [['c answers', await C.answer(sent.id, true)], ['b cancels', await B.cancel(sent.id)], ['a answers', await A.answer(sent.id, true)], ['o answers', await O.answer(sent.id, true)], ['o cancels', await O.cancel(sent.id)]] as const) {
      assert.deepEqual(r, { ok: false, error: 'That nudge is no longer open', code: 'NOT_OPEN' }, who);
    }
    assert.deepEqual(outcome(A, sent.id), []);
    assert.deepEqual(await B.answer(sent.id, true), { ok: true });
    await wait(150);
    assert.deepEqual(outcome(A, sent.id), ['accepted']);
    assert.deepEqual(outcome(B, sent.id), ['accepted']);
    assert.deepEqual(A.inbox.closed.at(-1), { id: sent.id, from: U.a.id, to: U.b.id, outcome: 'accepted' });
    for (const other of [C, D, E, O]) assert.equal(other.inbox.closed.length, 0, 'the outcome is between the two');
    // Answered once: a second answer finds nothing.
    assert.equal((await B.answer(sent.id, false)).ok, false);
    assert.deepEqual(outcome(A, sent.id), ['accepted']);
  });

  it('cooldown per person nudged; Ignore and Cancel reach both', async () => {
    const again = await A.nudge('b');
    assert.equal(!again.ok && again.code, 'COOLDOWN');
    assert.ok(!again.ok && again.retryInMs! > 0 && again.retryInMs! <= COOLDOWN);
    assert.equal(B.inbox.requests.length, 1, 'a refused nudge is not delivered');
    // Someone else can be nudged meanwhile; they ignore it.
    const toC = await A.nudge('c');
    assert.ok(toC.ok, JSON.stringify(toC));
    await wait(100);
    assert.deepEqual(await C.answer(toC.id, false), { ok: true });
    await wait(150);
    assert.deepEqual(outcome(A, toC.id), ['ignored']);
    assert.deepEqual(outcome(C, toC.id), ['ignored']);
    // After the cooldown the first person can be nudged again; the sender takes it back.
    await wait(COOLDOWN);
    const third = await A.nudge('b');
    assert.ok(third.ok, JSON.stringify(third));
    assert.deepEqual(await A.cancel(third.id), { ok: true });
    await wait(150);
    assert.deepEqual(outcome(A, third.id), ['cancelled']);
    assert.deepEqual(outcome(B, third.id), ['cancelled']);
    assert.equal((await B.answer(third.id, true)).ok, false, 'a cancelled nudge cannot be accepted');
  });

  it('one at a time; an unanswered nudge expires for both', async () => {
    const sent = await B.nudge('a');
    assert.ok(sent.ok, JSON.stringify(sent));
    const second = await B.nudge('c');
    assert.equal(!second.ok && second.code, 'PENDING');
    await wait(TTL + 400);
    assert.deepEqual(outcome(A, sent.id), ['expired']);
    assert.deepEqual(outcome(B, sent.id), ['expired']);
    assert.equal((await A.answer(sent.id, true)).ok, false, 'an expired nudge cannot be accepted');
  });

  it('refused: yourself, a stranger, another organisation, a bad body, before joining', async () => {
    const self = await C.nudge('c');
    assert.equal(!self.ok && self.code, 'SELF');
    const nobody = await C.nudge('f1f40000-0000-4000-8000-0000000000ff');
    assert.equal(!nobody.ok && nobody.code, 'NOT_FOUND');
    // Both ways across organisations: the other person does not exist, and hears nothing.
    const out = await C.nudge('o');
    const inn = await O.nudge('c');
    assert.deepEqual([!out.ok && out.code, !inn.ok && inn.code], ['NOT_FOUND', 'NOT_FOUND']);
    assert.equal(O.inbox.requests.length + O.inbox.closed.length, 0);
    assert.equal(C.inbox.requests.filter((r) => r.from === U.o.id).length, 0);
    for (const bad of [{}, { to: 'bo' }, { to: U.b.id, orgId: OTHER }, { to: U.b.id, from: U.a.id }]) {
      const r = await C.call<NudgeAck>('office:nudge', bad);
      assert.equal(!r.ok && r.code, 'BAD_REQUEST', JSON.stringify(bad));
    }
    assert.equal((await C.call<NudgeAnswerAck>('office:nudge-answer', { id: 'x', accept: true })).ok, false);
    const stranger = await connect('c');
    const r = (await stranger.emitWithAck('office:nudge', { to: U.b.id })) as NudgeAck;
    assert.equal(!r.ok && r.code, 'NOT_JOINED');
    stranger.disconnect();
  });

  it('Do not disturb and not looking at the office are respected', async () => {
    assert.equal((await api('b', '/office/me/status', { status: 'DND', message: '' })).status, 200);
    await wait(250);
    const dnd = await C.nudge('b');
    assert.equal(!dnd.ok && dnd.code, 'DND');
    assert.equal(B.inbox.requests.filter((r) => r.from === U.c.id).length, 0);
    assert.equal((await api('b', '/office/me/status', { status: 'AUTO', message: '' })).status, 200);
    await wait(250);
    // On another page: the office socket stays, but nobody would see the bell.
    await B.call('office:view', { visible: false, positions: false });
    const away = await C.nudge('b');
    assert.equal(!away.ok && away.code, 'AWAY');
    await B.call('office:view', { visible: true, positions: true });
    const ok = await C.nudge('b');
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.deepEqual(await B.answer(ok.id, true), { ok: true });
    // Someone on Do not disturb can still nudge others.
    assert.equal((await api('b', '/office/me/status', { status: 'DND', message: '' })).status, 200);
    await wait(250);
    const fromDnd = await B.nudge('c');
    assert.ok(fromDnd.ok, JSON.stringify(fromDnd));
    assert.deepEqual(await C.answer(fromDnd.id, false), { ok: true });
    assert.equal((await api('b', '/office/me/status', { status: 'AUTO', message: '' })).status, 200);
  });

  it('too far away is refused; walking back makes it possible', async () => {
    const start = D.join.ok ? D.join.self : { x: 0, y: 0 };
    // 198 px to the right in legal steps (the reach is 160 px).
    let last: MoveAck = { ok: true, roomId: null };
    for (let i = 1; i <= 11; i += 1) { await wait(100); last = await D.call<MoveAck>('office:move', { x: start.x + i * 18, y: start.y, dir: 0 }); assert.ok(last.ok, JSON.stringify(last)); }
    const far = await A.nudge('d');
    assert.equal(!far.ok && far.code, 'TOO_FAR');
    assert.equal(D.inbox.requests.length, 0);
    assert.ok((await D.call<TeleportAck>('office:teleport', { kind: 'user', userId: U.a.id })).ok);
    const near = await A.nudge('d');
    assert.ok(near.ok, JSON.stringify(near));
    assert.deepEqual(await D.answer(near.id, true), { ok: true });
  });

  it('spam: at most six nudges a minute from one person, whoever they go to', async () => {
    const targets: Who[] = ['a', 'b', 'c', 'd'];
    const answerers: Record<string, Office> = { a: A, b: B, c: C, d: D };
    for (let i = 0; i < 6; i += 1) {
      const to = targets[i % targets.length]!;
      if (i === targets.length) await wait(COOLDOWN); // the first targets come round again
      const r = await E.nudge(to);
      assert.ok(r.ok, `nudge ${i + 1}: ${JSON.stringify(r)}`);
      assert.deepEqual(await answerers[to]!.answer(r.id, false), { ok: true });
    }
    const seventh = await E.nudge('c');
    assert.equal(!seventh.ok && seventh.code, 'RATE_LIMITED');
    assert.ok(!seventh.ok && seventh.retryInMs! > 0 && seventh.retryInMs! <= 60_000);
  });

  it('leaving or losing the connection ends open nudges for the other person at once', async () => {
    // The sender drops.
    const d2 = await office('d');
    D.s.disconnect();
    const sent = await d2.nudge('b');
    assert.ok(sent.ok, JSON.stringify(sent));
    d2.s.disconnect();
    await wait(300);
    assert.deepEqual(outcome(B, sent.id), ['gone']);
    assert.equal((await B.answer(sent.id, true)).ok, false);
    // The person nudged leaves.
    const c2 = await office('c');
    C.s.disconnect();
    await wait(COOLDOWN);
    const toC = await A.nudge('c');
    assert.ok(toC.ok, JSON.stringify(toC));
    await c2.call('office:leave');
    await wait(300);
    assert.deepEqual(outcome(A, toC.id), ['gone']);
    // And the sender is free to nudge someone else straight away.
    const next = await A.nudge('b');
    assert.ok(next.ok, JSON.stringify(next));
    assert.deepEqual(await B.answer(next.id, true), { ok: true });
  });

  it('nothing is stored: no attendance, no audit entry, no row anywhere for a nudge', async () => {
    const sessions = await adminPool.query(`SELECT 1 FROM attendance_sessions WHERE org_id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    assert.equal(sessions.rows.length, 0);
    const audit = await adminPool.query<{ action: string }>(`SELECT DISTINCT action FROM audit_logs WHERE org_id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    assert.deepEqual(audit.rows.map((r) => r.action).filter((a) => /NUDGE/i.test(a)), []);
    // Nobody's status changed because of a nudge.
    const status = await adminPool.query<{ vo_status: string }>(`SELECT DISTINCT vo_status FROM users WHERE org_id = $1`, [ORG]);
    assert.deepEqual(status.rows.map((r) => r.vo_status), ['AUTO']);
  });
});
