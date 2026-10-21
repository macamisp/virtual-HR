import { expect, type Page } from '@playwright/test';
import { generateSync } from 'otplib';
import { ADMIN_USER, PASSWORD, adminPool } from './fixtures';

export async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Accepts the monitoring notice if the gate is shown, then waits for the app shell. */
export async function passNoticeGate(page: Page): Promise<void> {
  const accept = page.getByRole('button', { name: 'I have read and accept this notice' });
  const shell = page.getByTestId('tracking-badge');
  await expect(accept.or(shell)).toBeVisible();
  if (await accept.isVisible()) {
    await accept.click();
  }
  await expect(shell).toBeVisible();
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** Set E2E_TRACE=1 to print WebSocket frames (including those of the heartbeat worker). */
export function traceSockets(page: Page): void {
  if (!process.env.E2E_TRACE) return;
  const t0 = Date.now();
  const log = (...a: unknown[]) => console.log(`+${Date.now() - t0}ms`, ...a);
  page.on('websocket', (ws) => {
    log('WS open', ws.url());
    ws.on('framesent', (f) => log('WS >', String(f.payload).slice(0, 140)));
    ws.on('framereceived', (f) => log('WS <', String(f.payload).slice(0, 140)));
    ws.on('close', () => log('WS closed'));
  });
}

const STEP_MS = 30_000;
const usedSteps = new Map<string, number>();

/**
 * A valid TOTP code that has not been used yet. The server accepts one step either side of its own
 * (clock-drift tolerance) and each code only once, newest step first (FR-AUTH-004), so the code
 * comes from a step after the last one used: by this worker (remembered) or by anyone (read from
 * the database). When that step is more than one ahead of the clock, wait for the clock to catch up.
 */
export async function freshTotp(page: Page, secret: string): Promise<string> {
  const pool = adminPool();
  let stored = -1;
  try {
    const res = await pool.query<{ step: string | null }>(`SELECT max(mfa_last_used_step)::text AS step FROM users WHERE mfa_secret = $1`, [secret]);
    stored = res.rows[0]?.step ? Number(res.rows[0].step) : -1;
  } finally {
    await pool.end();
  }
  const last = Math.max(stored, usedSteps.get(secret) ?? -1);
  const nowStep = Math.floor(Date.now() / STEP_MS);
  let step = Math.max(nowStep, last + 1);
  if (step > nowStep + 1) {
    await page.waitForTimeout((step - 1) * STEP_MS - Date.now() + 250);
    step = Math.max(Math.floor(Date.now() / STEP_MS), last + 1);
  }
  usedSteps.set(secret, step);
  return generateSync({ secret, epoch: step * 30 });
}

/** The admin signs in with 2FA; waits for the code screen first so the code is not typed mid-navigation. */
export async function signInAdmin(page: Page): Promise<void> {
  await signIn(page, ADMIN_USER.email);
  await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible();
  await page.getByLabel('Authentication code').fill(await freshTotp(page, ADMIN_USER.totp));
  await page.getByRole('button', { name: 'Verify' }).click();
  await passNoticeGate(page);
}
