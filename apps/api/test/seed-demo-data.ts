/**
 * Realistic history for the "Acme Demo" organisation created by seed-web-demo.ts: four weeks of
 * attendance, a project with tasks in every state, timesheets with time entries and an approved
 * payable, a contract that ends soon, required document categories, and policy values. Run it
 * after seed-web-demo.ts; it is idempotent (deletes what it created before). Documents are not
 * seeded: they need real uploads, which the UAT runbook walks through.
 *
 *   node --experimental-strip-types apps/api/test/seed-demo-data.ts
 */
import pg from 'pg';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import './support/refuse-in-production.ts';

const ORG = '44440000-0000-4000-8000-000000000001';
const TZ = 'Asia/Colombo';
const U = {
  hr: '44440000-0000-4000-8000-000000000011',
  lead: '44440000-0000-4000-8000-000000000012',
  worker: '44440000-0000-4000-8000-000000000013',
  sam: '44440000-0000-4000-8000-000000000014',
  admin: '44440000-0000-4000-8000-000000000015',
};
const PROJECT = '44440000-0000-4000-8000-000000000201';

const day = (offset: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return formatInTimeZone(d, TZ, 'yyyy-MM-dd');
};
const at = (date: string, hhmm: string): Date => fromZonedTime(`${date}T${hhmm}:00`, TZ);
const weekday = (date: string): number => ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1; // 1 = Monday

