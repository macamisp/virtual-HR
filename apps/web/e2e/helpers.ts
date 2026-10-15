import { expect, type Page } from '@playwright/test';
import { PASSWORD } from './fixtures';

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
