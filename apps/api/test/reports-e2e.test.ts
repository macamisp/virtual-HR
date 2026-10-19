/**
 * Manager dashboard and reports (FR-REP-001..006, 008; ADR 013) end to end. Fixtures are
 * written straight to Postgres; the API runs with RLS. A team lead sees their team, HR the
 * organisation, an employee nothing.
 */
import 'reflect-metadata';
import { freshCode } from './support/totp.ts';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { AttendanceReportSchema, ComplianceReportSchema, CostReportSchema, DashboardSchema, TaskReportSchema } from '../../../packages/shared/src/reports/types.ts';

const ORG = 'bebe0000-0000-4000-8000-000000000001';
const TEAM = 'bebe0000-0000-4000-8000-000000000101';
const TEAM2 = 'bebe0000-0000-4000-8000-000000000102';
const PROJECT = 'bebe0000-0000-4000-8000-000000000201';
const TZ = 'Asia/Colombo';
const PASSWORD = 'ComplexPassword123!';
const SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const U = {
  hr: { id: 'bebe0000-0000-4000-8000-000000000011', email: 'hr@rep.test', name: 'Hal HR', role: 'HR', team: null as string | null },
  lead: { id: 'bebe0000-0000-4000-8000-000000000012', email: 'lead@rep.test', name: 'Lena Lead', role: 'TEAM_LEAD', team: TEAM as string | null },
  emp: { id: 'bebe0000-0000-4000-8000-000000000013', email: 'emp@rep.test', name: 'Eva Emp', role: 'EMPLOYEE', team: TEAM as string | null },
  sub: { id: 'bebe0000-0000-4000-8000-000000000014', email: 'sub@rep.test', name: 'Sid Sub', role: 'SUBCONTRACTOR', team: TEAM as string | null },
  far: { id: 'bebe0000-0000-4000-8000-000000000015', email: 'far@rep.test', name: 'Fay Far', role: 'EMPLOYEE', team: TEAM2 as string | null },
} as const;
type Who = keyof typeof U;

