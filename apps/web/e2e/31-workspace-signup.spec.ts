import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { PASSWORD, adminPool } from './fixtures';
import { freshTotp, passNoticeGate, signIn } from './helpers';

/**
 * Self-service workspace: signup → e-mail verification → owner 2FA → onboarding → invitation →
 * acceptance → role change → access difference (FR-AUTH-001, FR-AUTH-006, FR-ORG-001; ADR 037).
 * E-mails go to the API's in-memory outbox, so the verification and invitation tokens are set
 * through the database instead of being read from mail.
 */
const SLUG = 'e2e-signup-co';
const OWNER = { email: 'owner@e2e-signup.test', name: 'Olive Owner' };
const MEMBER = { email: 'member@e2e-signup.test', name: 'Max Member' };
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

test.describe.serial('Workspace signup to role-based access (ADR 037)', () => {
  let ownerSecret = '';
  let memberId = '';

  test.beforeAll(async () => {
    const pool = adminPool();
    try { await pool.query(`DELETE FROM organizations WHERE slug LIKE 'e2e-signup-co%'`); } finally { await pool.end(); }
  });

  test('creates a workspace, verifies the address, enrols 2FA and finishes onboarding', async ({ page }) => {
    await page.goto('/signup');
    await page.getByLabel('Workspace name').fill('E2E Signup Co');
    await page.getByLabel('Your name').fill(OWNER.name);
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Check your e-mail' })).toBeVisible();

    // Not before the address is verified.
    await signIn(page, OWNER.email);
    await expect(page.getByRole('alert').filter({ hasText: /verify your e-mail/i })).toBeVisible();
    const pool = adminPool();
    try {
      const org = await pool.query<{ id: string }>(`SELECT id FROM organizations WHERE slug = $1`, [SLUG]);
      expect(org.rows).toHaveLength(1);
      await pool.query(`UPDATE users SET email_verified_at = now() WHERE org_id = $1 AND email = $2`, [org.rows[0]!.id, OWNER.email]);
    } finally {
      await pool.end();
    }

    // Owners must set up 2FA on the first sign-in.
    await signIn(page, OWNER.email);
    await expect(page).toHaveURL(/\/2fa\/setup/);
    ownerSecret = ((await page.getByTestId('totp-secret').textContent()) ?? '').replace(/\s+/g, '');
    expect(ownerSecret.length).toBeGreaterThan(10);
    await page.getByLabel('Authentication code').fill(await freshTotp(page, ownerSecret));
    await page.getByRole('button', { name: 'Verify and enable' }).click();
    await page.getByLabel('I have saved these codes somewhere safe').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await passNoticeGate(page);

    // The onboarding wizard opens by itself for a new workspace.
    await expect(page).toHaveURL(/\/onboarding/);
    const wizard = page.getByTestId('onboarding');
    await wizard.getByLabel('Company name').fill('E2E Signup Co Ltd');
    await wizard.getByLabel('Time zone').selectOption('Europe/Berlin');
    await wizard.getByLabel('Friday').uncheck();
    await wizard.getByRole('button', { name: 'Save and continue' }).click();
    await expect(wizard.getByText('Step 2 of 3')).toBeVisible();
    const invite = wizard.getByTestId('invite-form');
    await invite.getByLabel('Email').fill(MEMBER.email);
    await invite.getByLabel('Role').selectOption({ label: 'Member' });
    await invite.getByRole('button', { name: 'Send invitation' }).click();
    await expect(invite.getByRole('status')).toContainText(`Invitation e-mailed to ${MEMBER.email}`);
    await wizard.getByRole('button', { name: 'Finish setup' }).click();
    await wizard.getByRole('button', { name: 'Open HRVO' }).click();
    await expect(page).toHaveURL(/\/attendance/);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Users' })).toBeVisible();
  });

  test('the member accepts the invitation, sees only member links; a role change ends their session and widens access', async ({ page, browser }) => {
    // Give the pending invitation a token we know (the e-mailed one is in the API's memory only).
    const token = randomBytes(32).toString('hex');
    const pool = adminPool();
    try {
      const upd = await pool.query(`UPDATE invitations SET token_hash = $1 WHERE email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`, [sha256(token), MEMBER.email]);
      expect(upd.rowCount).toBe(1);
    } finally {
      await pool.end();
    }
    const ctx = await browser.newContext();
    const member = await ctx.newPage();
    await member.goto(`/accept-invitation#token=${token}`);
    await member.getByLabel('Your name').fill(MEMBER.name);
    await member.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await member.getByLabel('Confirm password').fill(PASSWORD);
    await member.getByRole('button', { name: 'Create account' }).click();
    await expect(member.getByRole('heading', { name: 'Account created' })).toBeVisible();
    await signIn(member, MEMBER.email);
    await passNoticeGate(member);
    const memberNav = member.getByRole('navigation', { name: 'Main' });
    await expect(memberNav.getByRole('link', { name: 'My attendance' })).toBeVisible();
    await expect(memberNav.getByRole('link', { name: 'Live board' })).toHaveCount(0);
    await expect(memberNav.getByRole('link', { name: 'Roles and permissions' })).toHaveCount(0);
    await member.goto('/admin/users');
    await expect(member.getByTestId('access-denied')).toBeVisible();

    // The owner makes them a team lead.
    await signIn(page, OWNER.email);
    await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible();
    await page.getByLabel('Authentication code').fill(await freshTotp(page, ownerSecret));
    await page.getByRole('button', { name: 'Verify' }).click();
    await passNoticeGate(page);
    await page.goto('/admin/users');
    const row = page.getByTestId('user-row').filter({ hasText: MEMBER.email });
    await expect(row).toContainText('Member');
    await page.goto('/admin/roles');
    const people = page.getByTestId('role-assignments');
    await people.getByLabel(`Role for ${MEMBER.name}`).selectOption({ label: 'Team lead' });
    await people.getByRole('row').filter({ hasText: MEMBER.email }).getByRole('button', { name: 'Apply' }).click();
    await expect(people.getByRole('row').filter({ hasText: MEMBER.email }).getByRole('cell').nth(1)).toHaveText('Team lead');

    // Their old session ended; after signing in again the live board is there.
    await member.goto('/attendance');
    await expect(member).toHaveURL(/\/login/);
    await signIn(member, MEMBER.email);
    await passNoticeGate(member);
    await expect(member.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Live board' })).toBeVisible();

    // Effective access shows the difference in plain words.
    const pool2 = adminPool();
    try {
      memberId = (await pool2.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [MEMBER.email])).rows[0]!.id;
    } finally {
      await pool2.end();
    }
    await page.goto(`/admin/users/${memberId}/access`);
    const access = page.getByTestId('effective-access');
    await expect(access).toContainText('Team lead');
    await expect(access.getByTestId('access-areas')).toContainText('✓ Live board');
    await expect(access.getByTestId('access-areas')).toContainText('✗ Administration: roles and permissions');
    await ctx.close();
  });
});
