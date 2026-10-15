import { expect, test } from '@playwright/test';
import { USERS, adminPool } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

const stamp = Date.now();
const TASK = `Build pricing page ${stamp}`;

function colomboToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo' }).format(new Date());
}
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const today = colomboToday();
const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
const lastMonday = addDays(today, -dow - 7);

test.describe.serial('Timesheets: timer, manual time, submit, reject, approve (FR-TS-001..006, 009)', () => {
  test.beforeAll(async () => {
    const pool = adminPool();
    try {
      // Rates are HR-only (2FA); the Rates page itself is covered by the API tests.
      await pool.query(
        `INSERT INTO subcontractor_profiles (user_id, org_id, rate_type, rate, currency) SELECT id, org_id, 'HOURLY', 25.50, 'USD' FROM users WHERE id = $1
         ON CONFLICT (user_id) DO UPDATE SET rate = 25.50, rate_type = 'HOURLY', currency = 'USD'`,
        [USERS.sub.id],
      );
    } finally {
      await pool.end();
    }
  });

  test('the subcontractor times a task, adds manual time with a reason and submits last week', async ({ page }) => {
    await signIn(page, USERS.sub.email);
    await passNoticeGate(page);
    await expect(page.getByTestId('tracking-badge')).toHaveText(/Tracking: Active since/);

    await page.goto('/tasks/new');
    const form = page.getByRole('form', { name: 'New task' });
    await form.getByLabel('Title').fill(TASK);
    await form.getByRole('button', { name: 'Create task' }).click();
    await expect(page.getByTestId('task-title')).toHaveText(TASK);

    const timer = page.getByTestId('task-timer');
    await timer.getByRole('button', { name: 'Start timer' }).click();
    await expect(timer.getByTestId('timer-elapsed')).toBeVisible();
    const badge = page.getByTestId('timer-badge');
    await expect(badge).toContainText(TASK);
    await badge.getByRole('button', { name: 'Stop timer' }).click();
    await expect(badge).toHaveCount(0);
    await expect(timer.getByRole('button', { name: 'Start timer' })).toBeVisible();

    await page.getByRole('link', { name: 'My timesheet' }).click();
    await expect(page.getByRole('heading', { name: 'My timesheet' })).toBeVisible();
    await expect(page.getByTestId('timesheet-entries').getByRole('row', { name: new RegExp(TASK) })).toContainText('Timer');

    const manual = page.getByRole('form', { name: 'Add manual time' });
    await manual.getByLabel('Day').fill(lastMonday);
    await manual.getByLabel('Hours').fill('2');
    await manual.getByLabel('Minutes').fill('30');
    await manual.getByRole('button', { name: 'Add time' }).click();
    await expect(manual.getByRole('alert')).toContainText('reason is required');
    await manual.getByLabel('Reason (required)').fill('Client workshop, laptop offline');
    await manual.getByLabel('Task').selectOption({ label: TASK });
    await manual.getByRole('button', { name: 'Add time' }).click();
    await expect(manual.getByRole('status')).toContainText('over the daily manual limit');

    await page.getByTestId('my-timesheets').getByRole('link').first().click();
    await expect(page.getByTestId('timesheet-period')).toBeVisible();
    const row = page.getByTestId('timesheet-entries').getByTestId('entry-row').first();
    await expect(row).toContainText('Manual');
    await expect(row).toContainText('Reason: Client workshop, laptop offline');
    await expect(row).toContainText('Over the 2h daily manual limit');
    await expect(page.getByTestId(`day-${lastMonday}`)).toContainText('Manual over limit');
    await expect(page.getByTestId('payable-amount')).toHaveText('USD 63.75');
    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await expect(page.getByTestId('timesheet-status')).toHaveText('Submitted');
    await expect(page.getByRole('button', { name: 'Add time' })).toHaveCount(0);
  });

  test('the lead finds it in the queue and returns it with a comment', async ({ page }) => {
    await signIn(page, USERS.lead.email);
    await passNoticeGate(page);
    await page.getByRole('link', { name: 'Review timesheets' }).click();
    await page.getByTestId('approval-queue').getByRole('link', { name: USERS.sub.name }).click();
    const actions = page.getByTestId('timesheet-actions');
    await actions.getByRole('button', { name: 'Reject' }).click();
    await expect(actions).toContainText('needs a short explanation');
    await actions.getByLabel('Comment to the submitter').fill('Split the workshop by task, please');
    await actions.getByRole('button', { name: 'Reject' }).click();
    await expect(page.getByTestId('timesheet-status')).toHaveText('Returned');
  });

  test('the subcontractor sees why, resubmits; the lead approves and it locks', async ({ page, browser }) => {
    await signIn(page, USERS.sub.email);
    await passNoticeGate(page);
    await page.getByRole('link', { name: 'My timesheet' }).click();
    await page.getByTestId('my-timesheets').getByRole('link').first().click();
    await expect(page.getByTestId('rejection')).toContainText('Split the workshop by task, please');
    await page.getByTestId('notification-bell').click();
    await expect(page.getByTestId('notification-panel')).toContainText('Leo Lead returned your timesheet');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await expect(page.getByTestId('timesheet-status')).toHaveText('Submitted');

    const leadCtx = await browser.newContext();
    const lead = await leadCtx.newPage();
    await signIn(lead, USERS.lead.email);
    await passNoticeGate(lead);
    await lead.goto('/timesheets/review');
    await lead.getByTestId('approval-queue').getByRole('link', { name: USERS.sub.name }).click();
    await lead.getByTestId('timesheet-actions').getByRole('button', { name: 'Approve' }).click();
    await expect(lead.getByTestId('timesheet-status')).toHaveText('Approved · locked');
    await expect(lead.getByTestId('payable')).toContainText('Fixed at approval');
    await expect(lead.getByTestId('timesheet-history')).toContainText('Returned by');
    await expect(lead.getByTestId('timesheet-actions')).toHaveCount(0);
    await leadCtx.close();

    await page.reload();
    await expect(page.getByTestId('timesheet-status')).toHaveText('Approved · locked');
    await expect(page.getByRole('button', { name: 'Submit for approval' })).toHaveCount(0);
  });

  test('the lead reports by person with the approved cost and exports CSV', async ({ page }) => {
    await signIn(page, USERS.lead.email);
    await passNoticeGate(page);
    await page.getByRole('link', { name: 'Timesheet reports' }).click();
    const row = page.getByTestId('timesheet-report').getByRole('row', { name: new RegExp(USERS.sub.name) });
    await expect(row).toContainText('63.75');
    await expect(row).toContainText('2h 30m');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'CSV' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^timesheets-by-user-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
    const fs = await import('node:fs/promises');
    const text = await fs.readFile((await download.path())!, 'utf8');
    expect(text).toContain('Person,Timesheets');
    expect(text).toMatch(new RegExp(`${USERS.sub.name},\\d+,[\\d.,-]*,63\\.75,`));
  });
});
