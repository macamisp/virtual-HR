import { expect, test } from '@playwright/test';
import { USERS, adminPool } from './fixtures';
import { passNoticeGate, signIn, traceSockets } from './helpers';

test.describe('Automatic clock-in via signed heartbeat (FR-ATT-001, 004, 020)', () => {
  test('monitoring notice blocks the app; after acceptance the worker clocks in automatically', async ({ page }) => {
    traceSockets(page);
    await signIn(page, USERS.worker.email);

    // Gate: nothing of the app (and no heartbeat) before acceptance
    await expect(page.getByRole('heading', { name: 'Attendance monitoring notice' })).toBeVisible();
    await expect(page.getByTestId('tracking-badge')).toHaveCount(0);
    await expect(page.getByText(/No screenshots/)).toBeVisible();

    await passNoticeGate(page);
    await expect(page.getByTestId('tracking-badge')).toHaveText(/Tracking: Active since \d{2}:\d{2}/);
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

    // Server-side record created by the heartbeat, stamped with server time
    const pool = adminPool();
    try {
      const res = await pool.query(
        `SELECT clock_in_source, current_state, clock_in_at FROM attendance_sessions WHERE user_id = $1 AND status = 'OPEN'`,
        [USERS.worker.id],
      );
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].clock_in_source).toBe('AUTO_HEARTBEAT');
      expect(Date.now() - new Date(res.rows[0].clock_in_at).getTime()).toBeLessThan(60_000);
    } finally {
      await pool.end();
    }

    // A reload drops the in-memory token; the httpOnly refresh cookie restores the session
    await page.reload();
    await expect(page.getByTestId('tracking-badge')).toHaveText(/Tracking: Active since \d{2}:\d{2}/);
  });

  test('heartbeats carry counters only (no content) and are signed', async ({ page }) => {
    // page.on('websocket') also sees sockets opened by the heartbeat Web Worker.
    const frames: string[] = [];
    page.on('websocket', (ws) => ws.on('framesent', (f) => frames.push(String(f.payload))));
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await expect.poll(() => frames.some((f) => f.includes('presence:heartbeat')), { timeout: 20_000 }).toBe(true);
    const hb = frames.find((f) => f.includes('presence:heartbeat'))!;
    const payload = JSON.parse(hb.slice(hb.indexOf('['))) as [string, Record<string, unknown>];
    expect(Object.keys(payload[1]).sort()).toEqual(
      ['activeSeconds', 'deviceId', 'idleSeconds', 'inCall', 'nonce', 'orgId', 'sequenceNumber', 'sessionId', 'signature', 'tabVisible', 'userId', 'windowFocused'].sort(),
    );
    expect(String(payload[1].signature)).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(payload[1].activeSeconds) + Number(payload[1].idleSeconds)).toBeLessThanOrEqual(30);
  });

  test('the raw events and the clock-in carry seconds, so times can be checked against a phone clock (docs/runbooks/uat.md)', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await expect(page.getByTestId('tracking-badge')).toHaveText(/Tracking: Active since/);
    await page.getByRole('link', { name: 'What we collect' }).click();
    const times = page.getByTestId('event-time');
    await expect(times.first()).toBeVisible();
    for (const t of await times.allTextContents()) expect(t).toMatch(/\d{2}:\d{2}:\d{2}/);
    await page.getByRole('link', { name: 'My attendance' }).click();
    await expect(page.getByRole('cell', { name: /^\d{2}:\d{2}$/ }).first()).toHaveAttribute('title', /^Clock-in \d{2}:\d{2}:\d{2}$/);
  });

  test('a dropped connection shows a clear reconnecting state and recovers on its own', async ({ page, context }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    const badge = page.getByTestId('tracking-badge');
    await expect(badge).toHaveText(/Tracking: Active since/);

    await context.setOffline(true);
    await expect(badge).toHaveText(/Reconnecting… tracking paused/, { timeout: 50_000 });
    await context.setOffline(false);
    await expect(badge).toHaveText(/Tracking: Active since/, { timeout: 30_000 });
  });
});
