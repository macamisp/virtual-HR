import { expect, test } from '@playwright/test';
import { ADMIN_USER, USERS } from './fixtures';
import { freshTotp, passNoticeGate, signIn } from './helpers';

test.describe.serial('Data-subject export and anonymisation requests (FR-AUD-002, 003)', () => {
  test('a person downloads their own data as a ZIP', async ({ page }) => {
    await signIn(page, USERS.sub.email);
    await passNoticeGate(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'My data' }).click();
    const download = page.waitForEvent('download');
    await page.getByTestId('my-data').getByRole('button', { name: 'Download ZIP' }).click();
    expect((await download).suggestedFilename()).toMatch(/^personal-data-sub_web_e2e_test-.*\.zip$/);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Privacy requests' })).toHaveCount(0);
  });

  test('HR checks, opens and cancels an anonymisation request without touching the data', async ({ page }) => {
    await signIn(page, ADMIN_USER.email);
    await page.getByLabel('Authentication code').fill(await freshTotp(page, ADMIN_USER.totp));
    await page.getByRole('button', { name: 'Verify' }).click();
    await passNoticeGate(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Privacy requests' }).click();
    await page.getByLabel('Person').selectOption({ label: `${USERS.sub.name} (Subcontractor)` });
    const check = page.getByTestId('anonymisation-check');
    await expect(check).toContainText('Kept under a pseudonym');
    await expect(check).toContainText('Raw presence events');
    await check.getByLabel('Reason (recorded in the audit log)').fill('Playwright: workflow check only, cancelled right after.');
    await check.getByRole('button', { name: 'Open anonymisation request' }).click();
    const row = page.getByTestId('privacy-request').filter({ hasText: USERS.sub.email }).first();
    await expect(row).toContainText('Anonymisation');
    await expect(row.getByRole('button', { name: 'Anonymise now' })).toBeDisabled();
    await row.getByRole('button', { name: 'Cancel request' }).click();
    await expect(row).toContainText('cancelled');
    // The person is untouched.
    const ctx = await page.context().browser()!.newContext();
    const sub = await ctx.newPage();
    await signIn(sub, USERS.sub.email);
    await passNoticeGate(sub);
    await expect(sub.getByTestId('current-user')).toContainText(USERS.sub.name);
    await ctx.close();
  });
});
