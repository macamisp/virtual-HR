import { expect, test } from '@playwright/test';
import { generateSync } from 'otplib';
import { ADMIN_USER, USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

test.describe.serial('Manager dashboard and reports (FR-REP-001..006, 008)', () => {
  test('a team lead sees the dashboard and team-scoped reports; exports download', async ({ page }) => {
    await signIn(page, USERS.lead.email);
    await passNoticeGate(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('my team')).toBeVisible();
    await expect(page.getByTestId('stat-working')).toBeVisible();
    await expect(page.getByText('Waiting for approval')).toBeVisible();

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Reports', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Attendance', selected: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Tasks and workload' }).click();
    await expect(page.getByTestId('report-table')).toContainText(USERS.worker.name);
    await expect(page.getByTestId('report-table')).not.toContainText(ADMIN_USER.name);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'PDF' }).click();
    expect((await download).suggestedFilename()).toMatch(/^tasks-workload-\d{4}-\d{2}-\d{2}\.pdf$/);
    await page.getByRole('tab', { name: 'Compliance' }).click();
    await expect(page.getByTestId('compliance-summary')).toContainText('onboarding status is not available');
    await expect(page.getByTestId('compliance-requirements')).toHaveCount(0);
  });

  test('HR configures required documents and the compliance report reflects it', async ({ page }) => {
    await signIn(page, USERS.hr.email);
    await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible();
    // The HR fixture enrolled 2FA in spec 01; its secret is read from the page in that spec, so sign in as the admin instead.
    await page.goto('/login');
    await signIn(page, ADMIN_USER.email);
    await page.getByLabel('Authentication code').fill(generateSync({ secret: ADMIN_USER.totp }));
    await page.getByRole('button', { name: 'Verify' }).click();
    await passNoticeGate(page);
    await page.goto('/reports');
    await page.getByRole('tab', { name: 'Compliance' }).click();
    const editor = page.getByTestId('compliance-requirements');
    await editor.getByLabel('Employee: Identity').check();
    await editor.getByRole('button', { name: 'Save requirements' }).click();
    await expect(editor.getByRole('status')).toHaveText('Requirements saved.');
    await expect(page.getByTestId('report-table').getByRole('row').filter({ hasText: USERS.worker.name })).toContainText('Identity');
    await page.getByLabel('Only people with findings').check();
    await expect(page.getByTestId('report-table')).not.toContainText(USERS.lead.name);
    // Clean up for other runs.
    await editor.getByLabel('Employee: Identity').uncheck();
    await editor.getByRole('button', { name: 'Save requirements' }).click();
    await expect(editor.getByRole('status')).toHaveText('Requirements saved.');
  });

  test('an employee has no dashboard or reports', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Reports', exact: true })).toHaveCount(0);
    await page.goto('/reports');
    await expect(page.getByTestId('access-denied')).toBeVisible();
  });
});
