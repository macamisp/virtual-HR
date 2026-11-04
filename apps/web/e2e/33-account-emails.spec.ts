import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { expect, test, type Page } from '@playwright/test';
import { ORG_ID, PASSWORD, USERS, adminPool } from './fixtures';
import { passNoticeGate } from './helpers';
import { mailsTo, pressEmailButton, waitForMail } from './mail';

/**
 * ADR 039: every account e-mail is read for real, its button pressed, and every page it opens ends
 * with a visible next step. Old links say why they no longer work and send a new one.
 * (Signup and invitation acceptance end to end: spec 31. Google signup without an e-mail: spec 32.)
 */
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Opens an e-mailed link as a fresh page load (a link that only differs after # would not reload). */
async function openLink(page: Page, url: string): Promise<void> {
  await page.goto('about:blank');
  await page.goto(url);
}
const OWNER = { email: 'olga@e2e-mail-co.test', name: 'Olga Owner' };
const RESETTER = { id: '66660000-0000-4000-8000-000000000033', email: 'rita.reset@web-e2e.test', name: 'Rita Reset' };
const NEW_PASSWORD = 'Another-Strong-Pass-2026!';

test.describe.serial('Account e-mails and their pages (ADR 039)', () => {
  test.beforeAll(async () => {
    const pool = adminPool();
    try {
      await pool.query(`DELETE FROM organizations WHERE slug LIKE 'e2e-mail-co%'`);
      await pool.query(`DELETE FROM users WHERE id = $1`, [RESETTER.id]);
      const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
      await pool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status) VALUES ($1, $2, $3, $4, 'EMPLOYEE', $5, 'ACTIVE')`,
        [RESETTER.id, ORG_ID, RESETTER.email, RESETTER.name, hash]);
      await pool.query(`DELETE FROM invitations WHERE org_id = $1 AND email LIKE '%@e2e-mail-invite.test'`, [ORG_ID]);
    } finally {
      await pool.end();
    }
  });

  test('"Check your e-mail": where it went, Mailhog in development, Resend after the wait; a replaced link says so and sends a new one', async ({ page }) => {
    await page.goto('/signup');
    await page.getByLabel('Workspace name').fill('E2E Mail Co');
    await page.getByLabel('Your name').fill(OWNER.name);
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create workspace' }).click();

    const check = page.getByTestId('check-your-email');
    await expect(check.getByRole('heading', { name: 'Check your e-mail' })).toBeVisible();
    await expect(check).toContainText(`We sent a confirmation link to ${OWNER.email}`);
    await expect(check.getByTestId('mail-viewer')).toHaveAttribute('href', 'http://localhost:8025');
    await expect(check.getByRole('link', { name: 'Already confirmed? Sign in' })).toBeVisible();
    // Rate limited: the button waits (3 s in this test run, 60 s by default), then sends again.
    const resend = check.getByRole('button', { name: /Resend e-mail/ });
    await expect(resend).toBeDisabled();
    await expect(resend).toHaveText(/in \d+ s/);
    await expect(resend).toBeEnabled({ timeout: 10_000 });
    await resend.click();
    await expect(check.getByRole('status').filter({ hasText: /new link is on its way/ })).toBeVisible();
    await expect(resend).toBeDisabled();

    const first = await waitForMail(OWNER.email, 1);
    const second = await waitForMail(OWNER.email, 2);
    expect(second.html).not.toBe(first.html);

    // The first e-mail's link was replaced by the second: the page says so and offers a new one.
    // (Wait out the per-address gap first, 3 s in this run: within it the server holds a new e-mail back.)
    await page.waitForTimeout(3_500);
    await pressEmailButton(page, first, 'Confirm e-mail and sign in');
    const problem = page.getByTestId('link-problem');
    await expect(problem.getByRole('heading', { name: 'This confirmation link has expired' })).toBeVisible();
    await expect(problem.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await problem.getByRole('button', { name: 'Send a new link' }).click();
    await expect(problem.getByRole('status').filter({ hasText: /address it was sent to/ })).toBeVisible();
    await expect(problem.getByRole('button', { name: 'New link sent' })).toBeDisabled();
    const third = await waitForMail(OWNER.email, 3);

    // The newest link works; opened a second time it says the address is already confirmed.
    const href = await pressEmailButton(page, third, 'Confirm e-mail and sign in');
    await expect(page.getByRole('heading', { name: 'E-mail confirmed' })).toBeVisible();
    await openLink(page, href); // opened again
    await expect(page.getByRole('heading', { name: 'Your e-mail is already confirmed' })).toBeVisible();
    await page.getByRole('link', { name: 'Continue to sign in' }).click();
    await expect(page).toHaveURL(/\/login\?/);
    await expect(page.getByLabel('Email')).toHaveValue(OWNER.email);
  });

  test('password reset: the e-mail leads to "Choose a new password", then to sign in; the used link offers a new one', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(RESETTER.email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText(`If an account exists for ${RESETTER.email}, a reset link is on its way.`)).toBeVisible();
    const mail = await waitForMail(RESETTER.email, 1);
    expect(mail.subject).toBe('Reset your HRVO password');
    const href = await pressEmailButton(page, mail, 'Choose a new password');

    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Set new password' }).click();
    const done = page.getByTestId('reset-done');
    await expect(done.getByRole('heading', { name: 'Password changed' })).toBeVisible();
    await done.getByRole('link', { name: 'Sign in' }).click();
    await expect(page.getByLabel('Email')).toHaveValue(RESETTER.email);
    await page.getByLabel('Password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await passNoticeGate(page);
    await expect(page.getByTestId('current-user')).toContainText(RESETTER.name);

    // The same e-mail opened again: already used, and a new link is one press away.
    await page.context().clearCookies();
    await openLink(page, href);
    const problem = page.getByTestId('link-problem');
    await expect(problem.getByRole('heading', { name: 'This password reset link was already used' })).toBeVisible();
    await problem.getByRole('button', { name: 'Send a new link' }).click();
    await expect(problem.getByRole('status').filter({ hasText: /address it was sent to/ })).toBeVisible();
    const again = await waitForMail(RESETTER.email, 2);
    await pressEmailButton(page, again, 'Choose a new password');
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  });

  test('invitations: an expired one sends a new link to the invited address; accepted and withdrawn ones say so with a way on', async ({ page }) => {
    const invite = async (email: string, sql: string) => {
      const token = randomBytes(32).toString('hex');
      const pool = adminPool();
      try {
        await pool.query(
          `INSERT INTO invitations (org_id, email, role, token_hash, invited_by, expires_at, last_sent_at, accepted_at, revoked_at)
           VALUES ($1, $2, 'EMPLOYEE', $3, $4, ${sql})`, [ORG_ID, email, sha256(token), USERS.hr.id]);
      } finally {
        await pool.end();
      }
      return token;
    };
    const expired = await invite('ellie@e2e-mail-invite.test', `now() - interval '1 day', now() - interval '8 days', NULL, NULL`);
    await openLink(page, `/accept-invitation#token=${expired}`);
    const problem = page.getByTestId('link-problem');
    await expect(problem.getByRole('heading', { name: 'This invitation has expired' })).toBeVisible();
    await problem.getByRole('button', { name: 'Send a new link' }).click();
    await expect(problem.getByRole('status').filter({ hasText: /address it was sent to/ })).toBeVisible();
    const mail = await waitForMail('ellie@e2e-mail-invite.test');
    expect(mail.subject).toMatch(/invited you to Web E2E Ltd on HRVO/);
    await pressEmailButton(page, mail, 'Accept invitation');
    await expect(page.getByText('You are joining Web E2E Ltd as ellie@e2e-mail-invite.test')).toBeVisible();

    const accepted = await invite('andy@e2e-mail-invite.test', `now() + interval '1 day', now(), now(), NULL`);
    await openLink(page, `/accept-invitation#token=${accepted}`);
    await expect(page.getByRole('heading', { name: 'This invitation was already accepted' })).toBeVisible();
    await page.getByTestId('link-problem').getByRole('link', { name: 'Sign in' }).click();
    await expect(page.getByLabel('Email')).toHaveValue('andy@e2e-mail-invite.test');

    const withdrawn = await invite('willa@e2e-mail-invite.test', `now() + interval '1 day', now(), NULL, now()`);
    await openLink(page, `/accept-invitation#token=${withdrawn}`);
    await expect(page.getByRole('heading', { name: 'This invitation was withdrawn' })).toBeVisible();
    await expect(page.getByText('Ask the person who invited you for a new invitation.')).toBeVisible();
    await expect(page.getByTestId('link-problem').getByRole('button', { name: 'Send a new link' })).toHaveCount(0);
    expect(mailsTo('willa@e2e-mail-invite.test')).toHaveLength(0);
  });
});
