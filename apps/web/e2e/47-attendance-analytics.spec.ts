import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { ORG_ID, USERS, adminPool } from './fixtures';
import { passNoticeGate, signIn, signInAdmin } from './helpers';

/**
 * HR attendance analytics (FR-REP-009, ADR 059) in the browser: the Reports tab (summary, table,
 * period presets and custom dates, team and person filters, grouping, sorting by mouse and
 * keyboard, paging, CSV/XLSX/PDF export), the employee detail page, a manager limited to their
 * team without export, an employee with only their own data (My attendance card and detail page,
 * meeting titles only for them), empty and error states, the phone layout, and the office notice
 * on "What we collect". Its own data is seeded in October 2026 and removed afterwards.
 * ANALYTICS_SHOTS_DIR=<dir> also writes screenshots.
 */
const FROM = '2026-10-05';
const TO = '2026-10-11';
const id = (n: string) => `66660000-0000-4000-8000-0000000a${n}`;
const MEETING = id('0f01');
const shotsDir = process.env.ANALYTICS_SHOTS_DIR;
async function shot(p: Page, name: string): Promise<void> {
  const path = shotsDir ? join(shotsDir, `${name}.png`) : test.info().outputPath(`${name}.png`);
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  await p.screenshot({ path, fullPage: true });
}

async function person(browser: Browser, who: 'admin' | 'lead' | 'worker', opts: BrowserContextOptions = {}) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 404|status of 500/.test(m.text())) errors.push(m.text()); });
  if (who === 'admin') await signInAdmin(page);
  else { await signIn(page, USERS[who].email); await passNoticeGate(page); }
  return { page, errors, close: () => ctx.close() };
}

/** Opens the analytics tab with a custom range. */
async function openTab(p: Page, from = FROM, to = TO): Promise<void> {
  await p.goto('/reports');
  await p.getByRole('tab', { name: 'Attendance analytics' }).click();
  await p.getByLabel('Period', { exact: true }).selectOption('custom');
  await p.getByLabel('From', { exact: true }).fill(from);
  await p.getByLabel('To', { exact: true }).fill(to);
}
const table = (p: Page) => p.getByTestId('analytics-table');

