import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { USERS, adminPool } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

/**
 * ADR 049 (FR-WT-007..024): My work time (timer on an own title with pause and resume, named
 * work), overtime and onsite requests, the manager's review, the work-time report, and the pages
 * at phone width. Screenshots go to WT_SCREENSHOTS (default test-results/wt-screens).
 */
const SHOTS = process.env.WT_SCREENSHOTS ?? 'test-results/wt-screens';
const stamp = Date.now();
const TITLE = `Fix Login Authentication ${stamp}`;
const NAMED = `Client Report Preparation ${stamp}`;
const LOCATION = `Client HQ ${stamp}`;

function colomboDay(offset: number): string {
  const d = new Date(Date.now() + offset * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo' }).format(d);
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll, 'no horizontal page scroll').toBeLessThanOrEqual(client + 1);
}

test.describe.serial('Smart work time (ADR 049)', () => {
  test.beforeAll(async () => {
    const pool = adminPool();
    try {
      // Fresh state for this spec's day choices: no earlier requests by the worker.
      await pool.query(`UPDATE overtime_requests SET status = 'CANCELLED', cancelled_at = now() WHERE user_id = $1 AND status IN ('PENDING', 'APPROVED')`, [USERS.worker.id]);
      await pool.query(`UPDATE onsite_work_requests SET status = 'CANCELLED', cancelled_at = now() WHERE user_id = $1 AND status = 'PENDING'`, [USERS.worker.id]);
    } finally {
      await pool.end();
    }
  });

  test('FR-WT-013, FR-WT-017: a timer on my own title with pause and resume, and named work added by hand', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await expect(page.getByTestId('tracking-badge')).toHaveText(/Tracking: Active since/);
    await page.goto('/work-time');
    await expect(page.getByRole('heading', { name: 'My work time' })).toBeVisible();
    await expect(page.getByTestId('activity-note')).toContainText('do not measure the quality');

    const timer = page.getByTestId('work-timer');
    await timer.getByLabel('What are you working on?').fill(TITLE);
    await timer.getByLabel('Where').selectOption('REMOTE');
    await timer.getByLabel('Kind of work').selectOption('DEVELOPMENT');
    await timer.getByRole('button', { name: 'Start timer' }).click();
    await expect(timer.getByTestId('running-title')).toHaveText(TITLE);
    await expect(page.getByTestId('timer-badge')).toContainText(TITLE.slice(0, 10));
    await page.screenshot({ path: `${SHOTS}/01-work-time-timer.png`, fullPage: true });

    await timer.getByRole('button', { name: 'Pause timer' }).click();
    await expect(timer.getByText('No timer running.')).toBeVisible();
    await timer.getByRole('button', { name: 'Resume last work' }).click();
    await expect(timer.getByTestId('running-title')).toHaveText(TITLE);
    await timer.getByRole('button', { name: 'Stop' }).click();
    await expect(timer.getByText('No timer running.')).toBeVisible();

    const add = page.getByTestId('add-work');
    await add.getByLabel('What are you working on?').fill(NAMED);
    await add.getByLabel('Duration').check();
    await add.getByLabel('Minutes').fill('45');
    await add.getByLabel('Why are you adding this manually?').fill('Prepared the report on the train');
    await add.getByRole('button', { name: 'Add work' }).click();
    await expect(add.getByRole('status')).toContainText('Added');
    await expect(page.getByTestId('recent-entries')).toContainText(NAMED);
    await expect(page.getByTestId('recent-entries')).toContainText(TITLE);
  });

  test('FR-WT-007, FR-WT-023: the worker requests overtime and reports onsite work', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await page.goto('/work-time/overtime');
    await page.getByLabel('Day').fill(colomboDay(1));
    await page.getByLabel('Duration').check();
    await page.getByLabel('Minutes').fill('120');
    await page.getByLabel('Work to be done').fill('Production release support');
    await page.getByLabel('Why is overtime needed?').fill('The release window is after hours');
    await page.getByRole('button', { name: 'Send request' }).click();
    await expect(page.getByText('Sent. Your manager has been told.')).toBeVisible();
    await expect(page.getByTestId('my-overtime')).toContainText('Production release support');
    await expect(page.getByTestId('my-overtime').getByTestId('status-PENDING').first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/02-overtime-request.png`, fullPage: true });

    await page.goto('/work-time/onsite');
    await page.getByLabel('Day').fill(colomboDay(-5));
    await page.getByLabel('Start').fill('09:00');
    await page.getByLabel('End').fill('12:30');
    await expect(page.getByText('Duration: 3 h 30 min')).toBeVisible();
    await page.getByLabel('Onsite or client location').fill(LOCATION);
    await page.getByLabel('What did you do?').fill('Installed and tested the access-control units');
    await page.getByLabel('Why was it not recorded in Virtual-HR?').fill('No laptop on site');
    await page.getByRole('button', { name: 'Send for review' }).click();
    await expect(page.getByText('Sent for review.')).toBeVisible();
    await expect(page.getByTestId('my-onsite')).toContainText(LOCATION);
    await page.screenshot({ path: `${SHOTS}/03-onsite-report.png`, fullPage: true });
  });

  test('FR-WT-008, FR-WT-023: the lead approves fewer overtime minutes and the onsite work', async ({ page }) => {
    await signIn(page, USERS.lead.email);
    await passNoticeGate(page);
    await page.goto('/work-time/review');
    const ot = page.getByTestId('review-overtime').locator('li').filter({ hasText: 'Production release support' });
    await expect(ot).toContainText(USERS.worker.name);
    await ot.getByLabel('Approve minutes').fill('90');
    await ot.getByLabel('Comment (required to reject)').fill('Approved up to 90 minutes');
    await page.screenshot({ path: `${SHOTS}/04-review-queue.png`, fullPage: true });
    await ot.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('review-overtime').locator('li').filter({ hasText: 'Production release support' })).toHaveCount(0);

    const os = page.getByTestId('review-onsite').locator('li').filter({ hasText: LOCATION });
    await os.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('review-onsite').locator('li').filter({ hasText: LOCATION })).toHaveCount(0);
    await page.getByLabel('Show').selectOption('APPROVED');
    await expect(page.getByTestId('review-onsite')).toContainText(LOCATION);
  });

  test('FR-WT-009, FR-WT-019: the worker sees the decisions and the work-time report', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await page.goto('/work-time/overtime');
    const mine = page.getByTestId('my-overtime').locator('li').filter({ hasText: 'Production release support' });
    await expect(mine.getByTestId('status-APPROVED')).toBeVisible();
    await expect(mine).toContainText('Approved 1.5 h');
    await page.goto('/work-time/onsite');
    await expect(page.getByTestId('my-onsite').locator('li').filter({ hasText: LOCATION })).toContainText('added to the timesheet as onsite work');

    await page.goto('/work-time/reports');
    await expect(page.getByTestId('wt-totals')).toContainText('Focused task time');
    await expect(page.getByText('They do not measure the quality or value').first()).toBeVisible();
    await expect(page.getByTestId('wt-totals')).toContainText('onsite');
    await page.screenshot({ path: `${SHOTS}/05-work-time-report.png`, fullPage: true });
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'CSV' }).click();
    expect((await download).suggestedFilename()).toMatch(/^work-time-.*\.csv$/);
  });

  test('ADR 049 §8: the work-time pages fit a phone screen', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Colombo' });
    const page = await ctx.newPage();
    try {
      await signIn(page, USERS.worker.email);
      await passNoticeGate(page);
      for (const [path, name] of [['/work-time', '06-mobile-work-time'], ['/work-time/onsite', '07-mobile-onsite'], ['/work-time/overtime', '08-mobile-overtime'], ['/work-time/reports', '09-mobile-report']] as const) {
        await page.goto(path);
        await expect(page.getByRole('navigation', { name: 'Work time' })).toBeVisible();
        await page.waitForLoadState('networkidle');
        await noHorizontalScroll(page);
        await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
      }
    } finally {
      await ctx.close();
    }
  });
});
