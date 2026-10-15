import { expect, test } from '@playwright/test';
import { generateSync } from 'otplib';
import { USERS } from './fixtures';
import { passNoticeGate, signIn, signOut } from './helpers';

test.describe('Login with mandatory TOTP (FR-AUTH-004)', () => {
  test('HR enrolls 2FA on first login, then signs in with a TOTP code', async ({ page }) => {
    await signIn(page, USERS.hr.email);

    // Mandatory enrollment: no access to the app until TOTP is verified
    await expect(page).toHaveURL(/\/2fa\/setup/);
    const secret = (await page.getByTestId('totp-secret').innerText()).replace(/\s+/g, '');
    expect(secret.length).toBeGreaterThanOrEqual(16);

    await page.getByLabel('Authentication code').fill(generateSync({ secret }) === '000000' ? '111111' : '000000');
    await page.getByRole('button', { name: 'Verify and enable' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /Invalid 2FA verification code/i })).toBeVisible();

    await page.getByLabel('Authentication code').fill(generateSync({ secret }));
    await page.getByRole('button', { name: 'Verify and enable' }).click();
    await expect(page.getByTestId('recovery-codes').locator('li')).toHaveCount(10);
    const continueBtn = page.getByRole('button', { name: 'Continue' });
    await expect(continueBtn).toBeDisabled();
    await page.getByLabel('I have saved these codes somewhere safe').check();
    await continueBtn.click();

    await passNoticeGate(page);
    await expect(page.getByRole('heading', { name: 'My attendance' })).toBeVisible();

    // Tokens live in memory only
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    expect(stored).not.toContain('eyJ');

    await signOut(page);

    // Second login asks for the TOTP code
    await signIn(page, USERS.hr.email);
    await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible();
    await page.getByLabel('Authentication code').fill('000000' === generateSync({ secret }) ? '111111' : '000000');
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /Invalid 2FA code/i })).toBeVisible();
    await page.getByLabel('Authentication code').fill(generateSync({ secret }));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByTestId('tracking-badge')).toBeVisible();
    await expect(page.getByTestId('current-user')).toContainText('Hana HR');
  });

  test('wrong password shows an error and stays on the login page', async ({ page }) => {
    await signIn(page, USERS.worker.email, 'definitely-wrong-password');
    await expect(page.getByRole('alert').filter({ hasText: /Invalid email or password/i })).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });
});
