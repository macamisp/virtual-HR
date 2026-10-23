import { expect, test, type Page } from '@playwright/test';
import { ADMIN_USER, USERS } from './fixtures';
import { freshTotp, passNoticeGate, signIn } from './helpers';

const ROLE = `No documents ${Date.now()}`;

async function signInAdmin(page: Page) {
  await signIn(page, ADMIN_USER.email);
  await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible();
  await page.getByLabel('Authentication code').fill(await freshTotp(page, ADMIN_USER.totp));
  await page.getByRole('button', { name: 'Verify' }).click();
  await passNoticeGate(page);
}

test.describe.serial('Administration: policy, roles, retention, audit, consents (FR-ADM-001, 002, 004, 006; FR-AUD-004)', () => {
  test('policy settings validate and save', async ({ page }) => {
    await signInAdmin(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Policy settings' }).click();
    const form = page.getByRole('form', { name: 'Policy settings' });
    await expect(form.getByLabel('Idle after (minutes)')).toHaveValue('5');
    await form.getByLabel('Idle after (minutes)').fill('20');
    await expect(form.getByText('Must be longer than the idle threshold')).toBeVisible();
    await expect(form.getByRole('button', { name: 'Save policy' })).toBeDisabled();
    await form.getByLabel('Idle after (minutes)').fill('4');
    await form.getByRole('button', { name: 'Save policy' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Policy saved.' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('form', { name: 'Policy settings' }).getByLabel('Idle after (minutes)')).toHaveValue('4');
  });

  test('a custom role removes a permission and the person sees it at once', async ({ page, browser }) => {
    await signInAdmin(page);
    await page.goto('/admin/roles');
    await page.getByRole('button', { name: 'New custom role' }).click();
    const editor = page.getByTestId('role-editor');
    await editor.getByLabel('Name').fill(ROLE);
    await editor.getByLabel('Use documents').uncheck();
    await expect(editor.getByRole('status')).toHaveText('0 added, 1 removed compared with Member.');
    await editor.getByRole('button', { name: 'Create role' }).click();
    await expect(page.getByTestId('custom-role').filter({ hasText: ROLE })).toContainText('− Use documents');

    const people = page.getByTestId('role-assignments');
    await people.getByLabel(`Role for ${USERS.worker.name}`).selectOption({ label: ROLE });
    await people.getByRole('row').filter({ hasText: USERS.worker.email }).getByRole('button', { name: 'Apply' }).click();
    await expect(people.getByRole('row').filter({ hasText: USERS.worker.email })).toContainText(ROLE);
    await expect(people.getByRole('row').filter({ hasText: ADMIN_USER.email })).toContainText('You cannot change your own role');

    const ctx = await browser.newContext();
    const worker = await ctx.newPage();
    await signIn(worker, USERS.worker.email);
    await passNoticeGate(worker);
    await expect(worker.getByTestId('current-user')).toContainText(ROLE);
    await expect(worker.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Documents' })).toHaveCount(0);
    await worker.goto('/documents');
    await expect(worker.getByRole('alert').first()).toContainText(/permission/i);
    await ctx.close();

    // Put things back for other specs.
    await people.getByLabel(`Role for ${USERS.worker.name}`).selectOption({ label: 'Member' });
    await people.getByRole('row').filter({ hasText: USERS.worker.email }).getByRole('button', { name: 'Apply' }).click();
    await expect(people.getByRole('row').filter({ hasText: USERS.worker.email }).getByRole('cell').nth(1)).toHaveText('Member');
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('custom-role').filter({ hasText: ROLE }).getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByTestId('custom-role').filter({ hasText: ROLE })).toHaveCount(0);
  });

  test('retention settings and the audit log with chain verification', async ({ page }) => {
    await signInAdmin(page);
    await page.goto('/admin/retention');
    const form = page.getByRole('form', { name: 'Retention settings' });
    await form.getByLabel('Attendance events (days)').fill('10');
    await expect(form.getByText('Between 30 and 730 days')).toBeVisible();
    await form.getByLabel('Attendance events (days)').fill('60');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Retention saved.' })).toBeVisible();
    await expect(page.getByTestId('retention-other')).toContainText('Not available in this release');

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Audit log' }).click();
    await page.getByLabel('Action').selectOption('ROLE_CREATED');
    await expect(page.getByTestId('audit-table')).toContainText(ADMIN_USER.name);
    await expect(page.getByTestId('audit-table').getByRole('row')).toHaveCount(2);
    await page.getByRole('button', { name: 'Verify chain' }).click();
    await expect(page.getByTestId('chain-result')).toContainText('The chain is intact');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    expect((await download).suggestedFilename()).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  test('a person gives and withdraws consent; the history is kept', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'My consents' }).click();
    await expect(page.getByTestId('consent-MONITORING')).toContainText('Given');
    const rec = page.getByTestId('consent-RECORDING');
    await expect(rec).toContainText('Not decided');
    await rec.getByRole('button', { name: 'Give consent' }).click();
    await expect(rec).toContainText('Given');
    await rec.getByRole('button', { name: 'Withdraw' }).click();
    await expect(rec).toContainText('Withdrawn');
    await rec.getByText('History (2)').click();
    await expect(rec.getByRole('listitem')).toHaveCount(2);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Audit log' })).toHaveCount(0);
  });
});
