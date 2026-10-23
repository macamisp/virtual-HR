/**
 * ADR 038: the Postgres deadlocks seen in CI, reproduced deterministically, and the lock order
 * that removes them (NFR-ACC-001..004 depend on attendance writes never being lost to one).
 *
 * Each scenario drives two or three real transactions into an exact interleaving: a step starts
 * only once the previous one is provably waiting on a lock held by a known backend
 * (pg_blocking_pids), so the outcome does not depend on timing. Before the fix every scenario
 * below ended in "deadlock detected" (40P01); after it, every transaction commits or fails for a
 * plain reason, and no conflict retry was needed to get there.
 */
import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { AttendanceService } from '../src/attendance/attendance.service.ts';
import { PostgresAttendanceRepository } from '../src/attendance/attendance-repository.ts';
import { appendAuditEntry } from '../src/common/audit-chain.ts';
import { lockOrgForWrite, lockUsersForWrite } from '../src/common/lock-order.ts';
import { conflictKind, conflictRetryStats, totalConflictRetries, withConflictRetry } from '../src/common/db-retry.ts';
import { DEFAULT_ATTENDANCE_CONFIG, type AttendanceSession, type HeartbeatPayload, SystemClock } from '../../../packages/shared/src/index.ts';

const conn = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev' };
const PREFIX = 'dea410c0-0000-4000-8000-0000000000';
const orgId = (n: number) => `${PREFIX}${String(n).padStart(2, '0')}`;
const userId = (n: number) => `${PREFIX}${String(50 + n).padStart(2, '0')}`;
const ORGS = Array.from({ length: 6 }, (_, i) => orgId(i + 1));

/** A promise whose state can be read without awaiting it. */
function track<T>(p: Promise<T>) {
  const t = { settled: false, value: undefined as T | undefined, error: undefined as unknown, promise: p };
  t.promise = p.then((v) => { t.settled = true; t.value = v; return v; }, (e: unknown) => { t.settled = true; t.error = e; throw e; });
  t.promise.catch(() => undefined);
  return t;
}

