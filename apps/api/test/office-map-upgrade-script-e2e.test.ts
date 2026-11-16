/**
 * scripts/office-map-upgrade.ts (ADR 055) run for real against the API, with the prompts answered
 * by the test: a dry run changes nothing; the wrong person, the wrong organisation, a wrong
 * password, a missing confirmation and a customised map all stop it; an apply writes a backup,
 * upgrades through PUT /office/map and verifies; a rollback puts the original back. Passwords and
 * tokens never reach the output.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { syncLayout } from '../src/office/office-store.ts';
import { freshCode } from './support/totp.ts';
import { resetOrgs } from './support/reset-orgs.ts';
import { defaultOffice, OfficeDefinitionSchema } from '../../../packages/shared/src/office/index.ts';
import type { OfficeDefinition } from '../../../packages/shared/src/office/index.ts';
import { CAMPUS_V1_FINGERPRINT, campusV1Office, fingerprint, identifyStoredMap, LEGACY_MAP_FINGERPRINT, objectsNotCarried, originalOffice, run } from '../../../scripts/office-map-upgrade.ts';
import type { Io } from '../../../scripts/office-map-upgrade.ts';

const ORG = 'f2f30000-0000-4000-8000-000000000001';
const ORG_B = 'f2f30000-0000-4000-8000-000000000002';
const PORT = 3115;
const PASSWORD = 'ComplexPassword123!';
const SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRL';
const EMP = { id: 'f2f30000-0000-4000-8000-0000000000e1', email: 'emp@mapscript.test' };
const BOTH = 'both@mapscript.test';
/** One administrator per run: a 2FA code works once per person, so nobody has to wait for the next one. */
const admin = (n: number) => ({ id: `f2f30000-0000-4000-8000-0000000000a${n.toString(16)}`, email: `admin${n}@mapscript.test`, secret: `${SECRET}${'ABCDEFGHIJK'[n]}` });

