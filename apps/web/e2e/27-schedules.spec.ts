import { expect, test } from '@playwright/test';
import { ORG_ID, USERS, adminPool } from './fixtures';
import { passNoticeGate, signIn, signInAdmin, signOut } from './helpers';

/**
 * The work schedule editor in the browser (FR-ORG-005; ADR 032): an admin gives one person their
 * own schedule (separate early-leave grace, a break allowance), sees that it applies today, and
 * stops it again so the next level applies. An employee has no access.
 */
test.describe.serial('Work schedules', () => {
  test.afterAll(async () => {
    const pool = adminPool();
    try { await pool.query(`DELETE FROM work_schedules WHERE org_id = $1`, [ORG_ID]); } finally { await pool.end(); }
  });

  test('an admin gives a person their own schedule and stops it again', async ({ page }) => {
    await signInAdmin(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Work schedules' }).click();

    await page.getByLabel('Schedule for').selectOption('USER');
    await page.getByLabel('Person').selectOption({ label: USERS.worker.name });
    await expect(page.getByTestId('schedule-current')).toContainText('No schedule of its own yet.');
    await expect(page.getByTestId('schedule-current')).toContainText('Today this person works to no schedule');

    const form = page.getByRole('form', { name: 'Work schedule' });
    await expect(form.getByLabel('Applies from')).toHaveAttribute('min', /^\d{4}-\d{2}-\d{2}$/);
    await form.getByLabel('Monday start').fill('08:30');
    await form.getByLabel('Monday end').fill('16:30');
    await form.getByLabel('Same as late arrival').uncheck();
    await form.getByLabel('Early-leave grace (minutes)').fill('20');
    await form.getByLabel('Break allowance per day (minutes)').fill('45');
    await form.getByRole('button', { name: 'Save schedule' }).click();
    await expect(page.getByText(/^Saved\. The schedule applies from/)).toBeVisible();
    await expect(page.getByTestId('schedule-current')).toContainText('In force since');
    await expect(page.getByTestId('schedule-current')).toContainText('Mon, Tue, Wed, Thu, Fri · 08:30–16:30 · 40 h a week');
    await expect(page.getByTestId('schedule-current')).toContainText('Today this person works to their own schedule.');

    const pool = adminPool();
    try {
      const row = (await pool.query(`SELECT grace_minutes, early_leave_grace_minutes, break_allowance_minutes FROM work_schedules WHERE user_id = $1`, [USERS.worker.id])).rows[0];
      expect(row).toEqual({ grace_minutes: 10, early_leave_grace_minutes: 20, break_allowance_minutes: 45 });
    } finally { await pool.end(); }

    await page.getByRole('button', { name: 'Stop this schedule' }).click();
    await expect(page.getByText(/^Stopped from .*the team or organisation schedule applies\./)).toBeVisible();
    await expect(page.getByTestId('schedule-current')).toContainText('No schedule of its own yet.');
    await signOut(page);
  });

  test('an employee has no access to the editor', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Work schedules' })).toHaveCount(0);
    await page.goto('/admin/schedules');
    await expect(page.getByTestId('access-denied')).toBeVisible();
    await signOut(page);
  });
});
