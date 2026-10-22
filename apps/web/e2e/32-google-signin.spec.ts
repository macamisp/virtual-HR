import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { ORG_ID, USERS, adminPool } from './fixtures';
import { passNoticeGate, signInAdmin } from './helpers';

/**
 * Sign in with Google against the fake OIDC provider (FR-AUTH-005; ADR 037): an existing
 * account is linked by its address, an invitation refuses a different address, a workspace is
 * created from a Google account, and the profile shows and protects sign-in methods.
 */
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Fill the fake Google page that the "Continue with Google" button opens. */
async function fakeGoogleSignIn(page: Page, email: string, opts: { verified?: boolean; deny?: boolean } = {}): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Fake Google' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(email);
  if (opts.verified === false) await page.getByLabel('Email verified').uncheck();
  await page.getByRole('button', { name: opts.deny ? 'Cancel' : 'Sign in' }).click();
}

test.describe.serial('Sign in with Google (fake provider)', () => {
  test.beforeAll(async () => {
    const pool = adminPool();
    try {
      await pool.query(`DELETE FROM oauth_identities WHERE org_id = $1`, [ORG_ID]);
      await pool.query(`DELETE FROM organizations WHERE slug LIKE 'e2e-google-co%'`);
    } finally {
      await pool.end();
    }
  });

  test('an existing person signs in with Google (linked by the verified address); the profile shows both methods', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await fakeGoogleSignIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await expect(page.getByTestId('current-user')).toContainText(USERS.worker.name);
    await page.goto('/account/profile');
    const methods = page.getByTestId('sign-in-methods');
    await expect(methods).toContainText('Password');
    await expect(methods).toContainText(USERS.worker.email);
    // With a password set, Google can be removed again.
    await methods.getByRole('button', { name: 'Remove Google' }).click();
    await expect(methods).toContainText('Google: not linked');
  });

  test('Google refusals are explained: cancelled, unverified address, wrong invited address', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await fakeGoogleSignIn(page, USERS.worker.email, { deny: true });
    await expect(page.getByRole('alert').filter({ hasText: /cancelled|Testing mode/ })).toBeVisible();

    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await fakeGoogleSignIn(page, USERS.worker.email, { verified: false });
    await expect(page.getByRole('alert').filter({ hasText: /not verified/ })).toBeVisible();

    // An invitation for one address, accepted with another Google address.
    const token = randomBytes(32).toString('hex');
    const pool = adminPool();
    try {
      await pool.query(
        `INSERT INTO invitations (org_id, email, role, token_hash, invited_by, expires_at) VALUES ($1, 'invited.person@web-e2e.test', 'EMPLOYEE', $2, $3, now() + interval '1 day')`,
        [ORG_ID, sha256(token), USERS.hr.id],
      );
    } finally {
      await pool.end();
    }
    await page.goto(`/accept-invitation#token=${token}`);
    await page.getByRole('button', { name: 'Continue with Google instead' }).click();
    await fakeGoogleSignIn(page, 'someone.else@web-e2e.test');
    await expect(page.getByRole('alert').filter({ hasText: /different e-mail address than the invitation/ })).toBeVisible();
  });

  test('a new visitor creates a workspace with Google and becomes its owner (2FA set-up follows); Google cannot be removed as the only method', async ({ page }) => {
    await page.goto('/signup');
    // The Google path waits for the workspace-name step.
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeDisabled();
    await page.getByLabel('Workspace name').fill('E2E Google Co');
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
    await page.getByLabel('Your name').fill('Greta Google');
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await fakeGoogleSignIn(page, 'greta@e2e-google.test');
    await expect(page).toHaveURL(/\/2fa\/setup/);
    await expect(page.getByTestId('totp-secret')).toBeVisible();
    const pool = adminPool();
    try {
      const owner = (await pool.query<{ role: string; is_owner: boolean; password_hash: string | null; org_slug: string }>(
        `SELECT u.role, u.is_owner, u.password_hash, o.slug AS org_slug FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.email = 'greta@e2e-google.test'`)).rows[0];
      expect(owner).toMatchObject({ role: 'SUPER_ADMIN', is_owner: true, password_hash: null, org_slug: 'e2e-google-co' });
      // Let the browser test skip 2FA and the onboarding wizard for this workspace (both covered elsewhere).
      await pool.query(`UPDATE organizations SET mfa_for_sso = false, onboarded_at = now() WHERE slug = 'e2e-google-co'`);
    } finally {
      await pool.end();
    }
    await page.goto('/login');
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await fakeGoogleSignIn(page, 'greta@e2e-google.test');
    await passNoticeGate(page);
    await page.goto('/account/profile');
    const methods = page.getByTestId('sign-in-methods');
    await expect(methods).toContainText('Password: not set');
    await methods.getByRole('button', { name: 'Remove Google' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /only way to sign in/ })).toBeVisible();
  });

  test('an owner of workspace A cannot see workspace B', async ({ page }) => {
    // The admin of Web E2E Ltd (workspace B) lists its own people only; E2E Google Co's owner is absent.
    await signInAdmin(page);
    await page.goto('/admin/users');
    const table = page.getByTestId('users-table');
    await expect(table).toContainText(USERS.worker.email);
    await expect(table).not.toContainText('greta@e2e-google.test');
  });
});
