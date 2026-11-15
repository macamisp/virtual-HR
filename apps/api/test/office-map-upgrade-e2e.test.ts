/**
 * Upgrading an organisation's stored office map to the campus map (ADR 055) through the existing
 * admin route (PUT /office/map), exactly as production would: the organisation starts on the
 * original 60 x 40 map, people have desks, an admin has customised a room; after the upgrade every
 * room and desk keeps its database row (id), its assignment, its access mode, capacity and
 * invites; three campus areas are added; the change is audited.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { syncLayout } from '../src/office/office-store.ts';
import { freshCode } from './support/totp.ts';
import { defaultOffice, objectLayer, OfficeDefinitionSchema, OfficeSnapshotSchema, tileLayer } from '../../../packages/shared/src/office/index.ts';
import type { OfficeDefinition, OfficeMap, OfficeSnapshot } from '../../../packages/shared/src/office/index.ts';
import { resetOrgs } from './support/reset-orgs.ts';

const ORG = 'f2f20000-0000-4000-8000-000000000001';
const PORT = 3093;
const PASSWORD = 'ComplexPassword123!';
const SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const ADMIN = { id: 'f2f20000-0000-4000-8000-000000000011', email: 'admin@upgrade.test' };
const EMP = { id: 'f2f20000-0000-4000-8000-000000000012', email: 'emp@upgrade.test' };
const ORIGINAL_TILES = '79ae155066bb093d50c28af8833dd33115bd96d4558a57217b78376f2d4b4f16';

/** The original 60 x 40 office as stored by organisations created before ADR 055. */
function originalOffice(): OfficeDefinition {
  const def = defaultOffice();
  const m = def.floors[0]!.map;
  const W = m.width;
  const crop = (data: number[]) => { const out: number[] = []; for (let y = 0; y < m.height; y += 1) for (let x = 0; x < 60; x += 1) out.push(data[y * W + x]!); return out; };
  const layers = m.layers.map((l) => {
    if (l.type === 'tilelayer') {
      const data = crop(l.data);
      if (l.name === 'walls') for (const y of [33, 34, 35]) data[y * 60 + 59] = 1; // the Lounge wall, closed
      return { ...l, width: 60, data };
    }
    return { ...l, objects: l.objects.filter((o) => o.id <= 59) };
  });
  const map: OfficeMap = { ...m, width: 60, layers };
  return OfficeDefinitionSchema.parse({ ...def, floors: [{ ...def.floors[0]!, map }] });
}