describe('Dashboard and reports (FR-REP-001..006, 008)', { concurrency: false }, () => {
  let app: INestApplication;
  let base: string;
  let adminPool: pg.Pool;
  const tokens = {} as Record<Who, string>;
  const today = formatInTimeZone(new Date(), TZ, 'yyyy-MM-dd');
  const plusDays = (n: number) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  async function ok<T>(res: Response, status: number, schema?: { parse: (v: unknown) => T }): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return schema ? schema.parse(JSON.parse(text)) : (JSON.parse(text || 'null') as T);
  }
  const RANGE = 'from=2026-09-01&to=2026-09-30';

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.JOBS_ENABLED = 'false';
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    const q = (sql: string, params: unknown[] = []) => adminPool.query(sql, params);
    await q(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await q(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Reports Ltd', 'reports-e2e', $2)`, [ORG, TZ]);
    await q(`INSERT INTO teams (id, org_id, name) VALUES ($1, $3, 'Field'), ($2, $3, 'Office')`, [TEAM, TEAM2, ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(U)) {
      await q(`INSERT INTO users (id, org_id, email, display_name, role, team_id, password_hash, status, mfa_enabled, mfa_secret) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8, $9)`,
        [u.id, ORG, u.email, u.name, u.role, u.team, hash, u.role === 'HR', u.role === 'HR' ? SECRET : null]);
    }
    await q(`UPDATE users SET manager_id = $1 WHERE id = $2`, [U.lead.id, U.emp.id]);
    await q(`UPDATE teams SET lead_id = $1 WHERE id = $2`, [U.lead.id, TEAM]);
    // Organisation schedule 09:00–18:00 every day, 10 min grace.
    const days = Object.fromEntries(['1', '2', '3', '4', '5', '6', '7'].map((d) => [d, { start: '09:00', end: '18:00', expectedHours: 8 }]));
    await q(`INSERT INTO work_schedules (org_id, days, grace_minutes, effective_from) VALUES ($1, $2::jsonb, 10, '2026-01-01')`, [ORG, JSON.stringify(days)]);
    // Today: Eva clocked in at 10:00 (50 min late), Sid at 08:50 and is on a break; Fay finished.
    const at = (hhmm: string) => fromZonedTime(`${today}T${hhmm}:00`, TZ);
    const session = (user: string, clockIn: Date, status: string, state: string, out: Date | null) =>
      q(`INSERT INTO attendance_sessions (org_id, user_id, device_id, work_date, clock_in_at, clock_out_at, clock_in_source, last_heartbeat_at, ip_in, status, current_state)
         VALUES ($1, $2, 'dev-1', $3, $4, $5, 'AUTO', now(), '127.0.0.1', $6, $7)`, [ORG, user, today, clockIn, out, status, state]);
    await session(U.emp.id, at('10:00'), 'OPEN', 'ACTIVE', null);
    await session(U.sub.id, at('08:50'), 'OPEN', 'ON_BREAK', null);
    await session(U.far.id, at('09:00'), 'CLOSED', 'ACTIVE', at('12:00'));
    // September daily summaries.
    const daily = (user: string, date: string, status: string, late: number, early: number, net: number, ot: number) =>
      q(`INSERT INTO attendance_daily (org_id, user_id, work_date, net_seconds, expected_seconds, late_minutes, early_leave_minutes, overtime_minutes, day_status) VALUES ($1, $2, $3, $4, 28800, $5, $6, $7, $8)`,
        [ORG, user, date, net, late, early, ot, status]);
    await daily(U.emp.id, '2026-09-01', 'PRESENT', 0, 0, 30_000, 20);
    await daily(U.emp.id, '2026-09-02', 'LATE', 15, 0, 27_000, 0);
    await daily(U.emp.id, '2026-09-03', 'ABSENT', 0, 0, 0, 0);
    await daily(U.sub.id, '2026-09-02', 'EARLY_LEAVE', 0, 45, 25_000, 0);
    await daily(U.far.id, '2026-09-01', 'PRESENT', 0, 0, 29_000, 0);
    // Timesheets: Eva's waits for approval; Sid's is approved with a payable.
    await q(`INSERT INTO timesheets (org_id, user_id, period_start, period_end, status, submitted_at) VALUES ($1, $2, '2026-09-07', '2026-09-13', 'SUBMITTED', now() - interval '2 days')`, [ORG, U.emp.id]);
    const sheet = (await q(`INSERT INTO timesheets (org_id, user_id, period_start, period_end, status) VALUES ($1, $2, '2026-09-07', '2026-09-13', 'DRAFT') RETURNING id`, [ORG, U.sub.id])).rows[0].id as string;
    await q(`INSERT INTO projects (id, org_id, code, name, manager_id) VALUES ($1, $2, 'BRG', 'Bridge', $3)`, [PROJECT, ORG, U.lead.id]);
    const entry = (date: string, minutes: number, billable: boolean) =>
      q(`INSERT INTO time_entries (org_id, user_id, timesheet_id, project_id, work_date, started_at, ended_at, minutes, source, billable) VALUES ($1, $2, $3, $4, $5, $5::date + time '09:00', $5::date + time '09:00' + ($6 || ' minutes')::interval, $6::int, 'TIMER', $7)`,
        [ORG, U.sub.id, sheet, PROJECT, date, String(minutes), billable]);
    await entry('2026-09-08', 120, true);
    await entry('2026-09-09', 60, false);
    const payable = { rateType: 'HOURLY', currency: 'USD', amount: '500.00', regularMinutes: 180, overtimeMinutes: 0, days: 2, final: true, lines: [{ projectId: PROJECT, projectName: 'Bridge', rate: '166.67', regularMinutes: 180, overtimeMinutes: 0, amount: '500.00' }] };
    await q(`UPDATE timesheets SET status = 'APPROVED', amount = 500.00, currency = 'USD', payable = $2::jsonb, approved_at = now() WHERE id = $1`, [sheet, JSON.stringify(payable)]);
    // Tasks: Eva has one overdue and one finished (late estimate); Fay has one overdue.
    const task = (assignee: string, title: string, status: string, due: string | null, completed: string | null, est: number | null, actual: number | null) =>
      q(`INSERT INTO tasks (org_id, project_id, title, status, assignee_id, reporter_id, due_date, completed_at, estimate_minutes, actual_minutes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [ORG, PROJECT, title, status, assignee, U.lead.id, due, completed, est, actual]);
    await task(U.emp.id, 'Fix the fence', 'TODO', plusDays(-3), null, 120, null);
    await task(U.emp.id, 'Paint the gate', 'DONE', '2026-09-20', '2026-09-15T10:00:00Z', 60, 90);
    await task(U.far.id, 'Audit the office', 'IN_PROGRESS', plusDays(-1), null, 30, null);
    // Documents: Eva has a valid ID and an expired contract, plus a confidential one expiring soon; Fay's NDA expires in 10 days.
    const doc = (owner: string, title: string, category: string, expires: string | null) =>
      q(`INSERT INTO documents (org_id, title, category, owner_id, linked_user_id, expires_at) VALUES ($1, $2, $3, $4, $4, $5)`, [ORG, title, category, owner, expires]);
    await doc(U.emp.id, 'Passport Eva', 'IDENTITY', plusDays(400));
    await doc(U.emp.id, 'Old contract Eva', 'CONTRACT', plusDays(-10));
    await q(`INSERT INTO documents (org_id, title, title_enc, meta_key_wrapped, category, confidentiality, owner_id, linked_user_id, expires_at) VALUES ($1, NULL, decode('00', 'hex'), decode('00', 'hex'), 'CERTIFICATE', 'CONFIDENTIAL', $2, $2, $3)`, [ORG, U.emp.id, plusDays(5)]);
    await doc(U.far.id, 'NDA Fay', 'NDA', plusDays(10));
    await q(`INSERT INTO contracts (org_id, user_id, title, start_date, end_date, status, renewal_notice_days) VALUES ($1, $2, 'Fay contract', '2026-01-01', $3, 'ACTIVE', 30)`, [ORG, U.far.id, plusDays(20)]);

    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(3096);
    base = 'http://localhost:3096';
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD, ...(who === 'hr' ? { totpCode: await freshCode(SECRET) } : {}) }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
      assert.ok(tokens[who], `login ${who}`);
    }
  });

  after(async () => {
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.end();
  });

  describe('Scope (FR-REP-008)', { concurrency: false }, () => {
    it('employees and subcontractors get 403 on every report route', async () => {
      for (const path of ['/reports/dashboard', `/reports/attendance?${RANGE}`, `/reports/hours-cost?${RANGE}`, `/reports/tasks?${RANGE}`, '/reports/compliance', '/reports/compliance/requirements']) {
        assert.equal((await api('emp', path)).status, 403, path);
        assert.equal((await api('sub', path)).status, 403, path);
      }
    });

    it('a team lead sees their team; HR sees the organisation; filters never widen the scope', async () => {
      const lead = await ok(await api('lead', `/reports/attendance?${RANGE}&groupBy=user`), 200, AttendanceReportSchema);
      assert.equal(lead.scope, 'team');
      assert.deepEqual(lead.rows.map((r) => r.label).sort(), ['Eva Emp', 'Sid Sub']);
      const hr = await ok(await api('hr', `/reports/attendance?${RANGE}&groupBy=user`), 200, AttendanceReportSchema);
      assert.equal(hr.scope, 'all');
      assert.deepEqual(hr.rows.map((r) => r.label).sort(), ['Eva Emp', 'Fay Far', 'Sid Sub']);
      const widened = await ok(await api('lead', `/reports/attendance?${RANGE}&groupBy=user&userId=${U.far.id}`), 200, AttendanceReportSchema);
      assert.deepEqual(widened.rows, []);
      const byTeam = await ok(await api('lead', `/reports/attendance?${RANGE}&groupBy=user&teamId=${TEAM2}`), 200, AttendanceReportSchema);
      assert.deepEqual(byTeam.rows, []);
    });
  });

  describe('Manager dashboard (FR-REP-001)', { concurrency: false }, () => {
    it('shows today for the team: who is working, late arrivals, approvals, overdue tasks and expiring items', async () => {
      const d = await ok(await api('lead', '/reports/dashboard'), 200, DashboardSchema);
      assert.equal(d.today, today);
      assert.equal(d.scope, 'team');
      assert.equal(d.peopleInScope, 3, 'lead, Eva and Sid');
      assert.deepEqual(d.attendance, { working: 1, onBreak: 1, finished: 0, notYetIn: 1, onLeaveOrOff: 0 });
      assert.equal(d.lateArrivals.length, 1);
      assert.equal(d.lateArrivals[0]!.user.id, U.emp.id);
      assert.equal(d.lateArrivals[0]!.lateMinutes, 50, '10:00 against 09:00 with 10 min grace');
      assert.equal(d.lateArrivals[0]!.expectedStart, '09:00');
      assert.equal(d.pendingApprovals.timesheets, 1);
      assert.ok(d.pendingApprovals.oldestSubmittedAt);
      assert.deepEqual(d.overdueTasks.map((t) => t.title), ['Fix the fence']);
      assert.equal(d.overdueTasks[0]!.daysOverdue, 3);
      assert.equal(d.overdueTaskCount, 1);
      assert.deepEqual(d.expiring.map((e) => e.title), ['(confidential)'], 'the confidential title is never shown; Fay is out of scope');
      assert.equal(d.expiring[0]!.daysLeft, 5);
    });

    it('HR sees everyone, including the other team\'s overdue task, NDA and contract', async () => {
      const d = await ok(await api('hr', '/reports/dashboard'), 200, DashboardSchema);
      assert.equal(d.peopleInScope, 5);
      assert.deepEqual(d.attendance, { working: 1, onBreak: 1, finished: 1, notYetIn: 2, onLeaveOrOff: 0 });
      assert.equal(d.overdueTaskCount, 2);
      assert.deepEqual(d.expiring.map((e) => `${e.kind}:${e.title}`), ['DOCUMENT:(confidential)', 'DOCUMENT:NDA Fay', 'CONTRACT:Fay contract']);
    });
  });

  describe('Attendance report (FR-REP-002)', { concurrency: false }, () => {
    it('per person: present, late, absent, early leave, net and overtime; totals across the scope', async () => {
      const r = await ok(await api('lead', `/reports/attendance?${RANGE}&groupBy=user`), 200, AttendanceReportSchema);
      const eva = r.rows.find((x) => x.label === 'Eva Emp')!;
      assert.equal(eva.daysPresent, 2);
      assert.equal(eva.daysLate, 1);
      assert.equal(eva.lateMinutes, 15);
      assert.equal(eva.daysAbsent, 1);
      assert.equal(eva.netMinutes, 950);
      assert.equal(eva.overtimeMinutes, 20);
      const sid = r.rows.find((x) => x.label === 'Sid Sub')!;
      assert.equal(sid.daysEarlyLeave, 1);
      assert.equal(sid.earlyLeaveMinutes, 45);
      assert.equal(r.totals.people, 2);
      assert.equal(r.totals.daysPresent, 3);
      assert.equal(r.totals.netMinutes, Math.round((30_000 + 27_000 + 25_000) / 60));
    });

    it('groups by team, day, week and month; refuses more than a year', async () => {
      const team = await ok(await api('hr', `/reports/attendance?${RANGE}&groupBy=team`), 200, AttendanceReportSchema);
      assert.deepEqual(team.rows.map((x) => [x.label, x.people]), [['Field', 2], ['Office', 1]]);
      const day = await ok(await api('hr', `/reports/attendance?${RANGE}&groupBy=day`), 200, AttendanceReportSchema);
      assert.deepEqual(day.rows.map((x) => x.key), ['2026-09-01', '2026-09-02', '2026-09-03']);
      const week = await ok(await api('hr', `/reports/attendance?${RANGE}&groupBy=week`), 200, AttendanceReportSchema);
      assert.deepEqual(week.rows.map((x) => x.key), ['2026-08-31']);
      const month = await ok(await api('hr', `/reports/attendance?${RANGE}&groupBy=month`), 200, AttendanceReportSchema);
      assert.deepEqual(month.rows.map((x) => [x.key, x.people]), [['2026-09', 3]]);
      assert.equal((await api('hr', '/reports/attendance?from=2025-01-01&to=2026-06-01')).status, 400);
      assert.equal((await api('hr', '/reports/attendance?from=2026-09-30&to=2026-09-01')).status, 400);
    });
  });

  describe('Hours and cost report (FR-REP-003)', { concurrency: false }, () => {
    it('hours from entries, cost from approved payables, per person, project and month', async () => {
      const byUser = await ok(await api('lead', `/reports/hours-cost?${RANGE}&groupBy=user`), 200, CostReportSchema);
      assert.equal(byUser.rows.length, 1);
      assert.equal(byUser.rows[0]!.label, 'Sid Sub');
      assert.equal(byUser.rows[0]!.loggedMinutes, 180);
      assert.equal(byUser.rows[0]!.billableMinutes, 120);
      assert.equal(byUser.rows[0]!.approvedMinutes, 180);
      assert.deepEqual(byUser.rows[0]!.cost, { USD: '500.00' });
      const byProject = await ok(await api('lead', `/reports/hours-cost?${RANGE}&groupBy=project`), 200, CostReportSchema);
      assert.deepEqual(byProject.rows.map((r) => [r.label, r.cost.USD]), [['Bridge', '500.00']]);
      const byMonth = await ok(await api('hr', `/reports/hours-cost?${RANGE}&groupBy=month`), 200, CostReportSchema);
      assert.deepEqual(byMonth.rows.map((r) => [r.key, r.loggedMinutes, r.cost.USD]), [['2026-09', 180, '500.00']]);
      const outside = await ok(await api('hr', `/reports/hours-cost?from=2026-10-01&to=2026-10-31&groupBy=user`), 200, CostReportSchema);
      assert.deepEqual(outside.rows, []);
    });
  });

  describe('Tasks and workload report (FR-REP-004)', { concurrency: false }, () => {
    it('per assignee: open, overdue, completed on time, estimate vs actual and a load index', async () => {
      const r = await ok(await api('lead', `/reports/tasks?${RANGE}`), 200, TaskReportSchema);
      assert.deepEqual(r.rows.map((x) => x.user.id).sort(), [U.emp.id, U.lead.id, U.sub.id].sort(), 'everyone in scope, with or without tasks');
      const eva = r.rows.find((x) => x.user.id === U.emp.id)!;
      assert.equal(eva.open, 1);
      assert.equal(eva.overdue, 1);
      assert.equal(eva.completed, 1);
      assert.equal(eva.completedOnTime, 1);
      assert.equal(eva.estimateMinutes, 60);
      assert.equal(eva.actualMinutes, 90);
      assert.equal(eva.remainingEstimateMinutes, 120);
      assert.equal(r.averageRemainingEstimateMinutes, 40);
      assert.equal(eva.loadIndex, 3);
      const sid = r.rows.find((x) => x.user.id === U.sub.id)!;
      assert.equal(sid.open, 0);
      assert.equal(sid.loadIndex, 0);
      const hr = await ok(await api('hr', `/reports/tasks?${RANGE}`), 200, TaskReportSchema);
      assert.equal(hr.rows.find((x) => x.user.id === U.far.id)!.overdue, 1);
    });
  });

  describe('Compliance report (FR-REP-005)', { concurrency: false }, () => {
    it('HR sets required categories per role (audited); team leads may read them but not change them', async () => {
      assert.equal((await api('lead', '/reports/compliance/requirements', { method: 'PUT', body: { items: [{ role: 'EMPLOYEE', categories: ['IDENTITY'] }] } })).status, 403);
      const saved = await ok<{ items: Array<{ role: string; categories: string[] }> }>(await api('hr', '/reports/compliance/requirements', { method: 'PUT', body: { items: [{ role: 'EMPLOYEE', categories: ['IDENTITY', 'CONTRACT'] }, { role: 'SUBCONTRACTOR', categories: ['NDA'] }] } }), 200);
      assert.deepEqual(saved.items, [{ role: 'EMPLOYEE', categories: ['CONTRACT', 'IDENTITY'] }, { role: 'SUBCONTRACTOR', categories: ['NDA'] }]);
      assert.equal((await api('hr', '/reports/compliance/requirements', { method: 'PUT', body: { items: [{ role: 'EMPLOYEE', categories: ['PASSPORT'] }] } })).status, 400);
      const read = await ok<{ items: unknown[] }>(await api('lead', '/reports/compliance/requirements'), 200);
      assert.equal(read.items.length, 2);
      const audit = await adminPool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = 'COMPLIANCE_REQUIREMENTS_UPDATED'`, [ORG]);
      assert.equal(audit.rows[0].n, 1);
    });

    it('lists missing and expired documents per person; onboarding is reported as not available', async () => {
      const r = await ok(await api('lead', '/reports/compliance'), 200, ComplianceReportSchema);
      assert.equal(r.canEditRequirements, false);
      const eva = r.rows.find((x) => x.user.id === U.emp.id)!;
      assert.deepEqual(eva.missing, ['CONTRACT'], 'the only contract is expired, so no valid one');
      assert.deepEqual(eva.expired.map((d) => d.title), ['Old contract Eva']);
      assert.deepEqual(eva.expiringSoon.map((d) => d.title), ['(confidential)']);
      assert.equal(eva.compliant, false);
      assert.equal(eva.onboarding, 'NOT_AVAILABLE');
      const sid = r.rows.find((x) => x.user.id === U.sub.id)!;
      assert.deepEqual(sid.missing, ['NDA']);
      const lead = r.rows.find((x) => x.user.id === U.lead.id)!;
      assert.equal(lead.compliant, true, 'no requirements for team leads');
      assert.deepEqual(r.summary, { people: 3, compliant: 1, withMissing: 2, withExpired: 1 });
      const issues = await ok(await api('lead', '/reports/compliance?onlyIssues=true'), 200, ComplianceReportSchema);
      assert.deepEqual(issues.rows.map((x) => x.user.id).sort(), [U.emp.id, U.sub.id].sort());
      const hr = await ok(await api('hr', '/reports/compliance'), 200, ComplianceReportSchema);
      assert.equal(hr.canEditRequirements, true);
      assert.deepEqual(hr.rows.find((x) => x.user.id === U.far.id)!.expiringSoon.map((d) => d.title), ['NDA Fay']);
    });
  });

  describe('Exports (FR-REP-006)', { concurrency: false }, () => {
    it('every report exports as CSV, XLSX and PDF, and each export is audited', async () => {
      const before = (await adminPool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = 'REPORT_EXPORTED'`, [ORG])).rows[0].n as number;
      const reports = [`/reports/attendance?${RANGE}&groupBy=user`, `/reports/hours-cost?${RANGE}&groupBy=project`, `/reports/tasks?${RANGE}`, '/reports/compliance?onlyIssues=true'];
      for (const path of reports) {
        for (const [format, type, magic] of [['csv', 'text/csv', '﻿'], ['xlsx', 'spreadsheetml', 'PK'], ['pdf', 'application/pdf', '%PDF']] as const) {
          const res = await api('hr', `${path}&format=${format}`);
          assert.equal(res.status, 200, `${path} ${format}`);
          assert.match(res.headers.get('content-type') ?? '', new RegExp(type));
          assert.match(res.headers.get('content-disposition') ?? '', new RegExp(`attachment; filename=".*\\.${format}"`));
          const buf = Buffer.from(await res.arrayBuffer());
          assert.ok(buf.length > 20, `${path} ${format} is empty`);
          assert.equal(buf.toString('utf8', 0, magic.length === 1 ? 3 : magic.length) === magic || buf.toString('latin1', 0, magic.length) === magic, true, `${format} magic`);
        }
      }
      const csv = await (await api('lead', `/reports/attendance?${RANGE}&groupBy=user&format=csv`)).text();
      assert.match(csv, /^\ufeff?Person,People,Days present/); // fetch strips the BOM; the arrayBuffer check above saw it
      assert.match(csv, /Eva Emp,1,2,1,15/);
      assert.doesNotMatch(csv, /Fay Far/, 'exports keep the viewer scope');
      const after = (await adminPool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = 'REPORT_EXPORTED'`, [ORG])).rows[0].n as number;
      assert.equal(after - before, reports.length * 3 + 1);
    });
  });
});
