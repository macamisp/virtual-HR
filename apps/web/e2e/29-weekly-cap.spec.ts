import { expect, test } from '@playwright/test';
import { ORG_ID, USERS, adminPool } from './fixtures';
import { passNoticeGate, signIn, signOut } from './helpers';

/**
 * The weekly hours cap in the browser (FR-ORG-004; ADR 034): the subcontractor logs time, sees a
 * warning from 80 % and an alert from 100 % on their timesheet, and their manager is told.
 * Earlier specs may have logged time this week, so the cap is sized from what is already there.
 */
const REASON = 'Weekly cap check (e2e)';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
let capHours = 0;
let toWarn = 0;
let toOver = 0;

test.describe.serial('Weekly hours cap', () => {
  test.beforeAll(async () => {
    const pool = adminPool();
    try {
      const d = today();
      const dow = new Date(`${d}T12:00:00Z`).getUTCDay() || 7;
      const monday = new Date(Date.parse(`${d}T00:00:00Z`) - (dow - 1) * 86_400_000).toISOString().slice(0, 10);
      const existing = Number((await pool.query(`SELECT coalesce(sum(minutes), 0)::int AS m FROM time_entries WHERE user_id = $1 AND work_date >= $2::date AND ended_at IS NOT NULL`, [USERS.sub.id, monday])).rows[0].m);
      capHours = Math.max(2, Math.ceil(existing / 60) + 2);
      toWarn = Math.ceil(capHours * 60 * 0.85) - existing; // lands at about 85 %
      toOver = capHours * 60 - (existing + toWarn) + 10; // then past 100 %
      await pool.query(
        `INSERT INTO subcontractor_profiles (user_id, org_id, rate_type, rate, currency, weekly_hours_cap) VALUES ($1, $2, 'HOURLY', 25.50, 'USD', $3)
         ON CONFLICT (user_id) DO UPDATE SET weekly_hours_cap = $3`, [USERS.sub.id, ORG_ID, capHours]);
    } finally { await pool.end(); }
  });
  test.afterAll(async () => {
    const pool = adminPool();
    try {
      await pool.query(`DELETE FROM time_entries WHERE user_id = $1 AND manual_reason = $2`, [USERS.sub.id, REASON]);
      await pool.query(`UPDATE subcontractor_profiles SET weekly_hours_cap = NULL WHERE user_id = $1`, [USERS.sub.id]);
      await pool.query(`DELETE FROM notifications WHERE org_id = $1 AND type LIKE 'WEEKLY_CAP_%'`, [ORG_ID]);
    } finally { await pool.end(); }
  });

  test('a warning from 80 %, an alert from 100 %, and the manager is told', async ({ page }) => {
    await signIn(page, USERS.sub.email);
    await passNoticeGate(page);
    await page.goto('/timesheets');
    await expect(page.getByTestId('weekly-cap')).toContainText(`weekly cap`);
    const add = async (minutes: number) => {
      const manual = page.getByRole('form', { name: 'Add manual time' });
      await manual.getByLabel('Day').fill(today());
      await manual.getByLabel('Hours').fill(String(Math.floor(minutes / 60)));
      await manual.getByLabel('Minutes').fill(String(minutes % 60));
      await manual.getByLabel('Reason (required)').fill(REASON);
      await manual.getByRole('button', { name: 'Add time' }).click();
      await expect(manual.getByRole('status')).toBeVisible();
    };
    await add(toWarn);
    await expect(page.getByTestId('weekly-cap')).toContainText('Close to your weekly hours cap');
    await expect(page.getByTestId('weekly-cap')).toContainText(`of your ${capHours} h weekly cap`);
    await add(toOver);
    await expect(page.getByTestId('weekly-cap')).toContainText('Weekly hours cap reached');

    const pool = adminPool();
    try {
      await expect.poll(async () => (await pool.query(`SELECT type FROM notifications WHERE user_id = $1 AND type LIKE 'WEEKLY_CAP_%' ORDER BY type`, [USERS.lead.id])).rows.map((r) => r.type))
        .toEqual(['WEEKLY_CAP_REACHED', 'WEEKLY_CAP_WARNING']);
    } finally { await pool.end(); }
    await signOut(page);
  });
});
