#!/usr/bin/env node
/**
 * NFR-ACC-001..004 verification against the load database after a k6 run (load/heartbeat.js).
 * Run it a few minutes after k6 ends, so the disconnect grace window (120 s) has passed and the
 * reconciler (every 15 s) has closed the sessions.
 *
 *   PGDATABASE=hrvo_load node load/verify-accuracy.mjs load/out/summary.json
 *
 *  - ACC-001 clock-in ≤ 5 s: the k6 first-ack latency (the ack that created the session).
 *  - ACC-002 clock-out within 30 s after grace, clock_out_at = last heartbeat: from sessions.
 *  - ACC-003 no double counting: users with two devices have one session, flagged MULTI_DEVICE,
 *    net ≤ wall clock, and nobody has overlapping sessions.
 *  - ACC-004 determinism: daily totals recomputed twice from the stored sessions are identical
 *    and equal the stored attendance_daily row (after a daily close for that date).
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { AttendanceService } from '../apps/api/src/attendance/attendance.service.ts';
import { PostgresAttendanceRepository } from '../apps/api/src/attendance/attendance-repository.ts';

const ORG = 'add00000-0000-4000-8000-000000000001';
const GRACE_S = 120;
const RECONCILE_S = 15;
const summary = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : null;

const pool = new pg.Pool({
  host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_load',
  user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres',
});
const results = [];
const record = (id, pass, detail) => results.push({ id, pass, detail });

// ACC-001
if (summary) {
  const p99 = summary.clockinLatencyMs?.p99 ?? summary.clockinLatencyMs?.max; // max is stricter than p99 when p99 was not collected
  record('NFR-ACC-001', p99 !== null && p99 !== undefined && p99 <= 5000, `first heartbeat acknowledged (session created) p50 ${summary.clockinLatencyMs?.p50} ms, p99 ${p99} ms, max ${summary.clockinLatencyMs?.max} ms over ${summary.users + summary.phones} connections`);
} else record('NFR-ACC-001', false, 'no k6 summary given');

// ACC-002
const sessions = (await pool.query(
  `SELECT id, user_id, device_id, work_date, status, clock_in_at, clock_out_at, clock_out_source, last_heartbeat_at, updated_at, net_seconds, flags
   FROM attendance_sessions WHERE org_id = $1 ORDER BY user_id, clock_in_at`, [ORG],
)).rows;
const open = sessions.filter((s) => s.status === 'OPEN');
const closed = sessions.filter((s) => s.status === 'CLOSED');
const exact = closed.filter((s) => s.clock_out_at && s.last_heartbeat_at && Math.abs(s.clock_out_at - s.last_heartbeat_at) < 1000).length;
// Closure happens when the reconciler runs after the grace window that starts at the socket close.
// The k6 log (third argument) carries one {closeEvent} line per device; without it, the last
// heartbeat is used as a lower bound of the close time, which over-states the delay by up to one interval.
const closeEvents = process.argv[3]
  ? readFileSync(process.argv[3], 'utf8').split(/\r?\n/).filter((l) => l.includes('closeEvent')).map((l) => {
      // k6 wraps console.log output as: time=... level=info msg="{\"closeEvent\":true,...}" source=console
      const m = /msg="(.*)" source=console/.exec(l);
      return JSON.parse(m ? m[1].replace(/\\"/g, '"') : l.slice(l.indexOf('{')));
    })
  : [];
const lastCloseByUser = new Map();
for (const e of closeEvents) lastCloseByUser.set(e.userId, Math.max(lastCloseByUser.get(e.userId) ?? 0, Date.parse(e.closedAt)));
const delays = closed.map((s) => {
  const from = lastCloseByUser.get(s.user_id);
  // With close events, only sessions closed after that instant are the ones this run produced.
  if (closeEvents.length > 0 && (!from || s.clock_out_at.getTime() < from - 60_000)) return null;
  return (s.updated_at - (from ?? s.last_heartbeat_at)) / 1000 - GRACE_S;
}).filter((d) => d !== null && Number.isFinite(d));
const maxDelay = delays.length ? Math.max(...delays) : null;
const p95Delay = delays.length ? [...delays].sort((a, b) => a - b)[Math.floor(delays.length * 0.95) - 1] : null;
record('NFR-ACC-002', open.length === 0 && exact === closed.length && maxDelay !== null && maxDelay <= 30,
  `${closed.length} sessions closed, ${open.length} still open; clock_out = last heartbeat for ${exact}/${closed.length}; closure after the ${GRACE_S} s grace window measured from ${closeEvents.length > 0 ? `${closeEvents.length} client close events` : 'the last heartbeat (upper bound)'}: p95 ${p95Delay?.toFixed(1)} s, max ${maxDelay?.toFixed(1)} s (reconciler every ${RECONCILE_S} s); sources ${JSON.stringify(Object.fromEntries(closed.reduce((m, s) => m.set(s.clock_out_source, (m.get(s.clock_out_source) ?? 0) + 1), new Map())))}`);

// ACC-003
const byUser = new Map();
for (const s of sessions) byUser.set(s.user_id, [...(byUser.get(s.user_id) ?? []), s]);
let multi = 0; let flagged = 0; let overlapUsers = 0; let overCounted = 0;
// Two-device users are users 1..PHONES by the k6 script's convention (phone-N re-uses load00N).
const PHONES = Number(process.env.PHONES || summary?.phones || 20);
const multiUsers = new Set(Array.from({ length: PHONES }, (_, i) => `add00000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`));
for (const [userId, list] of byUser) {
  const sorted = [...list].sort((a, b) => a.clock_in_at - b.clock_in_at);
  for (let i = 1; i < sorted.length; i += 1) if (sorted[i].clock_in_at < (sorted[i - 1].clock_out_at ?? Infinity)) { overlapUsers += 1; break; }
  for (const s of sorted) {
    // A heartbeat reports the interval that just ended, so a session may legitimately carry up to one
    // interval (30 s) of activity reported in its first heartbeat; anything beyond that is double counting.
    const wall = ((s.clock_out_at ?? s.last_heartbeat_at) - s.clock_in_at) / 1000;
    if (s.net_seconds > wall + 35) overCounted += 1; // 30 s interval + the validator's 5 s jitter allowance
  }
  if (multiUsers.has(userId)) { multi += 1; if (sorted.some((s) => (s.flags ?? []).includes('MULTI_DEVICE'))) flagged += 1; }
}
record('NFR-ACC-003', overlapUsers === 0 && overCounted === 0 && flagged === multi,
  `${multi} users heartbeated from two devices: ${flagged} flagged MULTI_DEVICE, ${overlapUsers} with overlapping sessions, ${overCounted} sessions with net > wall clock`);

// ACC-004: recompute twice and compare with the stored daily row.
const repo = new PostgresAttendanceRepository({
  appPoolConfig: { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_load', user: process.env.PGUSER || 'hrvo_app', password: process.env.PGPASSWORD },
  adminPoolConfig: { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_load', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' },
  retentionPoolConfig: { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_load', user: process.env.PGRETENTION_USER || 'hrvo_retention', password: process.env.PGRETENTION_PASSWORD },
});
const service = new AttendanceService(undefined, undefined, repo);
const dates = [...new Set(sessions.map((s) => s.work_date ?? null))].filter(Boolean);
const workDates = (await pool.query(`SELECT DISTINCT work_date FROM attendance_sessions WHERE org_id = $1`, [ORG])).rows.map((r) => r.work_date);
let compared = 0; let mismatches = 0; let storedMismatch = 0;
for (const workDate of workDates) {
  for (const userId of byUser.keys()) {
    const a = await service.recomputeDailySummaryForUser(ORG, userId, workDate);
    const b = await service.recomputeDailySummaryForUser(ORG, userId, workDate);
    compared += 1;
    const key = (d) => d && `${d.netSeconds}|${d.activeSeconds}|${d.idleSeconds}|${d.breakSeconds}|${d.meetingSeconds}|${d.dayStatus}`;
    if (key(a) !== key(b)) mismatches += 1;
    const stored = (await pool.query(`SELECT net_seconds FROM attendance_daily WHERE org_id = $1 AND user_id = $2 AND work_date = $3`, [ORG, userId, workDate])).rows[0];
    const fromSessions = byUser.get(userId).filter((s) => s.work_date === workDate).reduce((n, s) => n + s.net_seconds, 0);
    if (!stored || stored.net_seconds !== a.netSeconds || a.netSeconds !== fromSessions) storedMismatch += 1;
  }
}
void dates;
record('NFR-ACC-004', mismatches === 0 && storedMismatch === 0, `${compared} person-days recomputed twice: ${mismatches} differed between runs, ${storedMismatch} differed from the stored daily row or the session sum`);

await repo.close();
await pool.end();
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.detail}`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
