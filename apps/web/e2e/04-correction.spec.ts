import { expect, test } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn, signOut } from './helpers';

test('worker requests a correction; their team lead approves it with a note (FR-ATT-013)', async ({ page }) => {
  await signIn(page, USERS.worker.email);
  await passNoticeGate(page);

  const form = page.getByRole('form', { name: 'Request a correction' });
  await form.getByLabel('Clock-in').fill('08:30');
  await form.getByLabel('Clock-out').fill('16:45');
  await form.getByRole('button', { name: 'Submit request' }).click();
  await expect(form.getByText('Explain what happened')).toBeVisible();
  await form.getByLabel('Reason').fill('Laptop died, worked from paper notes');
  await form.getByRole('button', { name: 'Submit request' }).click();
  await expect(form.getByText('Correction requested')).toBeVisible();
  await expect(page.getByTestId('my-corrections')).toContainText('Pending');
  await signOut(page);

  await signIn(page, USERS.lead.email);
  await passNoticeGate(page);
  await page.getByRole('link', { name: 'Corrections' }).click();
  const item = page.getByTestId('queue-item').filter({ hasText: 'Laptop died' });
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: 'Reject' }).click();
  await expect(item.getByText('Add a note explaining the rejection.')).toBeVisible();
  await item.getByLabel(/Note to/).fill('Approved, thanks for the details');
  await item.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText(/Approved the request from Wendy Worker/)).toBeVisible();
  await expect(page.getByTestId('queue-item').filter({ hasText: 'Laptop died' })).toHaveCount(0);
  await signOut(page);

  await signIn(page, USERS.worker.email);
  await passNoticeGate(page);
  const mine = page.getByTestId('my-corrections');
  await expect(mine).toContainText('Approved');
  await expect(mine).toContainText('Reviewer note: Approved, thanks for the details');
});
