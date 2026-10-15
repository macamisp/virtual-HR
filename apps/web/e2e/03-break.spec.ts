import { expect, test } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

test('start and end a break (FR-ATT-007)', async ({ page }) => {
  await signIn(page, USERS.worker.email);
  await passNoticeGate(page);
  const badge = page.getByTestId('tracking-badge');
  await expect(badge).toHaveText(/Tracking: Active since/);

  await page.getByRole('button', { name: 'Start break' }).click();
  await expect(badge).toHaveText(/On break since \d{2}:\d{2}/);
  await expect(page.getByRole('button', { name: 'End break' })).toBeVisible();

  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'End break' }).click();
  await expect(badge).toHaveText(/Tracking: Active since/);
  await expect(page.getByRole('button', { name: 'Start break' })).toBeEnabled();
  await expect(page.getByTestId('total-break')).not.toHaveText('0m');

  // Today shows up in the weekly list
  await expect(page.getByTestId('days-table')).toContainText('In progress');
});