describe('Lock order: no deadlock between attendance, audit and parent-row writers (ADR 038)', { concurrency: false }, () => {
  let admin: pg.Pool;
  let app: pg.Pool;
  let repo: PostgresAttendanceRepository;
  let service: AttendanceService;
  const secrets = new Map<string, string>();
  let seq = 0;

  /** Waits until `pid` blocks some other backend, or the tracked work finishes. */
  async function untilBlockedBy(pid: number, work: { settled: boolean }): Promise<'blocked' | 'settled'> {
    for (let i = 0; i < 400; i += 1) {
      if (work.settled) return 'settled';
      const r = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [pid]);
      if (r.rows[0]!.n > 0) return 'blocked';
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`neither blocked by ${pid} nor finished within 10 s`);
  }
  /** Waits until backend `pid` is waiting on a lock, or the tracked work finishes. */
  async function untilWaiting(pid: number, work: { settled: boolean }): Promise<'waiting' | 'settled'> {
    for (let i = 0; i < 400; i += 1) {
      if (work.settled) return 'settled';
      const r = await admin.query<{ n: number }>(`SELECT cardinality(pg_blocking_pids($1))::int AS n`, [pid]);
      if (r.rows[0]!.n > 0) return 'waiting';
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`backend ${pid} neither waited nor finished within 10 s`);
  }

  async function client(pool: pg.Pool, org: string | null) {
    const c = await pool.connect();
    await c.query('BEGIN');
    if (org) await c.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
    const pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    return { c, pid };
  }

  async function heartbeat(org: string, user: string, serverTime = new Date()) {
    seq += 1;
    const sessionId = `lock-order-${org}`;
    const body: Omit<HeartbeatPayload, 'signature'> = { orgId: org, userId: user, sessionId, deviceId: 'lock-order', activeSeconds: 30, idleSeconds: 0, inCall: false, tabVisible: true, windowFocused: true, nonce: randomBytes(16).toString('hex'), sequenceNumber: seq };
    return await service.ingestHeartbeat({ ...body, signature: service.getValidator().signHeartbeat(body, secrets.get(org)!) }, serverTime);
  }

  /** A fresh organisation with one person who is clocked in (an open session with an open segment). */
  async function seed(n: number): Promise<{ org: string; user: string; session: AttendanceSession }> {
    const org = orgId(n);
    const user = userId(n);
    await admin.query(`DELETE FROM organizations WHERE id = $1`, [org]);
    await admin.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, $2, $3, 'UTC')`, [org, `Lock order ${n}`, `lock-order-${n}`]);
    await admin.query(`INSERT INTO users (id, org_id, email, display_name, role, status) VALUES ($1, $2, $3, 'Lena Lock', 'EMPLOYEE', 'ACTIVE')`, [user, org, `lena${n}@lock-order.test`]);
    const secret = randomBytes(32).toString('hex');
    secrets.set(org, secret);
    await service.registerSessionSecret(`lock-order-${org}`, secret, org);
    await service.recordMonitoringConsent({ orgId: org, userId: user, noticeVersion: 'v1.0.0' });
    await heartbeat(org, user);
    const session = await service.getSession(user, org);
    assert.ok(session && session.segments.length > 0, 'open session with a segment');
    return { org, user, session };
  }

  const input = (s: AttendanceSession) => ({ sessionId: s.id, orgId: s.orgId, userId: s.userId, at: new Date(), config: DEFAULT_ATTENDANCE_CONFIG, input: { kind: 'logout' as const } });
  const deadlocks = (...errors: unknown[]) => errors.filter((e) => conflictKind(e) !== null).map((e) => (e as Error).message);

  before(async () => {
    process.env.JOBS_ENABLED = 'false';
    admin = new pg.Pool({ ...conn, user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres', max: 6 });
    app = new pg.Pool({ ...conn, user: process.env.PGUSER || 'hrvo_app', password: process.env.PGPASSWORD || 'hrvo_app_dev_pass', max: 8 });
    await admin.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [ORGS]);
    repo = new PostgresAttendanceRepository();
    service = new AttendanceService(undefined, new SystemClock(), repo);
  });

  after(async () => {
    await repo?.close();
    await admin.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [ORGS]);
    await app.end();
    await admin.end();
  });

  it('1. attendance save vs. a transaction that locks the person, then their sessions (the anonymisation order)', async () => {
    const { org, user, session } = await seed(1);
    const retries = totalConflictRetries();
    const y = await client(app, org);
    await lockUsersForWrite(y.c, [user]);
    // The heartbeat-path save: session row, segments, then the raw-input presence event.
    const save = track(repo.saveSession(session, input(session)));
    await untilBlockedBy(y.pid, save);
    // Y now wants the sessions of that person (anonymisation: device id and IP removed).
    const yUpdate = track(y.c.query(`UPDATE attendance_sessions SET device_id = device_id WHERE user_id = $1`, [user]));
    await untilWaiting(y.pid, yUpdate);
    await yUpdate.promise.catch(() => undefined);
    await y.c.query(yUpdate.error ? 'ROLLBACK' : 'COMMIT');
    y.c.release();
    await save.promise.catch(() => undefined);
    assert.deepEqual(deadlocks(yUpdate.error, save.error), [], 'no deadlock between the two transactions');
    assert.equal(yUpdate.error, undefined);
    assert.equal(save.error, undefined);
    assert.equal(totalConflictRetries(), retries, 'resolved by lock order, not hidden by a retry');
  });

  it('2. attendance save vs. DELETE of its organisation (the pair in the CI log, 2026-10-23 00:00:43 UTC)', async () => {
    const { org, session } = await seed(2);
    const retries = totalConflictRetries();
    // A gate holds the open segment so the save stops after it has written the session row.
    const gate = await client(admin, null);
    await gate.c.query(`SELECT 1 FROM attendance_segments WHERE id = $1 FOR UPDATE`, [session.segments[session.segments.length - 1]!.id]);
    const save = track(repo.saveSession(session, input(session)));
    assert.equal(await untilBlockedBy(gate.pid, save), 'blocked');
    // A test teardown deletes the organisation (cascading to sessions) while the save is in flight.
    const del = await client(admin, null);
    const deleting = track(del.c.query(`DELETE FROM organizations WHERE id = $1`, [org]));
    await untilWaiting(del.pid, deleting);
    await gate.c.query('COMMIT');
    gate.c.release();
    await save.promise.catch(() => undefined);
    await deleting.promise.catch(() => undefined);
    await del.c.query(deleting.error ? 'ROLLBACK' : 'COMMIT');
    del.c.release();
    assert.deepEqual(deadlocks(save.error, deleting.error), [], 'no deadlock between the two transactions');
    assert.equal(deleting.error, undefined, 'the delete completes');
    assert.equal(totalConflictRetries(), retries, 'resolved by lock order, not hidden by a retry');
  });

  it('3. organisation settings write vs. an audit append in the same organisation (the audit-chain lock)', async () => {
    const { org, user } = await seed(3);
    const retries = totalConflictRetries();
    // Policy / guards / profile update: lock the organisation, change it, then audit it.
    const x = await client(app, org);
    await lockOrgForWrite(x.c, org);
    // Meanwhile any other audited action in the organisation (here: a person's own action).
    const c = await client(app, org);
    const audit = track(appendAuditEntry(c.c, { orgId: org, actorId: user, action: 'LOCK_ORDER_TEST', entityType: 'USER', entityId: user }));
    await untilBlockedBy(x.pid, audit);
    const xAudit = track(appendAuditEntry(x.c, { orgId: org, actorId: user, action: 'ORG_POLICY_UPDATED', entityType: 'ORGANIZATION', entityId: org }));
    await untilWaiting(x.pid, xAudit);
    // Whoever is not waiting finishes first; the other then goes on.
    let cDone = false;
    if (audit.settled) { await c.c.query(audit.error ? 'ROLLBACK' : 'COMMIT'); cDone = true; }
    await xAudit.promise.catch(() => undefined);
    await x.c.query(xAudit.error ? 'ROLLBACK' : 'COMMIT');
    x.c.release();
    await audit.promise.catch(() => undefined);
    if (!cDone) await c.c.query(audit.error ? 'ROLLBACK' : 'COMMIT');
    c.c.release();
    assert.deepEqual(deadlocks(audit.error, xAudit.error), [], 'no deadlock between the two transactions');
    assert.equal(audit.error, undefined);
    assert.equal(xAudit.error, undefined);
    assert.equal(totalConflictRetries(), retries);
  });

  it('4. a key-strength lock on the organisation (e.g. a delete) vs. an audit append: parents before the audit lock', async () => {
    const { org, user } = await seed(4);
    const retries = totalConflictRetries();
    const x = await client(admin, null);
    await x.c.query(`SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, [org]);
    const c = await client(app, org);
    const audit = track(appendAuditEntry(c.c, { orgId: org, actorId: user, action: 'LOCK_ORDER_TEST', entityType: 'USER', entityId: user }));
    await untilBlockedBy(x.pid, audit);
    const xAudit = track(appendAuditEntry(x.c, { orgId: org, actorId: user, action: 'ORG_TEST', entityType: 'ORGANIZATION', entityId: org }));
    await untilWaiting(x.pid, xAudit);
    await xAudit.promise.catch(() => undefined);
    await x.c.query(xAudit.error ? 'ROLLBACK' : 'COMMIT');
    x.c.release();
    await audit.promise.catch(() => undefined);
    await c.c.query(audit.error ? 'ROLLBACK' : 'COMMIT');
    c.c.release();
    assert.deepEqual(deadlocks(audit.error, xAudit.error), [], 'no deadlock between the two transactions');
    assert.equal(audit.error, undefined);
    assert.equal(xAudit.error, undefined);
    assert.equal(totalConflictRetries(), retries);
  });

  it('5. heartbeats + reconciler + audit appends + settings and person writers, same person and organisation, 40 rounds', async () => {
    const { org, user } = await seed(5);
    const retries = totalConflictRetries();
    const errors: unknown[] = [];
    let audited = 0;
    const settingsWrite = async () => {
      const x = await client(app, org);
      try {
        await lockOrgForWrite(x.c, org);
        await x.c.query(`UPDATE organizations SET name = name WHERE id = $1`, [org]);
        await appendAuditEntry(x.c, { orgId: org, actorId: user, action: 'ORG_POLICY_UPDATED', entityType: 'ORGANIZATION', entityId: org });
        await x.c.query('COMMIT');
        audited += 1;
      } catch (e) { await x.c.query('ROLLBACK'); throw e; } finally { x.c.release(); }
    };
    const personWrite = async () => {
      const y = await client(app, org);
      try {
        await lockUsersForWrite(y.c, [user]);
        await y.c.query(`UPDATE attendance_sessions SET device_id = device_id WHERE user_id = $1`, [user]);
        await appendAuditEntry(y.c, { orgId: org, actorId: user, action: 'USER_UPDATED', entityType: 'USER', entityId: user });
        await y.c.query('COMMIT');
        audited += 1;
      } catch (e) { await y.c.query('ROLLBACK'); throw e; } finally { y.c.release(); }
    };
    for (let round = 0; round < 40; round += 1) {
      const results = await Promise.allSettled([
        heartbeat(org, user), heartbeat(org, user),
        service.runReconciliation(new Date(), org),
        repo.recordAuditLog({ orgId: org, actorId: user, action: 'ATTENDANCE_TEST', entityType: 'USER', entityId: user, createdAt: new Date() }).then(() => { audited += 1; }),
        settingsWrite(), personWrite(),
        service.recomputeDailySummaryForUser(org, user, new Date().toISOString().slice(0, 10)),
      ]);
      for (const r of results) if (r.status === 'rejected') errors.push(r.reason);
    }
    assert.deepEqual(deadlocks(...errors), [], 'no deadlock or serialization failure in 40 rounds');
    assert.equal(totalConflictRetries(), retries, `no hidden retries: ${JSON.stringify(conflictRetryStats())}`);
    assert.equal(audited, 120, `every audit append committed (other errors: ${errors.map((e) => (e as Error).message).join('; ')})`);
    // The hash chain is intact after all that concurrency.
    const chain = (await admin.query<{ prev_hash: string; hash: string }>(`SELECT prev_hash, hash FROM audit_logs WHERE org_id = $1 ORDER BY id`, [org])).rows;
    for (let i = 1; i < chain.length; i += 1) assert.equal(chain[i]!.prev_hash, chain[i - 1]!.hash, `chain link ${i}`);
  });

  it('6. retry: only deadlocks and serialization failures, bounded, counted and logged', async () => {
    const before = conflictRetryStats()['test.op:deadlock'] ?? 0;
    let calls = 0;
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (line: unknown) => { warned.push(String(line)); };
    try {
      assert.equal(await withConflictRetry('test.op', async () => { calls += 1; if (calls < 3) throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); return 'ok'; }), 'ok');
      assert.equal(calls, 3);
      calls = 0;
      await assert.rejects(withConflictRetry('test.op', async () => { calls += 1; throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); }), /deadlock/);
      assert.equal(calls, 3, 'gives up after three attempts');
      calls = 0;
      await assert.rejects(withConflictRetry('test.op', async () => { calls += 1; throw Object.assign(new Error('duplicate key'), { code: '23505' }); }), /duplicate/);
      assert.equal(calls, 1, 'other errors are never retried');
    } finally {
      console.warn = warn;
    }
    assert.equal((conflictRetryStats()['test.op:deadlock'] ?? 0) - before, 4);
    assert.equal(warned.length, 4);
    assert.deepEqual(JSON.parse(warned[0]!), { event: 'db_conflict_retry', op: 'test.op', kind: 'deadlock', code: '40P01', attempt: 1, maxAttempts: 3 });
  });

  it('7. shutdown waits for an in-flight attendance write, then closes the pools (the CI pair met because a disconnect outlived app.close())', async () => {
    const { org, user, session } = await seed(6);
    const ownRepo = new PostgresAttendanceRepository();
    const own = new AttendanceService(undefined, new SystemClock(), ownRepo);
    // A gate holds the session row so the disconnect write is provably still running at shutdown.
    const gate = await client(admin, null);
    await gate.c.query(`SELECT 1 FROM attendance_sessions WHERE id = $1 FOR UPDATE`, [session.id]);
    const disconnect = track(own.onSocketDisconnect(user, new Date(), org));
    assert.equal(await untilBlockedBy(gate.pid, disconnect), 'blocked');
    const shutdown = track(own.onApplicationShutdown());
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(shutdown.settled, false, 'shutdown waits for the write');
    await gate.c.query('COMMIT');
    gate.c.release();
    await shutdown.promise;
    assert.equal(disconnect.settled, true, 'the write finished before shutdown returned');
    assert.equal(disconnect.error, undefined);
    const written = await admin.query(`SELECT count(*)::int AS n FROM presence_events WHERE session_id = $1 AND event_type = 'ATTENDANCE_INPUT' AND meta->'input'->>'kind' = 'disconnect'`, [session.id]);
    assert.equal(written.rows[0].n, 1, 'the DISCONNECT input is recorded');
    await assert.rejects(ownRepo.saveSession(session), 'nothing writes after shutdown');
    await ownRepo.close();
  });

  it('8. no application code locks an organisation or person row with FOR UPDATE (it would block every foreign-key check)', () => {
    // The TypeScript sources, whether this runs from apps/api/test or from dist/apps/api/test.
    let repoRoot = dirname(fileURLToPath(import.meta.url));
    while (!statSync(join(repoRoot, 'apps', 'api', 'src', 'main.ts'), { throwIfNoEntry: false })) {
      const up = dirname(repoRoot);
      assert.notEqual(up, repoRoot, 'repository root not found');
      repoRoot = up;
    }
    const root = join(repoRoot, 'apps', 'api', 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!name.endsWith('.ts')) continue;
        for (const m of readFileSync(p, 'utf8').matchAll(/`([^`]*FOR UPDATE[^`]*)`/g)) {
          const sql = m[1]!;
          const of = /FOR UPDATE OF (\w+)/.exec(sql)?.[1];
          const tables = [...sql.matchAll(/\b(?:FROM|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi)].map((t) => ({ table: t[1]!, alias: t[2] }));
          const locked = of ? tables.filter((t) => t.alias === of || t.table === of) : tables;
          if (locked.some((t) => t.table === 'organizations' || t.table === 'users')) offenders.push(`${p.slice(root.length + 1)}: ${sql.replace(/\s+/g, ' ').slice(0, 90)}`);
        }
      }
    };
    walk(root);
    assert.deepEqual(offenders, [], 'use lockOrgForWrite / lockUsersForWrite or FOR NO KEY UPDATE (ADR 038)');
  });
});