describe('Office map upgrade script (ADR 055)', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  let backups: string;
  const base = `http://localhost:${PORT}`;

  /** Runs the script with these answers, in order; returns the exit code and everything it printed. */
  async function script(args: string[], answers: Array<string | (() => Promise<string>)>): Promise<{ code: number; out: string; asked: string[] }> {
    const lines: string[] = [];
    const asked: string[] = [];
    const next = async (q: string) => { asked.push(q); const a = answers.shift(); assert.ok(a !== undefined, `unexpected question: ${q}`); return typeof a === 'string' ? a : await a(); };
    const io: Io = { ask: next, askHidden: next, log: (l) => lines.push(l) };
    const code = await run([base, ...args, '--backup-dir', backups], io);
    return { code, out: [...asked, ...lines].join('\n'), asked };
  }
  const login = (n: number) => [admin(n).email, PASSWORD, () => freshCode(admin(n).secret)];
  const office = async (): Promise<{ version: number; def: OfficeDefinition }> => {
    const r = await adminPool.query<{ version: number; map_json: unknown }>(`SELECT version, map_json FROM offices WHERE org_id = $1`, [ORG]);
    return { version: r.rows[0]!.version, def: OfficeDefinitionSchema.parse(r.rows[0]!.map_json) };
  };
  const state = async () => ({
    rooms: (await adminPool.query(`SELECT id, map_object_id, name, type, capacity, access_mode, password_hash, bounds FROM rooms WHERE org_id = $1 AND map_object_id <= 8 ORDER BY map_object_id`, [ORG])).rows,
    desks: (await adminPool.query(`SELECT id, map_object_id, label, assigned_user_id FROM desks WHERE org_id = $1 ORDER BY map_object_id`, [ORG])).rows,
    invites: (await adminPool.query(`SELECT room_id, user_id FROM room_invites WHERE org_id = $1 ORDER BY room_id, user_id`, [ORG])).rows,
  });

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    backups = await mkdtemp(join(tmpdir(), 'hrvo-map-backups-'));
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await resetOrgs(adminPool, [ORG, ORG_B]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Map Script Ltd', 'mapscript-a'), ($2, 'Other Workspace', 'mapscript-b')`, [ORG, ORG_B]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (let n = 0; n < 11; n += 1) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status, mfa_enabled, mfa_secret, email_verified_at) VALUES ($1, $2, $3, $4, 'ADMIN', $5, 'ACTIVE', true, $6, now())`, [admin(n).id, ORG, admin(n).email, `Admin ${n}`, hash, admin(n).secret]);
    }
    await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status, email_verified_at) VALUES ($1, $2, $3, 'Eve Script', 'EMPLOYEE', $4, 'ACTIVE', now())`, [EMP.id, ORG, EMP.email, hash]);
    // One address in two workspaces, same password: the server asks which workspace is meant.
    await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status, email_verified_at) VALUES ('f2f30000-0000-4000-8000-0000000000b1', $1, $3, 'Both A', 'EMPLOYEE', $4, 'ACTIVE', now()), ('f2f30000-0000-4000-8000-0000000000b2', $2, $3, 'Both B', 'EMPLOYEE', $4, 'ACTIVE', now())`, [ORG, ORG_B, BOTH, hash]);
    const original = originalOffice();
    const row = await adminPool.query<{ id: string }>(`INSERT INTO offices (org_id, name, map_json) VALUES ($1, $2, $3) RETURNING id`, [ORG, original.name, JSON.stringify(original)]);
    const c = await adminPool.connect();
    try { await syncLayout(c, ORG, row.rows[0]!.id, original); } finally { c.release(); }
    // The workspace has been used: a desk is taken, a room is invite-only with a guest, another has a password.
    await adminPool.query(`UPDATE desks SET assigned_user_id = $2 WHERE org_id = $1 AND label = 'Desk B3'`, [ORG, EMP.id]);
    await adminPool.query(`UPDATE rooms SET access_mode = 'INVITE', capacity = 10 WHERE org_id = $1 AND name = 'Board room'`, [ORG]);
    await adminPool.query(`INSERT INTO room_invites (org_id, room_id, user_id) SELECT $1, id, $2 FROM rooms WHERE org_id = $1 AND name = 'Board room'`, [ORG, EMP.id]);
    await adminPool.query(`UPDATE rooms SET access_mode = 'PASSWORD', password_hash = $2 WHERE org_id = $1 AND name = 'Focus room'`, [ORG, hash]);
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
  });

  after(async () => {
    await app?.close();
    await resetOrgs(adminPool, [ORG, ORG_B]);
    await adminPool.end();
    await rm(backups, { recursive: true, force: true });
  });

  it('recognises the original map by its recorded fingerprint, whatever the key order, and nothing else', () => {
    const original = originalOffice();
    assert.equal(fingerprint(original), LEGACY_MAP_FINGERPRINT);
    const reversed = JSON.parse(JSON.stringify(original), (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v)) as OfficeDefinition;
    assert.equal(fingerprint(reversed), LEGACY_MAP_FINGERPRINT);
    assert.equal(identifyStoredMap(original), 'original');
    assert.equal(identifyStoredMap(OfficeDefinitionSchema.parse(defaultOffice())), 'campus');
    // ADR 063: campus v1 (before the pool and the pond) is recognised by its recorded fingerprint and by derivation.
    assert.equal(fingerprint(campusV1Office()), CAMPUS_V1_FINGERPRINT);
    assert.equal(identifyStoredMap(campusV1Office()), 'campus1');
    assert.deepEqual(objectsNotCarried(campusV1Office(), OfficeDefinitionSchema.parse(defaultOffice())), [], 'campus v2 carries every room and desk of campus v1');
    const edits: Array<(d: OfficeDefinition) => void> = [
      (d) => { d.name = 'Head office'; },
      (d) => { const l = d.floors[0]!.map.layers[2]!; if (l.type === 'objectgroup') l.objects[0]!.name = 'War room'; },
      (d) => { const l = d.floors[0]!.map.layers[3]!; if (l.type === 'objectgroup') l.objects[0]!.x += 32; },
      (d) => { const l = d.floors[0]!.map.layers[1]!; if (l.type === 'tilelayer') l.data[0] = 0; },
    ];
    for (const edit of edits) { const d = originalOffice(); edit(d); assert.equal(identifyStoredMap(d), 'customised'); }
    assert.deepEqual(objectsNotCarried(original, OfficeDefinitionSchema.parse(defaultOffice())), [], 'the campus map carries every original room and desk under the same id');
    const renumbered = OfficeDefinitionSchema.parse(defaultOffice());
    const desks = renumbered.floors[0]!.map.layers[3]!;
    if (desks.type === 'objectgroup') desks.objects[0]!.id = 900;
    assert.equal(objectsNotCarried(original, renumbered).length, 1);
  });

  it('a dry run reports and changes nothing; 2FA is asked for only when the server wants it; no password or token is printed', async () => {
    const r = await script(['--dry-run', '--org', ORG.slice(0, 8)], login(0));
    assert.equal(r.code, 0, r.out);
    assert.equal(r.asked.length, 3);
    for (const text of ['Admin 0 <admin0@mapscript.test>, role ADMIN', ORG, 'org.manage granted', '60 x 40; 8 rooms, 20 desks (1 assigned)', '100 x 40; 11 rooms, 20 desks', 'Garden, Café, Arcade', `${LEGACY_MAP_FINGERPRINT}  ->  MATCH`, 'the unmodified original 60 x 40 map', 'ELIGIBLE', 'Dry run: nothing was changed.']) assert.ok(r.out.includes(text), `${text}\n${r.out}`);
    assert.ok(!r.out.includes(PASSWORD) && !/eyJ[A-Za-z0-9_-]{10,}/.test(r.out), 'no password, no token');
    assert.equal((await office()).version, 1);
    assert.deepEqual(await readdir(backups), []);
    const audit = await adminPool.query(`SELECT 1 FROM audit_logs WHERE org_id = $1 AND action = 'OFFICE_MAP_REPLACED'`, [ORG]);
    assert.equal(audit.rows.length, 0);
    const open = await adminPool.query(`SELECT 1 FROM auth_sessions WHERE user_id = $1 AND NOT is_revoked`, [admin(0).id]);
    assert.equal(open.rows.length, 0, 'the session the run opened is closed');
  });

  it('stops for a wrong password, a person without org.manage, another organisation, and a missing confirmation', async () => {
    const wrong = await script(['--apply'], [admin(1).email, 'not-the-password']);
    assert.equal(wrong.code, 1);
    assert.match(wrong.out, /STOP: sign-in refused \(401\): Invalid email or password/);
    assert.ok(!wrong.out.includes('not-the-password'));
    const emp = await script(['--apply'], [EMP.email, PASSWORD]);
    assert.equal(emp.code, 1);
    assert.match(emp.out, /org\.manage NOT granted[\s\S]*STOP: this account may not change the office/);
    const otherOrg = await script(['--apply', '--org', 'aaaaaaaa'], login(1));
    assert.equal(otherOrg.code, 1);
    assert.match(otherOrg.out, /STOP: this session is in organisation .* wrong workspace/);
    const unconfirmed = await script(['--apply'], [...login(2), 'yes']);
    assert.equal(unconfirmed.code, 1);
    assert.match(unconfirmed.out, /STOP: not confirmed/);
    assert.equal((await script(['--rollback'], login(3))).code, 1, 'nothing to roll back yet');
    assert.equal((await office()).version, 1);
    assert.deepEqual(await readdir(backups), []);
  });

  it('asks which workspace when the address belongs to several, and signs in to the one chosen', async () => {
    const r = await script(['--dry-run'], [BOTH, PASSWORD, '1']);
    assert.match(r.out, /1\. (Map Script Ltd \(mapscript-a\)|Other Workspace \(mapscript-b\))/);
    assert.match(r.out, /2\. (Map Script Ltd \(mapscript-a\)|Other Workspace \(mapscript-b\))/);
    const chosen = /1\. Map Script Ltd/.test(r.out) ? ORG : ORG_B;
    assert.ok(r.out.includes(`Organisation:      ${chosen}`), r.out);
    assert.equal(r.code, 1, 'an employee, so it stops');
    const named = await script(['--dry-run', '--workspace', 'mapscript-b'], [BOTH, PASSWORD]);
    assert.ok(named.out.includes(`Organisation:      ${ORG_B}`), named.out);
  });

  it('apply: backup, typed confirmation, upgrade through the API, verified; then nothing to do; rollback goes back one version at a time', async () => {
    const was = await state();
    const r = await script(['--apply'], [...login(4), `UPGRADE ${ORG.slice(0, 8)}`]);
    assert.equal(r.code, 0, r.out);
    assert.ok(!r.out.includes('FAIL'), r.out);
    for (const text of ['ok   map dimensions 100 x 40', 'ok   the 8 existing rooms kept', 'ok   Garden present', 'ok   Café present', 'ok   Arcade present', 'ok   the 20 desks kept', 'ok   the 1 desk assignments are unchanged', 'ok   room invitations are unchanged', 'ok   office version 1 -> 2', 'Upgraded.']) assert.ok(r.out.includes(text), `${text}\n${r.out}`);
    const now = await office();
    assert.equal(now.version, 2);
    assert.equal(identifyStoredMap(now.def), 'campus');
    assert.deepEqual(await state(), was, 'every original room, desk, password, invitation and assignment row is untouched');
    assert.equal((await adminPool.query(`SELECT 1 FROM rooms WHERE org_id = $1`, [ORG])).rows.length, 11);
    const files = await readdir(backups);
    assert.equal(files.length, 1);
    assert.match(files[0]!, new RegExp(`^office-map-${ORG}-v1-\\d{8}T\\d{6}Z\\.json$`));
    assert.equal((await stat(join(backups, files[0]!))).mode & 0o777, 0o600);
    const backup = JSON.parse(await readFile(join(backups, files[0]!), 'utf8')) as { fingerprint: string; definition: unknown; rooms: unknown[]; desks: Array<{ label: string; assignee: { id: string } | null }>; invites: Record<string, string[]> };
    assert.equal(backup.fingerprint, LEGACY_MAP_FINGERPRINT);
    assert.equal(fingerprint(backup.definition), LEGACY_MAP_FINGERPRINT);
    assert.equal(backup.desks.find((d) => d.label === 'Desk B3')!.assignee!.id, EMP.id);
    assert.deepEqual(Object.values(backup.invites).flat(), [EMP.id]);
    assert.ok(!JSON.stringify(backup).includes('argon2'), 'no password hash in the backup');
    const audit = await adminPool.query<{ actor_id: string }>(`SELECT actor_id FROM audit_logs WHERE org_id = $1 AND action = 'OFFICE_MAP_REPLACED'`, [ORG]);
    assert.deepEqual(audit.rows.map((a) => a.actor_id), [admin(4).id], 'audited once, as the person who ran it');

    const again = await script(['--apply'], login(5));
    assert.equal(again.code, 1);
    assert.match(again.out, /STOP: already upgraded/);
    assert.equal((await office()).version, 2);

    // ADR 063: one step back is campus v1 (the pool and the pond go; the campus rooms stay).
    const back = await script(['--rollback'], [...login(6), `ROLLBACK ${ORG.slice(0, 8)}`]);
    assert.equal(back.code, 0, back.out);
    assert.ok(!back.out.includes('FAIL'), back.out);
    assert.match(back.out, /Rolled back to campus v1/);
    assert.equal((await office()).version, 3);
    assert.equal(identifyStoredMap((await office()).def), 'campus1');
    assert.deepEqual(await state(), was);
    // Campus v1 upgrades to v2 the same way, keeping every desk assignment.
    const up = await script(['--apply'], [...login(8), `UPGRADE ${ORG.slice(0, 8)}`]);
    assert.equal(up.code, 0, up.out);
    assert.ok(up.out.includes('campus v1 to the current campus map') && up.out.includes('ok   the 1 desk assignments are unchanged') && !up.out.includes('FAIL'), up.out);
    assert.equal(identifyStoredMap((await office()).def), 'campus');
    assert.deepEqual(await state(), was);
    // And back down: v2 -> v1 -> the original.
    for (const [n, to] of [[9, 'campus1'], [10, 'original']] as const) {
      const r2 = await script(['--rollback'], [...login(n), `ROLLBACK ${ORG.slice(0, 8)}`]);
      assert.equal(r2.code, 0, r2.out);
      assert.equal(identifyStoredMap((await office()).def), to);
    }
    assert.equal((await office()).version, 6);
    assert.deepEqual(await state(), was);
  });

  it('never overwrites a customised map', async () => {
    const custom = originalOffice();
    const rooms = custom.floors[0]!.map.layers[2]!;
    if (rooms.type === 'objectgroup') rooms.objects[7]!.name = 'Town hall';
    const row = await adminPool.query<{ id: string }>(`UPDATE offices SET map_json = $2 WHERE org_id = $1 RETURNING id`, [ORG, JSON.stringify(custom)]);
    const c = await adminPool.connect();
    try { await syncLayout(c, ORG, row.rows[0]!.id, custom); } finally { c.release(); }
    const r = await script(['--apply'], login(7));
    assert.equal(r.code, 1);
    assert.match(r.out, /CUSTOMISED[\s\S]*STOP: the stored map is neither the unmodified original nor campus v1: not overwriting a customised map/);
    assert.equal(identifyStoredMap((await office()).def), 'customised');
    assert.equal((await office()).version, 6);
  });
});
