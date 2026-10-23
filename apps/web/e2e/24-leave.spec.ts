import { expect, test } from '@playwright/test';
import { ADMIN_USER, ORG_ID, USERS, adminPool } from './fixtures';
import { freshTotp, passNoticeGate, signIn, signOut } from './helpers';

/**
 * Leave and public holidays in the browser (FR-ORG-010, FR-ORG-011, FR-ATT-022; ADR 027): the
 * worker asks for today off, their lead approves it, the lead's live board shows "On leave", and
 * an admin loads the Sri Lanka calendar.
 */
test.describe.serial('Leave requests and public holidays', () => {
  test.beforeAll(async () => {
    // "On leave" shows only without an open session; earlier specs may have left one.
    const pool = adminPool();
    try { await pool.query(`UPDATE attendance_sessions SET status = 'CLOSED', clock_out_at = last_heartbeat_at, clock_out_source = 'TIMEOUT' WHERE org_id = $1 AND user_id = $2 AND status = 'OPEN'`, [ORG_ID, USERS.worker.id]); } finally { await pool.end(); }
  });
  test.afterAll(async () => {
    const pool = adminPool();
    try { await pool.query(`UPDATE leave_requests SET status = 'CANCELLED' WHERE org_id = $1 AND status IN ('PENDING', 'APPROVED')`, [ORG_ID]); } finally { await pool.end(); }
  });

  test('the worker requests sick leave for today and sees it waiting', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Leave', exact: true }).click();
    await page.getByRole('button', { name: 'Request leave' }).click();
    const form = page.getByRole('form', { name: 'Request leave' });
    await form.getByLabel('Type').selectOption('SICK');
    await form.getByLabel('Reason (optional)').fill('Flu');
    await form.getByRole('button', { name: 'Send request' }).click();
    await expect(page.getByTestId('my-leave').getByText('Waiting for a decision')).toBeVisible();
    await expect(page.getByTestId('my-leave')).toContainText('Sick leave');
    await signOut(page);
  });

  test('the lead approves it and the live board shows the worker on leave', async ({ page }) => {
    await signIn(page, USERS.lead.email);
    await passNoticeGate(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Leave requests' }).click();
    const item = page.getByTestId('leave-queue-item').filter({ hasText: USERS.worker.name });
    await expect(item).toContainText('Sick leave');
    await item.getByLabel(/Note to/).fill('Get well');
    await item.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText(`Approved ${USERS.worker.name}'s request`)).toBeVisible();
    await expect(page.getByTestId('leave-decided')).toContainText('Approved');
    // The worker signed out, so no open session hides the leave status.
    await page.getByRole('link', { name: 'Live board' }).click();
    await expect(page.getByTestId(`board-row-${USERS.worker.email}`).getByTestId('board-status')).toHaveText('On leave');
  });

  test('the worker sees the approval; an admin loads the Sri Lanka 2026 calendar', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await page.goto('/attendance/leave');
    await expect(page.getByTestId('my-leave')).toContainText('Approved');
    await expect(page.getByTestId('my-leave')).toContainText('Get well');
    await signOut(page);

    await signIn(page, ADMIN_USER.email);
    await page.getByLabel('Authentication code').fill(await freshTotp(page, ADMIN_USER.totp));
    await page.getByRole('button', { name: 'Verify' }).click();
    await passNoticeGate(page);
    await page.goto('/admin/holidays');
    await page.getByLabel('Year', { exact: true }).selectOption('2026');
    await page.getByRole('button', { name: /Load the Sri Lanka 2026 calendar/ }).click();
    const rows = page.getByTestId('holidays').getByRole('row');
    await expect(rows).toHaveCount(26); // header + 25 dates
    await expect(page.getByTestId('holidays')).toContainText('Independence Day');
    await page.getByRole('form', { name: 'Add a holiday' }).getByLabel('Date').fill('2026-12-31');
    await page.getByRole('form', { name: 'Add a holiday' }).getByLabel('Name').fill('Company closure');
    await page.getByRole('form', { name: 'Add a holiday' }).getByRole('button', { name: 'Add' }).click();
    await expect(rows).toHaveCount(27);
    await page.getByRole('button', { name: 'Remove Company closure' }).click();
    await expect(rows).toHaveCount(26);
  });
});