test.describe.serial('HR attendance analytics (ADR 059)', () => {
  test.beforeAll(async () => {
    const pool = adminPool();
    try {
      await cleanup(pool);
      const session = (sid: string, userId: string, day: string, inAt: string, outAt: string, net: number, meet: number) => pool.query(
        `INSERT INTO attendance_sessions (id, org_id, user_id, device_id, work_date, clock_in_at, clock_out_at, clock_in_source, clock_out_source,
           active_seconds, idle_seconds, break_seconds, meeting_seconds, net_seconds, last_heartbeat_at, ip_in, status, current_state)
         VALUES ($1, $2, $3, 'e2e-analytics', $4, $5::timestamptz, $6::timestamptz, 'AUTO_HEARTBEAT', 'LOGOUT', $7, 0, 0, $8, $7, $6::timestamptz, '10.0.0.1', 'CLOSED', 'OFFLINE')`,
        [sid, ORG_ID, userId, day, inAt, outAt, net, meet]);
      // Wendy: Monday 09:00-17:00 Colombo (late 15 min), Tuesday 09:00-13:00; Sam: Monday; Hana (HR, no team): Monday.
      await session(id('0a01'), USERS.worker.id, '2026-10-05', '2026-10-05T03:30:00Z', '2026-10-05T11:30:00Z', 28800, 3600);
      await session(id('0a02'), USERS.worker.id, '2026-10-06', '2026-10-06T03:30:00Z', '2026-10-06T07:30:00Z', 14400, 0);
      await session(id('0a03'), USERS.sub.id, '2026-10-05', '2026-10-05T04:00:00Z', '2026-10-05T10:00:00Z', 21600, 0);
      await session(id('0a04'), USERS.hr.id, '2026-10-05', '2026-10-05T03:00:00Z', '2026-10-05T11:00:00Z', 28800, 0);
      await pool.query(`INSERT INTO attendance_segments (org_id, session_id, state, started_at, ended_at, duration_seconds) VALUES
        ($1, $2, 'ACTIVE', '2026-10-05T03:30:00Z', '2026-10-05T05:00:00Z', 5400), ($1, $2, 'IN_MEETING', '2026-10-05T05:00:00Z', '2026-10-05T06:00:00Z', 3600)`, [ORG_ID, id('0a01')]);
      await pool.query(`INSERT INTO attendance_daily (org_id, user_id, work_date, first_in, last_out, net_seconds, meeting_seconds, late_minutes, day_status) VALUES
        ($1, $2, '2026-10-05', '2026-10-05T03:30:00Z', '2026-10-05T11:30:00Z', 28800, 3600, 15, 'LATE'),
        ($1, $3, '2026-10-05', '2026-10-05T04:00:00Z', '2026-10-05T10:00:00Z', 21600, 0, 0, 'PRESENT'),
        ($1, $4, '2026-10-05', '2026-10-05T03:00:00Z', '2026-10-05T11:00:00Z', 28800, 0, 0, 'PRESENT')
        ON CONFLICT (org_id, user_id, work_date) DO NOTHING`, [ORG_ID, USERS.worker.id, USERS.sub.id, USERS.hr.id]);
      // Office: two tabs on Monday morning (4 h together), and over midnight into Tuesday.
      await pool.query(`INSERT INTO office_presence_intervals (org_id, user_id, started_at, ended_at, last_seen_at, end_reason) VALUES
        ($1, $2, '2026-10-05T03:30:00Z', '2026-10-05T06:30:00Z', '2026-10-05T06:30:00Z', 'LEFT'),
        ($1, $2, '2026-10-05T05:30:00Z', '2026-10-05T07:30:00Z', '2026-10-05T07:30:00Z', 'DROPPED'),
        ($1, $2, '2026-10-05T17:30:00Z', '2026-10-05T20:00:00Z', '2026-10-05T20:00:00Z', 'LEFT')`, [ORG_ID, USERS.worker.id]);
      await pool.query(`INSERT INTO meetings (id, org_id, type, status, title, host_id, livekit_room_name, scheduled_start, scheduled_end, ended_at)
        VALUES ($1, $2, 'SCHEDULED', 'ENDED', 'Quarterly review', $3, 'e2e-analytics-m1', '2026-10-05T05:00:00Z', '2026-10-05T06:00:00Z', '2026-10-05T06:00:00Z')`, [MEETING, ORG_ID, USERS.lead.id]);
      await pool.query(`INSERT INTO meeting_participants (org_id, meeting_id, user_id, livekit_sid, joined_at, left_at) VALUES
        ($1, $2, $3, 'PA_e2e_1', '2026-10-05T05:00:00Z', '2026-10-05T05:40:00Z'), ($1, $2, $3, 'PA_e2e_2', '2026-10-05T05:30:00Z', '2026-10-05T06:00:00Z')`, [ORG_ID, MEETING, USERS.worker.id]);
      await pool.query(`INSERT INTO attendance_corrections (org_id, user_id, requested_in, requested_out, reason, status) VALUES ($1, $2, '2026-10-06T03:00:00Z', '2026-10-06T08:00:00Z', 'e2e analytics', 'PENDING')`, [ORG_ID, USERS.worker.id]);
    } finally {
      await pool.end();
    }
  });

  test.afterAll(async () => {
    const pool = adminPool();
    try { await cleanup(pool); } finally { await pool.end(); }
  });

  test('HR: summary, table, filters, grouping, sorting, export and the employee detail page', async ({ browser }) => {
    test.setTimeout(180_000);
    const a = await person(browser, 'admin', { viewport: { width: 1440, height: 900 } });
    const p = a.page;
    await openTab(p);
    await expect(table(p)).toBeVisible();
    await expect(p.getByTestId('analytics-definitions')).toContainText('not proof of work');
    const wendy = table(p).getByRole('row').filter({ hasText: USERS.worker.name });
    await expect(wendy).toHaveCount(2);
    const monday = wendy.filter({ hasText: /Oct 5|5 Oct/ });
    await expect(monday).toContainText('09:00');
    await expect(monday).toContainText('17:00');
    await expect(monday).toContainText('8h 00m'); // work attendance
    await expect(monday).toContainText('5h 00m'); // office: two tabs counted once, plus an hour before midnight
    await expect(monday).toContainText('1h 00m'); // meeting time
    await expect(monday).toContainText('Late');
    await expect(table(p).getByRole('row').filter({ hasText: USERS.hr.name })).toHaveCount(1);
    await expect(p.getByTestId('stat-present')).toContainText('3 of');
    await expect(p.getByTestId('analytics-export')).toBeVisible();
    await shot(p, 'analytics-01-hr-dashboard');

    // Team and person filters, then grouping by week.
    await p.getByLabel('Team', { exact: true }).selectOption({ label: 'Support' });
    await expect(table(p).getByRole('row').filter({ hasText: USERS.hr.name })).toHaveCount(0);
    await expect(table(p).getByRole('row').filter({ hasText: USERS.sub.name })).toHaveCount(1);
    await p.getByLabel('Person', { exact: true }).selectOption({ label: USERS.worker.name });
    await expect(table(p).getByRole('row').filter({ hasText: USERS.sub.name })).toHaveCount(0);
    await p.getByLabel('Group by', { exact: true }).selectOption('week');
    await expect(table(p).getByRole('row').filter({ hasText: USERS.worker.name })).toHaveCount(1);
    await expect(table(p)).toContainText('Week of');
    await expect(table(p)).toContainText('12h 00m');
    await p.getByLabel('Person', { exact: true }).selectOption('');
    await p.getByLabel('Team', { exact: true }).selectOption('');
    await p.getByLabel('Group by', { exact: true }).selectOption('day');

    // Sorting by keyboard: Tab to the "Work attendance" header and press Enter, twice.
    const workHeader = table(p).getByRole('columnheader', { name: /Work attendance/ });
    await workHeader.getByRole('button').focus();
    await p.keyboard.press('Enter');
    await expect(workHeader).toHaveAttribute('aria-sort', 'descending');
    await expect(table(p).getByRole('row').nth(1)).toContainText('8h 00m');
    await p.keyboard.press('Enter');
    await expect(workHeader).toHaveAttribute('aria-sort', 'ascending');
    await expect(table(p).getByRole('row').nth(1)).toContainText('4h 00m');
    await expect(p.getByTestId('analytics-count')).toContainText('4 rows');

    // Exports, each a real file.
    for (const fmt of ['CSV', 'XLSX', 'PDF']) {
      const wait = p.waitForEvent('download');
      await p.getByTestId('analytics-export').getByRole('button', { name: fmt }).click();
      const d = await wait;
      expect(d.suggestedFilename()).toMatch(new RegExp(`^attendance-analytics-by-day-\\d{4}-\\d{2}-\\d{2}\\.${fmt.toLowerCase()}$`));
    }

    // The detail page: titles of other people's meetings are not shown to HR.
    await table(p).getByRole('link', { name: USERS.worker.name }).first().click();
    await expect(p.getByRole('heading', { name: USERS.worker.name })).toBeVisible();
    await expect(p.getByTestId('person-total-work')).toContainText('12h 00m');
    await expect(p.getByTestId('person-total-office')).toContainText('6h 30m');
    await expect(p.getByTestId('person-meetings')).toContainText('Scheduled meeting');
    await expect(p.getByTestId('person-meetings')).not.toContainText('Quarterly review');
    await expect(p.locator('ol[data-testid="person-office"] li')).toHaveCount(3);
    await expect(p.getByTestId('person-corrections')).toContainText('Pending');
    await expect(p.getByTestId('person-weeks')).toContainText('Week of');
    // FR-REP-010: the work items section, a fourth measure apart from work time (numbers: API test).
    await expect(p.getByTestId('person-work')).toContainText('never added to it');
    await expect(p.getByTestId('work-task-time')).toContainText('Recorded task time');
    await expect(p.getByTestId('analytics-definitions')).toContainText('Recorded task time');
    await shot(p, 'analytics-02-hr-person-detail');
    expect(a.errors).toEqual([]);
    await a.close();
  });

  test('manager: their team only, no export; someone outside it is "not found"', async ({ browser }) => {
    const l = await person(browser, 'lead', { viewport: { width: 1440, height: 900 } });
    const p = l.page;
    await openTab(p);
    await expect(table(p).getByRole('row').filter({ hasText: USERS.worker.name })).toHaveCount(2);
    await expect(table(p).getByRole('row').filter({ hasText: USERS.hr.name })).toHaveCount(0);
    await expect(p.getByLabel('Person', { exact: true }).locator('option', { hasText: USERS.hr.name })).toHaveCount(0);
    await expect(p.getByTestId('analytics-export')).toHaveCount(0);
    await shot(p, 'analytics-03-manager');
    await p.goto(`/reports/attendance-analytics/${USERS.hr.id}?from=${FROM}&to=${TO}`);
    await expect(p.getByText('Person not found')).toBeVisible();
    expect(l.errors).toEqual([]);
    await l.close();
  });

  test('employee: no Reports; their own card and detail with their meeting titles; someone else\'s page is refused', async ({ browser }) => {
    const w = await person(browser, 'worker', { viewport: { width: 1440, height: 900 } });
    const p = w.page;
    await p.goto('/reports');
    await expect(p.getByText("You don't have access")).toBeVisible();
    await p.goto(`/reports/attendance-analytics/${USERS.hr.id}?from=${FROM}&to=${TO}`);
    await expect(p.getByText("You don't have access")).toBeVisible();
    await p.goto('/attendance');
    await expect(p.getByTestId('my-analytics-card')).toContainText('not work time');
    await p.getByTestId('my-analytics-card').getByRole('link', { name: 'See details' }).click();
    await expect(p.getByRole('heading', { name: 'My attendance analytics' })).toBeVisible();
    await p.getByLabel('From', { exact: true }).fill(FROM);
    await p.getByLabel('To', { exact: true }).fill(TO);
    await expect(p.getByTestId('person-total-work')).toContainText('12h 00m');
    await expect(p.getByTestId('person-meetings')).toContainText('Quarterly review');
    await expect(p.getByTestId('person-meetings')).toContainText('1h 00m'); // a reconnect counted once
    await shot(p, 'analytics-04-employee-own');
    await p.goto('/attendance/transparency');
    await expect(p.getByTestId('office-time-notice')).toContainText('Nothing about which room you are in');
    expect(w.errors).toEqual([]);
    await w.close();
  });

  test('empty and error states', async ({ browser }) => {
    const a = await person(browser, 'admin', { viewport: { width: 1440, height: 900 } });
    const p = a.page;
    await openTab(p, '2020-01-06', '2020-01-12');
    await expect(p.getByText('No attendance in this period')).toBeVisible();
    await p.route('**/reports/attendance-analytics?*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusCode: 500, message: 'Internal server error' }) }));
    await p.getByLabel('From', { exact: true }).fill('2020-01-05');
    await expect(p.getByRole('button', { name: /Try again|Retry/ })).toBeVisible();
    await p.unroute('**/reports/attendance-analytics?*');
    await p.getByRole('button', { name: /Try again|Retry/ }).click();
    await expect(p.getByText('No attendance in this period')).toBeVisible();
    await a.close();
  });

  test('phone (390 x 844): filters, table and detail fit; the page never scrolls sideways', async ({ browser }) => {
    const a = await person(browser, 'admin', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const p = a.page;
    await p.goto('/reports');
    await p.getByRole('tab', { name: 'Attendance analytics' }).tap();
    await p.getByLabel('Period', { exact: true }).selectOption('custom');
    await p.getByLabel('From', { exact: true }).fill(FROM);
    await p.getByLabel('To', { exact: true }).fill(TO);
    await expect(table(p)).toBeVisible();
    expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await shot(p, 'analytics-05-phone-dashboard');
    await table(p).getByRole('link', { name: USERS.worker.name }).first().tap();
    await expect(p.getByTestId('person-summary')).toBeVisible();
    expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await shot(p, 'analytics-06-phone-detail');
    expect(a.errors).toEqual([]);
    await a.close();
  });
});

async function cleanup(pool: ReturnType<typeof adminPool>): Promise<void> {
  await pool.query(`DELETE FROM attendance_sessions WHERE org_id = $1 AND device_id = 'e2e-analytics'`, [ORG_ID]);
  await pool.query(`DELETE FROM attendance_daily WHERE org_id = $1 AND work_date BETWEEN $2 AND $3`, [ORG_ID, FROM, TO]);
  await pool.query(`DELETE FROM office_presence_intervals WHERE org_id = $1 AND started_at < '2026-10-12T00:00:00Z' AND started_at >= '2026-10-04T00:00:00Z'`, [ORG_ID]);
  await pool.query(`DELETE FROM meetings WHERE id = $1`, [MEETING]);
  await pool.query(`DELETE FROM attendance_corrections WHERE org_id = $1 AND reason = 'e2e analytics'`, [ORG_ID]);
}
