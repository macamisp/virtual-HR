import { expect, test } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

test.describe('Role-based access and the live board (FR-AUTH-006, FR-ATT-016)', () => {
  test('an employee has no live board or corrections queue, in the UI or the API', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'My attendance' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Live board' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Corrections' })).toHaveCount(0);

    await page.goto('/live');
    await passNoticeGate(page);
    await expect(page.getByTestId('access-denied')).toBeVisible();
    await page.goto('/corrections');
    await passNoticeGate(page);
    await expect(page.getByTestId('access-denied')).toBeVisible();
  });

  test('a team lead sees their team update in real time', async ({ browser }) => {
    const leadCtx = await browser.newContext();
    const workerCtx = await browser.newContext();
    const lead = await leadCtx.newPage();
    const worker = await workerCtx.newPage();
    try {
      await signIn(lead, USERS.lead.email);
      await passNoticeGate(lead);
      await lead.getByRole('link', { name: 'Live board' }).click();
      const row = lead.getByTestId(`board-row-${USERS.worker.email}`);
      await expect(row).toBeVisible();
      await expect(lead.getByText('Live updates on')).toBeVisible();

      await signIn(worker, USERS.worker.email);
      await passNoticeGate(worker);
      await expect(worker.getByTestId('tracking-badge')).toHaveText(/Tracking: Active since/);
      await expect(row.getByTestId('board-status')).toHaveText('In');

      // Break pushed over the socket, no reload on the lead's side
      await worker.getByRole('button', { name: 'Start break' }).click();
      await expect(row.getByTestId('board-status')).toHaveText('On break', { timeout: 5_000 });
      await worker.getByRole('button', { name: 'End break' }).click();
      await expect(row.getByTestId('board-status')).toHaveText('In', { timeout: 5_000 });

      // HR (not in the lead's team) is not on a team-scoped board
      await expect(lead.getByTestId(`board-row-${USERS.hr.email}`)).toHaveCount(0);
    } finally {
      await leadCtx.close();
      await workerCtx.close();
    }
  });
});