async function main(): Promise<void> {
  const pool = new pg.Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5433),
    database: process.env.PGDATABASE || 'hrvo_dev',
    user: process.env.PGADMIN_USER || 'postgres',
    password: process.env.PGADMIN_PASSWORD || 'postgres',
  });
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  try {
    const org = await q(`SELECT id FROM organizations WHERE id = $1`, [ORG]);
    if (org.rows.length === 0) throw new Error('Run seed-web-demo.ts first');

    // Clean what this script owns.
    for (const t of ['presence_events', 'attendance_daily', 'attendance_sessions', 'time_entries', 'timesheet_approvals', 'timesheets', 'task_comments', 'tasks', 'project_members', 'projects', 'contracts', 'work_schedules', 'required_document_categories', 'notifications', 'monitoring_consents', 'subcontractor_profiles']) {
      await q(`DELETE FROM ${t} WHERE org_id = $1`, [ORG]);
    }

    // Policy and schedule: 09:00–18:00 Monday to Friday, 10 minutes grace.
    const days = Object.fromEntries(['1', '2', '3', '4', '5'].map((d) => [d, { start: '09:00', end: '18:00', expectedHours: 8 }]));
    await q(`INSERT INTO work_schedules (org_id, days, grace_minutes, effective_from) VALUES ($1, $2::jsonb, 10, '2026-01-01')`, [ORG, JSON.stringify(days)]);
    await q(`UPDATE organizations SET att_idle_seconds = 300, att_pause_seconds = 900, manual_time_limit_minutes = 120, timesheet_variance_pct = 15, vault_reauth_minutes = 10 WHERE id = $1`, [ORG]);
    await q(`INSERT INTO required_document_categories (org_id, role, category) VALUES ($1, 'EMPLOYEE', 'IDENTITY'), ($1, 'SUBCONTRACTOR', 'CONTRACT'), ($1, 'SUBCONTRACTOR', 'NDA'), ($1, 'SUBCONTRACTOR', 'TAX')`, [ORG]);
    // Everyone has accepted the monitoring notice, so the first sign-in goes straight to the app.
    for (const id of Object.values(U)) await q(`INSERT INTO monitoring_consents (org_id, user_id, notice_version, accepted_at, ip) VALUES ($1, $2, 'v1.0.0', now() - interval '35 days', '10.1.0.7')`, [ORG, id]);

    // Four weeks of attendance for Wendy (employee) and Sam (subcontractor), weekdays only.
    const people = [
      { id: U.worker, start: '08:55', end: '17:40', lateDays: [3, 11], shortDays: [8] },
      { id: U.sam, start: '09:20', end: '18:30', lateDays: [1, 2, 5, 9, 12, 16], shortDays: [] },
    ];
    let workdayIndex = 0;
    for (let offset = -28; offset <= -1; offset += 1) {
      const date = day(offset);
      if (weekday(date) > 5) continue;
      workdayIndex += 1;
      for (const p of people) {
        if (p.id === U.worker && workdayIndex === 14) {
          await q(`INSERT INTO attendance_daily (org_id, user_id, work_date, net_seconds, expected_seconds, day_status) VALUES ($1, $2, $3, 0, 28800, 'LEAVE')`, [ORG, p.id, date]);
          continue;
        }
        const late = p.lateDays.includes(workdayIndex);
        const short = p.shortDays.includes(workdayIndex);
        const inAt = at(date, late ? '09:35' : p.start);
        const outAt = at(date, short ? '14:00' : p.end);
        const gross = Math.round((outAt.getTime() - inAt.getTime()) / 1000);
        const idle = 20 * 60 + (workdayIndex % 4) * 300;
        const brk = 45 * 60;
        const meeting = workdayIndex % 3 === 0 ? 30 * 60 : 0;
        const net = gross - idle - brk;
        await q(
          `INSERT INTO attendance_sessions (org_id, user_id, device_id, work_date, clock_in_at, clock_out_at, clock_in_source, clock_out_source, active_seconds, idle_seconds, break_seconds, meeting_seconds, net_seconds, last_heartbeat_at, ip_in, ip_out, status, current_state)
           VALUES ($1, $2, 'laptop', $3, $4, $5, 'AUTO', 'LOGOUT', $6, $7, $8, $9, $10, $5, '10.1.0.7', '10.1.0.7', 'CLOSED', 'ACTIVE')`,
          [ORG, p.id, date, inAt, outAt, gross - idle - brk, idle, brk, meeting, net],
        );
        const lateMin = late ? 25 : 0;
        const earlyMin = short ? 240 : 0;
        const overtime = Math.max(0, Math.round(net / 60) - 480);
        const status = short ? 'HALF_DAY' : late ? 'LATE' : 'PRESENT';
        await q(
          `INSERT INTO attendance_daily (org_id, user_id, work_date, first_in, last_out, active_seconds, idle_seconds, break_seconds, meeting_seconds, net_seconds, expected_seconds, late_minutes, early_leave_minutes, overtime_minutes, day_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 28800, $11, $12, $13, $14)`,
          [ORG, p.id, date, inAt, outAt, gross - idle - brk, idle, brk, meeting, net, lateMin, earlyMin, overtime, status],
        );
      }
    }

    // Project and tasks in every state.
    await q(`INSERT INTO projects (id, org_id, code, name, manager_id) VALUES ($1, $2, 'ACME-WEB', 'Acme website relaunch', $3)`, [PROJECT, ORG, U.lead]);
    await q(`INSERT INTO project_members (org_id, project_id, user_id) VALUES ($1, $2, $3), ($1, $2, $4), ($1, $2, $5)`, [ORG, PROJECT, U.lead, U.worker, U.sam]);
    const tasks: Array<[string, string, string, string | null, string | null, number | null, number | null, string, string]> = [
      // title, status, assignee, due, completed, estimate, actual, acceptance, priority
      ['Write the launch announcement', 'IN_PROGRESS', U.worker, day(3), null, 120, null, 'NOT_REQUIRED', 'HIGH'],
      ['Review the privacy page copy', 'TODO', U.worker, day(-2), null, 60, null, 'NOT_REQUIRED', 'MEDIUM'],
      ['Set up the newsletter form', 'DONE', U.worker, day(-5), day(-6), 90, 110, 'NOT_REQUIRED', 'MEDIUM'],
      ['Build the pricing page', 'IN_PROGRESS', U.sam, day(7), null, 480, null, 'ACCEPTED', 'HIGH'],
      ['Fix the mobile menu', 'DONE', U.sam, day(-3), day(-4), 120, 95, 'ACCEPTED', 'MEDIUM'],
      ['Migrate the blog images', 'BLOCKED', U.sam, day(1), null, 240, null, 'ACCEPTED', 'LOW'],
      ['Accessibility audit of the checkout', 'TODO', U.sam, day(10), null, 360, null, 'PENDING', 'HIGH'],
      ['Prepare the Q4 hiring plan', 'TODO', U.lead, day(14), null, 180, null, 'NOT_REQUIRED', 'MEDIUM'],
    ];
    for (const [title, status, assignee, due, completed, est, actual, acceptance, priority] of tasks) {
      const res = await q(
        `INSERT INTO tasks (org_id, project_id, title, description, status, priority, assignee_id, reporter_id, acceptance_status, acceptance_requested_at, accepted_at, due_date, estimate_minutes, actual_minutes, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text, CASE WHEN $9::text <> 'NOT_REQUIRED' THEN now() - interval '3 days' END, CASE WHEN $9::text = 'ACCEPTED' THEN now() - interval '3 days' END, $10::date, $11::int, $12::int, $13::timestamptz) RETURNING id`,
        [ORG, PROJECT, title, `Part of the **${title.toLowerCase()}** work for the relaunch. See the project brief for the acceptance criteria.`, status, priority, assignee, U.lead, acceptance, due, est, actual, completed ? `${completed}T10:00:00Z` : null],
      );
      if (title === 'Migrate the blog images') {
        await q(`INSERT INTO task_comments (org_id, task_id, author_id, body) VALUES ($1, $2, $3, 'Blocked: the old CDN export still has not arrived. @[Leo Lead](user:${U.lead}) can you chase it?')`, [ORG, res.rows[0].id, U.sam]);
      }
    }

    // Sam's rate, contract and timesheets: last week approved and paid, the week before approved, this week in progress.
    await q(`INSERT INTO subcontractor_profiles (user_id, org_id, rate_type, rate, currency, overtime_multiplier, weekly_hours_cap, updated_by) VALUES ($1, $2, 'HOURLY', 45.00, 'USD', 1.5, 40, $3)`, [U.sam, ORG, U.hr]);
    await q(`INSERT INTO contracts (org_id, user_id, title, scope, start_date, end_date, status, renewal_notice_days, created_by) VALUES ($1, $2, 'Front-end development 2026', 'Front-end work on the website relaunch, up to 40 hours a week.', '2026-01-15', $3, 'ACTIVE', 30, $4)`, [ORG, U.sam, day(25), U.hr]);
    const monday = (offset: number): string => { const d = day(offset); const w = weekday(d); return day(offset - (w - 1)); };
    const weeks = [
      { start: monday(-14), status: 'PAID', minutes: [480, 450, 510, 480, 420] },
      { start: monday(-7), status: 'APPROVED', minutes: [480, 495, 465, 480, 300] },
      { start: monday(0), status: 'DRAFT', minutes: [450, 480] },
    ];
    for (const w of weeks) {
      const end = day(Number(((Date.parse(`${w.start}T00:00:00Z`) - Date.parse(`${day(0)}T00:00:00Z`)) / 86_400_000).toFixed(0)) + 6);
      const total = w.minutes.reduce((a, b) => a + b, 0);
      const amount = ((total / 60) * 45).toFixed(2);
      const sheet = (await q(`INSERT INTO timesheets (org_id, user_id, period_start, period_end, status, logged_minutes, billable_minutes, attendance_minutes) VALUES ($1, $2, $3, $4, 'DRAFT', $5, $5, $6) RETURNING id`, [ORG, U.sam, w.start, end, total, total + 35])).rows[0].id;
      for (let i = 0; i < w.minutes.length; i += 1) {
        const d = day(Number(((Date.parse(`${w.start}T00:00:00Z`) - Date.parse(`${day(0)}T00:00:00Z`)) / 86_400_000).toFixed(0)) + i);
        await q(`INSERT INTO time_entries (org_id, user_id, timesheet_id, project_id, work_date, started_at, ended_at, minutes, source, billable, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'TIMER', true, 'Pricing page')`,
          [ORG, U.sam, sheet, PROJECT, d, at(d, '09:30'), new Date(at(d, '09:30').getTime() + w.minutes[i]! * 60_000), w.minutes[i]]);
      }
      if (w.status !== 'DRAFT') {
        const payable = { rateType: 'HOURLY', currency: 'USD', amount, regularMinutes: total, overtimeMinutes: 0, days: w.minutes.length, final: true, lines: [{ projectId: PROJECT, projectName: 'Acme website relaunch', rate: '45.00', regularMinutes: total, overtimeMinutes: 0, amount }] };
        await q(`UPDATE timesheets SET status = $2, submitted_at = $3::date + interval '1 day', approved_by = $4, approved_at = $3::date + interval '2 days', amount = $5, currency = 'USD', payable = $6::jsonb WHERE id = $1`, [sheet, w.status, end, U.lead, amount, JSON.stringify(payable)]);
        await q(`INSERT INTO timesheet_approvals (org_id, timesheet_id, action, actor_id, comment) VALUES ($1, $2, 'SUBMIT', $3, ''), ($1, $2, 'APPROVE', $4, 'Looks good, thanks Sam.')`, [ORG, sheet, U.sam, U.lead]);
      }
    }

    console.log('Demo history seeded: 4 weeks of attendance (Wendy, Sam), project ACME-WEB with 8 tasks, 3 timesheets for Sam, contract ending in 25 days, required document categories.');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('Seeding failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
