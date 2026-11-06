/**
 * ADR 049 §2 overtime requests (FR-WT-007..012) and §7 onsite work (FR-WT-023..024), end to end:
 * validation, one claim per day, decisions only by the requester's manager or HR (never oneself),
 * decided once, cancel rules, notifications, audit, the timesheet's three overtime numbers, the pay
 * rule with the organisation setting off and on, onsite overlap checks, approval into an ONSITE
 * time entry (never attendance), and tenant isolation.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { formatInTimeZone } from 'date-fns-tz';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { OnsiteRequestListSchema, OnsiteRequestSchema, OvertimeRequestListSchema, OvertimeRequestSchema } from '../../../packages/shared/src/timesheets/work-requests.ts';
import type { OnsiteRequest, OvertimeRequest } from '../../../packages/shared/src/timesheets/work-requests.ts';
import { TimesheetDetailSchema, TimesheetListSchema, TimesheetSettingsSchema } from '../../../packages/shared/src/timesheets/types.ts';
import { freshCode } from './support/totp.ts';

const ORG = '0ae70000-0000-4000-8000-000000000001';
const OTHER = '0ae70000-0000-4000-8000-000000000002';
const TEAM = '0ae70000-0000-4000-8000-000000000101';
const TEAM2 = '0ae70000-0000-4000-8000-000000000102';
const PROJECT = '0ae70000-0000-4000-8000-000000000201';
const PORT = 3063;
const PASSWORD = 'ComplexPassword123!';
const MFA_SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const U = {
  hr: { id: '0ae70000-0000-4000-8000-000000000011', email: 'hr@wr.test', role: 'HR', team: null as string | null },
  lead: { id: '0ae70000-0000-4000-8000-000000000012', email: 'lead@wr.test', role: 'TEAM_LEAD', team: TEAM as string | null },
  emp: { id: '0ae70000-0000-4000-8000-000000000013', email: 'emp@wr.test', role: 'EMPLOYEE', team: TEAM as string | null },
  lead2: { id: '0ae70000-0000-4000-8000-000000000014', email: 'lead2@wr.test', role: 'TEAM_LEAD', team: TEAM2 as string | null },
  sub: { id: '0ae70000-0000-4000-8000-000000000015', email: 'sub@wr.test', role: 'SUBCONTRACTOR', team: TEAM as string | null },
  auditor: { id: '0ae70000-0000-4000-8000-000000000016', email: 'aud@wr.test', role: 'AUDITOR', team: null as string | null },
} as const;
type Who = keyof typeof U;
const TZ = 'Asia/Colombo';
const day = (n: number) => formatInTimeZone(new Date(Date.now() + n * 86_400_000), TZ, 'yyyy-MM-dd');
const at = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+05:30`);

describe('ADR 049: overtime and onsite work requests', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  const tokens = {} as Record<Who, string>;
  const base = `http://localhost:${PORT}`;
  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  async function ok<T>(res: Response, status: number, schema?: { parse: (v: unknown) => T }): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return schema ? schema.parse(JSON.parse(text)) : (JSON.parse(text || 'null') as T);
  }
  const notes = async (who: Who, type: string) => (await adminPool.query(`SELECT title FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY created_at`, [U[who].id, type])).rows as Array<{ title: string }>;
  const audits = async (action: string) => (await adminPool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = $2`, [ORG, action])).rows[0].n as number;
  const sheetOf = async (who: Who, date: string) => {
    const list = await ok(await api(who, `/timesheets?scope=mine&from=${date}&to=${date}`), 200, TimesheetListSchema);
    return await ok(await api(who, `/timesheets/${list.items[0]!.id}`), 200, TimesheetDetailSchema);
  };

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    const pgBase = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev' };
    adminPool = new pg.Pool({ ...pgBase, user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    appPool = new pg.Pool({ ...pgBase, user: process.env.PGUSER || 'hrvo_app', password: process.env.PGPASSWORD || 'hrvo_app_pass' });
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Requests Ltd', 'wr-e2e', $3), ($2, 'Other', 'wr-e2e-other', $3)`, [ORG, OTHER, TZ]);
    await adminPool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $3, 'Alpha'), ($2, $3, 'Beta')`, [TEAM, TEAM2, ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const [k, u] of Object.entries(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, team_id, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`, [u.id, ORG, u.email, k, u.role, u.team, hash]);
    }
    await adminPool.query(`UPDATE users SET manager_id = $1 WHERE id IN ($2, $3)`, [U.lead.id, U.emp.id, U.sub.id]);
    await adminPool.query(`UPDATE users SET mfa_enabled = true, mfa_secret = $1 WHERE id = $2`, [MFA_SECRET, U.hr.id]);
    await adminPool.query(`INSERT INTO projects (id, org_id, name, code, manager_id) VALUES ($1, $2, 'Field Service', 'FS', $3)`, [PROJECT, ORG, U.lead.id]);
    for (const who of ['emp', 'sub'] as const) await adminPool.query(`INSERT INTO project_members (org_id, project_id, user_id) VALUES ($1, $2, $3)`, [ORG, PROJECT, U[who].id]);
    // Subcontractor rate: 10.00/h, cap 1 h a week, overtime x2 (so small numbers show the rule).
    await adminPool.query(`INSERT INTO subcontractor_profiles (org_id, user_id, rate_type, rate, currency, overtime_multiplier, weekly_hours_cap) VALUES ($1, $2, 'HOURLY', 10, 'USD', 2, 1)`, [ORG, U.sub.id]);
    // Attendance 3 days ago 10:00-12:00 (onsite claims cannot overlap it).
    await adminPool.query(
      `INSERT INTO attendance_sessions (org_id, user_id, device_id, work_date, clock_in_at, clock_out_at, clock_in_source, clock_out_source, last_heartbeat_at, ip_in, status, current_state, net_seconds, active_seconds)
       VALUES ($1, $2, 'd1', $3, $4, $5, 'AUTO_HEARTBEAT', 'LOGOUT', $5, '127.0.0.1', 'CLOSED', 'OFFLINE', 7200, 7200)`,
      [ORG, U.emp.id, day(-3), at(day(-3), '10:00'), at(day(-3), '12:00')]);
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD, ...(who === 'hr' ? { totpCode: await freshCode(MFA_SECRET) } : {}) }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
      assert.ok(tokens[who], `login ${who}`);
    }
  });

  after(async () => {
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OTHER]]);
    await adminPool.end();
    await appPool.end();
  });

  // ------------------------------------------------------------------ overtime

  let ot: OvertimeRequest;
  it('FR-WT-007: an employee requests overtime; input is validated; the manager is told; audited', async () => {
    const body = { workDate: day(-1), plannedStart: '18:00', plannedEnd: '20:00', projectId: PROJECT, workDescription: 'Production release support', reason: 'Release window after hours', notes: 'On call with the client' };
    assert.equal((await api('auditor', '/overtime-requests', { method: 'POST', body })).status, 403, 'auditors keep no time');
    assert.equal((await api('emp', '/overtime-requests', { method: 'POST', body: { ...body, plannedEnd: '17:00' } })).status, 400, 'end before start');
    assert.equal((await api('emp', '/overtime-requests', { method: 'POST', body: { ...body, plannedStart: undefined, plannedEnd: undefined } })).status, 400, 'no time or duration');
    assert.equal((await api('emp', '/overtime-requests', { method: 'POST', body: { ...body, workDate: day(-20) } })).status, 400, 'too far back');
    assert.equal((await api('emp', '/overtime-requests', { method: 'POST', body: { ...body, workDate: day(90) } })).status, 400, 'too far ahead');
    assert.equal((await api('lead2', '/overtime-requests', { method: 'POST', body })).status, 404, 'not a project member');
    ot = await ok(await api('emp', '/overtime-requests', { method: 'POST', body }), 201, OvertimeRequestSchema);
    assert.equal(ot.status, 'PENDING');
    assert.equal(ot.requestedMinutes, 120);
    assert.equal(ot.project?.name, 'Field Service');
    assert.equal(ot.canDecide, false);
    assert.equal(ot.canCancel, true);
    assert.equal((await notes('lead', 'OVERTIME_REQUESTED')).length, 1);
    assert.equal(await audits('OVERTIME_REQUESTED'), 1);
  });

  it('FR-WT-010: one pending or approved claim per day', async () => {
    assert.equal((await api('emp', '/overtime-requests', { method: 'POST', body: { workDate: day(-1), minutes: 60, workDescription: 'More work', reason: 'Still busy' } })).status, 409);
  });

  it('FR-WT-008: never one\'s own; not another team\'s lead; a rejection needs a comment', async () => {
    assert.equal((await api('emp', `/overtime-requests/${ot.id}/decide`, { method: 'POST', body: { approved: true } })).status, 403, 'employees do not approve');
    assert.equal((await api('lead2', `/overtime-requests/${ot.id}/decide`, { method: 'POST', body: { approved: true } })).status, 403, 'another team');
    assert.equal((await api('lead', `/overtime-requests/${ot.id}/decide`, { method: 'POST', body: { approved: false } })).status, 400);
    const own = await ok(await api('hr', '/overtime-requests', { method: 'POST', body: { workDate: day(-1), minutes: 30, workDescription: 'Payroll run', reason: 'Month end' } }), 201, OvertimeRequestSchema);
    assert.equal((await api('hr', `/overtime-requests/${own.id}/decide`, { method: 'POST', body: { approved: true } })).status, 403, 'HR cannot approve their own');
    const team = await ok(await api('lead', '/overtime-requests?scope=team'), 200, OvertimeRequestListSchema);
    assert.deepEqual(team.items.map((r) => r.id), [ot.id], 'only the lead\'s reports');
    assert.equal(team.items[0]!.canDecide, true);
    assert.equal((await ok(await api('lead2', '/overtime-requests?scope=team'), 200, OvertimeRequestListSchema)).items.length, 0);
    assert.equal((await api('emp', '/overtime-requests?scope=team')).status, 403);
  });

  it('FR-WT-008, FR-WT-012: the manager approves fewer minutes; decided once; the employee is told; audited', async () => {
    const d = await ok(await api('lead', `/overtime-requests/${ot.id}/decide`, { method: 'POST', body: { approved: true, approvedMinutes: 90, comment: 'Approved up to 19:30' } }), 200, OvertimeRequestSchema);
    assert.equal(d.status, 'APPROVED');
    assert.equal(d.approvedMinutes, 90);
    assert.equal(d.decidedBy?.id, U.lead.id);
    assert.equal((await api('hr', `/overtime-requests/${ot.id}/decide`, { method: 'POST', body: { approved: false, comment: 'Too late' } })).status, 409);
    assert.equal((await notes('emp', 'OVERTIME_DECIDED')).length, 1);
    assert.equal(await audits('OVERTIME_APPROVED'), 1);
    assert.equal((await api('emp', `/overtime-requests/${ot.id}/cancel`, { method: 'POST', body: {} })).status, 409, 'approved: only HR withdraws it');
  });

  it('FR-WT-011: the timesheet shows worked, requested and approved overtime separately', async () => {
    await ok(await api('emp', '/time-entries', { method: 'POST', body: { workDate: day(-1), minutes: 30, title: 'Release notes', reason: 'Written offline' } }), 201);
    const sheet = await sheetOf('emp', day(-1));
    assert.equal(sheet.overtime.requiresApproval, false);
    assert.equal(sheet.overtime.requestedMinutes, 120);
    assert.equal(sheet.overtime.approvedMinutes, 90);
    assert.equal(typeof sheet.overtime.workedMinutes, 'number');
  });

  it('FR-WT-011: pay: setting off = ADR 008; on = only approved minutes get the multiplier', async () => {
    await ok(await api('sub', '/time-entries', { method: 'POST', body: { workDate: day(-1), startTime: '08:00', endTime: '11:00', title: 'Site survey', projectId: PROJECT, reason: 'Logged after the visit' } }), 201);
    // 3 h with a 1 h weekly cap: 1 h regular + 2 h overtime x2 at 10.00/h.
    assert.equal((await sheetOf('sub', day(-1))).payable?.amount, '50.00', 'off: 10 + 2 x 10 x 2');
    const settings = await ok(await api('hr', '/timesheets/settings'), 200, TimesheetSettingsSchema);
    await ok(await api('hr', '/timesheets/settings', { method: 'PUT', body: { ...settings, overtimeRequiresApproval: true } }), 200);
    const unapproved = await sheetOf('sub', day(-1));
    assert.equal(unapproved.payable?.amount, '30.00', 'on, nothing approved: 3 h at the base rate');
    assert.equal(unapproved.payable?.unapprovedOvertimeMinutes, 120);
    const req = await ok(await api('sub', '/overtime-requests', { method: 'POST', body: { workDate: day(-1), minutes: 60, projectId: PROJECT, workDescription: 'Survey report', reason: 'Client deadline' } }), 201, OvertimeRequestSchema);
    await ok(await api('lead', `/overtime-requests/${req.id}/decide`, { method: 'POST', body: { approved: true } }), 200);
    const approved = await sheetOf('sub', day(-1));
    assert.equal(approved.payable?.amount, '40.00', 'on, 1 h approved: 10 + 10 + 1 x 10 x 2');
    assert.equal(approved.payable?.overtimeMinutes, 60);
    assert.equal(await audits('TIMESHEET_SETTINGS_UPDATED'), 1, 'the setting change is audited');
    await ok(await api('hr', '/timesheets/settings', { method: 'PUT', body: { ...settings, overtimeRequiresApproval: false } }), 200);
    assert.equal((await sheetOf('sub', day(-1))).payable?.amount, '50.00', 'back off: unchanged ADR 008 amount');
    const omitted = { ...settings } as Record<string, unknown>;
    delete omitted.overtimeRequiresApproval;
    await ok(await api('hr', '/timesheets/settings', { method: 'PUT', body: omitted }), 200);
    assert.equal((await ok(await api('hr', '/timesheets/settings'), 200, TimesheetSettingsSchema)).overtimeRequiresApproval, false, 'omitted = unchanged');
  });

  it('cancel: the owner withdraws a pending request; HR withdraws approved overtime with a reason', async () => {
    const p = await ok(await api('emp', '/overtime-requests', { method: 'POST', body: { workDate: day(5), minutes: 120, workDescription: 'Data migration', reason: 'Weekend cut-over' } }), 201, OvertimeRequestSchema);
    assert.equal((await api('lead', `/overtime-requests/${p.id}/cancel`, { method: 'POST', body: {} })).status, 409, 'not the lead\'s to cancel');
    assert.equal((await ok(await api('emp', `/overtime-requests/${p.id}/cancel`, { method: 'POST', body: {} }), 200, OvertimeRequestSchema)).status, 'CANCELLED');
    await ok(await api('emp', '/overtime-requests', { method: 'POST', body: { workDate: day(5), minutes: 60, workDescription: 'Data migration', reason: 'Smaller cut-over' } }), 201, OvertimeRequestSchema);
    assert.equal((await api('hr', `/overtime-requests/${ot.id}/cancel`, { method: 'POST', body: {} })).status, 400, 'a reason is required');
    const w = await ok(await api('hr', `/overtime-requests/${ot.id}/cancel`, { method: 'POST', body: { comment: 'Release moved' } }), 200, OvertimeRequestSchema);
    assert.equal(w.status, 'CANCELLED');
    assert.equal(await audits('OVERTIME_CANCELLED'), 2);
  });

  // ------------------------------------------------------------------ onsite

  let onsite: OnsiteRequest;
  it('FR-WT-023, FR-WT-024: onsite work is submitted with checks against overlaps, attendance and the future', async () => {
    const body = { workDate: day(-2), startTime: '09:00', endTime: '15:00', location: 'Client HQ, Colombo 03', projectId: PROJECT, description: 'Installed and tested the access-control units', reason: 'No laptop on site' };
    onsite = await ok(await api('emp', '/onsite-requests', { method: 'POST', body }), 201, OnsiteRequestSchema);
    assert.equal(onsite.status, 'PENDING');
    assert.equal(onsite.minutes, 360);
    assert.equal(onsite.startedAt, at(day(-2), '09:00').toISOString(), 'org-local times');
    assert.equal((await api('emp', '/onsite-requests', { method: 'POST', body: { ...body, startTime: '14:00', endTime: '16:00' } })).status, 409, 'overlaps the first claim');
    const clash = await api('emp', '/onsite-requests', { method: 'POST', body: { ...body, workDate: day(-3), startTime: '11:00', endTime: '13:00' } });
    assert.equal(clash.status, 409, 'was clocked in then');
    assert.match(await clash.text(), /attendance correction/);
    assert.equal((await api('emp', '/onsite-requests', { method: 'POST', body: { ...body, workDate: day(1) } })).status, 400, 'future day');
    assert.equal((await api('emp', '/onsite-requests', { method: 'POST', body: { ...body, workDate: day(-40) } })).status, 400, 'too far back');
    assert.equal((await api('emp', '/onsite-requests', { method: 'POST', body: { ...body, location: 'x' } })).status, 400);
    assert.equal((await notes('lead', 'ONSITE_REQUESTED')).length, 1);
    assert.equal(await audits('ONSITE_WORK_REQUESTED'), 1);
  });

  it('FR-WT-023: reviewers in scope only; approval adds an ONSITE time entry and never attendance', async () => {
    assert.equal((await api('lead2', `/onsite-requests/${onsite.id}/decide`, { method: 'POST', body: { approved: true } })).status, 403);
    assert.equal((await api('lead', `/onsite-requests/${onsite.id}/decide`, { method: 'POST', body: { approved: false } })).status, 400, 'a rejection needs a comment');
    const sessionsBefore = (await adminPool.query(`SELECT count(*)::int AS n FROM attendance_sessions WHERE user_id = $1`, [U.emp.id])).rows[0].n as number;
    const d = await ok(await api('lead', `/onsite-requests/${onsite.id}/decide`, { method: 'POST', body: { approved: true, comment: 'Confirmed with the client' } }), 200, OnsiteRequestSchema);
    assert.equal(d.status, 'APPROVED');
    assert.ok(d.timeEntryId);
    assert.equal((await api('hr', `/onsite-requests/${onsite.id}/decide`, { method: 'POST', body: { approved: false, comment: 'No' } })).status, 409, 'decided once');
    const sessionsAfter = (await adminPool.query(`SELECT count(*)::int AS n FROM attendance_sessions WHERE user_id = $1`, [U.emp.id])).rows[0].n as number;
    assert.equal(sessionsAfter, sessionsBefore, 'no attendance is created');
    const sheet = await sheetOf('emp', day(-2));
    const entry = sheet.entries.find((e) => e.id === d.timeEntryId)!;
    assert.equal(entry.source, 'ONSITE');
    assert.equal(entry.workType, 'ONSITE');
    assert.equal(entry.minutes, 360);
    const dayRow = sheet.days.find((x) => x.date === day(-2))!;
    assert.equal(dayRow.onsiteMinutes, 360);
    assert.equal(dayRow.attendanceMinutes, 0, 'attendance stays as recorded');
    assert.equal(dayRow.manualMinutes, 0, 'not manual time');
    assert.ok(!dayRow.flags.includes('NO_ATTENDANCE'), 'onsite work covers the day in the variance check');
    assert.equal((await api('emp', `/time-entries/${d.timeEntryId}`, { method: 'DELETE' })).status, 409, 'the reviewed entry stays');
    assert.equal((await notes('emp', 'ONSITE_DECIDED')).length, 1);
    assert.equal(await audits('ONSITE_WORK_APPROVED'), 1);
  });

  it('onsite: the owner cancels a pending claim; a rejected claim frees the slot', async () => {
    const body = { workDate: day(-4), startTime: '13:00', endTime: '17:00', location: 'Warehouse, Kelaniya', description: 'Stock count support', reason: 'Offline on site' };
    const p = await ok(await api('emp', '/onsite-requests', { method: 'POST', body }), 201, OnsiteRequestSchema);
    assert.equal((await api('lead', `/onsite-requests/${p.id}/cancel`, { method: 'POST' })).status, 404);
    assert.equal((await ok(await api('emp', `/onsite-requests/${p.id}/cancel`, { method: 'POST' }), 200, OnsiteRequestSchema)).status, 'CANCELLED');
    const q = await ok(await api('emp', '/onsite-requests', { method: 'POST', body }), 201, OnsiteRequestSchema);
    await ok(await api('lead', `/onsite-requests/${q.id}/decide`, { method: 'POST', body: { approved: false, comment: 'Not on the client list' } }), 200);
    await ok(await api('emp', '/onsite-requests', { method: 'POST', body }), 201);
    const mine = await ok(await api('emp', '/onsite-requests?scope=mine'), 200, OnsiteRequestListSchema);
    assert.deepEqual(mine.items.map((r) => r.status).sort(), ['APPROVED', 'CANCELLED', 'PENDING', 'REJECTED']);
  });

  it('RLS: another organisation sees nothing; the app role cannot delete requests', async () => {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [OTHER]);
      assert.equal((await c.query(`SELECT 1 FROM overtime_requests`)).rowCount, 0);
      assert.equal((await c.query(`SELECT 1 FROM onsite_work_requests`)).rowCount, 0);
      await assert.rejects(c.query(`INSERT INTO overtime_requests (org_id, user_id, work_date, requested_minutes, work_description, reason) VALUES ($1, $2, CURRENT_DATE, 60, 'xxx', 'yyy')`, [ORG, U.emp.id]), /row-level security/);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
      assert.ok((await c.query(`SELECT 1 FROM overtime_requests`)).rowCount! >= 3);
      await assert.rejects(c.query(`DELETE FROM overtime_requests`), /permission denied/);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
      await assert.rejects(c.query(`DELETE FROM onsite_work_requests`), /permission denied/);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
      await assert.rejects(c.query(`INSERT INTO overtime_requests (org_id, user_id, work_date, requested_minutes, work_description, reason) VALUES ($1, $2, $3::date, 60, 'dup', 'dup')`, [ORG, U.emp.id, day(5)]), /overtime_requests_one_per_day/, 'the database refuses a second claim for a day');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