describe('Office map upgrade to the campus (ADR 055)', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  const base = `http://localhost:${PORT}`;
  const tokens: Record<'admin' | 'emp', string> = { admin: '', emp: '' };
  const api = (who: 'admin' | 'emp', path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await resetOrgs(adminPool, [ORG]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Upgrade Ltd', 'upgrade-e2e')`, [ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status, mfa_enabled, mfa_secret) VALUES ($1, $2, $3, 'Ada Upgrade', 'ADMIN', $4, 'ACTIVE', true, $5)`, [ADMIN.id, ORG, ADMIN.email, hash, SECRET]);
    await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status) VALUES ($1, $2, $3, 'Eve Upgrade', 'EMPLOYEE', $4, 'ACTIVE')`, [EMP.id, ORG, EMP.email, hash]);
    // The organisation's office as it exists today: the original map, rooms and desks synced from it.
    const original = originalOffice();
    const office = await adminPool.query<{ id: string }>(`INSERT INTO offices (org_id, name, map_json) VALUES ($1, $2, $3) RETURNING id`, [ORG, original.name, JSON.stringify(original)]);
    const c = await adminPool.connect();
    try { await syncLayout(c, ORG, office.rows[0]!.id, original); } finally { c.release(); }
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    for (const [who, u] of [['admin', ADMIN], ['emp', EMP]] as const) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u.email, password: PASSWORD, ...(who === 'admin' ? { totpCode: await freshCode(SECRET) } : {}) }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
      assert.ok(tokens[who], `login ${who}`);
    }
  });

  after(async () => {
    await app?.close();
    await resetOrgs(adminPool, [ORG]);
    await adminPool.end();
  });

  it('the derived original map is the original office tile for tile', () => {
    const m = originalOffice().floors[0]!.map;
    const f = tileLayer(m, 'floor')!;
    const w = tileLayer(m, 'walls')!;
    const parts: string[] = [];
    for (let y = 0; y < 40; y += 1) for (let x = 0; x < 60; x += 1) { if (x === 59 && y >= 33 && y <= 35) continue; parts.push(`${f[y * 60 + x]}/${w[y * 60 + x]}`); }
    assert.equal(createHash('sha256').update(parts.join(',')).digest('hex'), ORIGINAL_TILES);
    assert.equal(['rooms', 'desks', 'furniture', 'spawn'].flatMap((l) => objectLayer(m, l)).length, 59);
  });

  it('replacing the map keeps every room and desk row, assignments, access, capacity and invites; adds the campus; audited', async () => {
    const before = OfficeSnapshotSchema.parse(await (await api('admin', '/office')).json()) as OfficeSnapshot;
    assert.equal(before.rooms.length, 8);
    assert.equal(before.office.version, 1);
    // People have desks; an admin has customised a room and its invites.
    const deskA1 = before.desks.find((d) => d.label === 'Desk A1')!;
    assert.equal((await api('emp', `/office/desks/${deskA1.id}/claim`, { method: 'POST' })).status, 201);
    const deskB3 = before.desks.find((d) => d.label === 'Desk B3')!;
    assert.equal((await api('admin', `/office/desks/${deskB3.id}/assignee`, { method: 'PUT', body: { userId: ADMIN.id } })).status, 200);
    const board = before.rooms.find((r) => r.name === 'Board room')!;
    assert.equal((await api('admin', `/office/rooms/${board.id}`, { method: 'PUT', body: { accessMode: 'INVITE', capacity: 10 } })).status, 200);
    assert.equal((await api('admin', `/office/rooms/${board.id}/invites`, { method: 'PUT', body: { userIds: [EMP.id] } })).status, 200);
    const settled = OfficeSnapshotSchema.parse(await (await api('admin', '/office')).json()) as OfficeSnapshot;

    // The upgrade, through the existing admin route.
    const res = await api('admin', '/office/map', { method: 'PUT', body: defaultOffice() });
    assert.equal(res.status, 200, await res.clone().text());
    const after = OfficeSnapshotSchema.parse(await res.json()) as OfficeSnapshot;
    assert.equal(after.office.version, 2);
    assert.equal(after.floors[0]!.map && (after.floors[0]!.map as OfficeMap).width, 100);
    assert.deepEqual(after.rooms.map((r) => r.name).sort(), [...settled.rooms.map((r) => r.name), 'Arcade', 'Café', 'Garden'].sort());
    // Same rows, same settings.
    for (const r of settled.rooms) {
      const a = after.rooms.find((x) => x.id === r.id);
      assert.ok(a, `room ${r.name} kept its row`);
      assert.deepEqual({ name: a.name, type: a.type, capacity: a.capacity, accessMode: a.accessMode, bounds: a.bounds }, { name: r.name, type: r.type, capacity: r.capacity, accessMode: r.accessMode, bounds: r.bounds });
    }
    assert.equal(after.rooms.find((r) => r.id === board.id)!.accessMode, 'INVITE');
    assert.equal(after.rooms.find((r) => r.id === board.id)!.capacity, 10);
    assert.deepEqual(after.desks.map((d) => [d.id, d.label, d.assignee?.id ?? null]), settled.desks.map((d) => [d.id, d.label, d.assignee?.id ?? null]), 'every desk keeps its row, label and person');
    assert.equal(after.desks.find((d) => d.label === 'Desk A1')!.assignee?.id, EMP.id);
    assert.equal(after.desks.find((d) => d.label === 'Desk B3')!.assignee?.id, ADMIN.id);
    const invites = await (await api('admin', `/office/rooms/${board.id}/invites`)).json() as { userIds: string[] };
    assert.deepEqual(invites.userIds, [EMP.id], 'invites kept');
    for (const name of ['Garden', 'Café', 'Arcade']) {
      const r = after.rooms.find((x) => x.name === name)!;
      assert.deepEqual({ type: r.type, accessMode: r.accessMode }, { type: 'OPEN', accessMode: 'OPEN' });
    }
    const audit = await adminPool.query(`SELECT action, after FROM audit_logs WHERE org_id = $1 AND action = 'OFFICE_MAP_REPLACED'`, [ORG]);
    assert.equal(audit.rows.length, 1, 'the upgrade is audited');
    // An employee cannot do it.
    assert.equal((await api('emp', '/office/map', { method: 'PUT', body: defaultOffice() })).status, 403);
  });
});
