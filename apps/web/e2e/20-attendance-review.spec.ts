import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { io } from 'socket.io-client';
import { signHeartbeatPayload } from '../../../packages/shared/src/attendance/heartbeat-signer.ts';
import { adminPool, ORG_ID, PASSWORD, USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

/**
 * Attendance review (FR-ATT-017, 018; ADR 019): the manager reviews a flag about their report and
 * resolves it with a note; the person sees it in plain words and explains. And the presence
 * challenge (FR-ATT-023): "Are you still working?" appears and the answer resumes tracking.
 */
const API = 'http://localhost:3101';

test.describe.serial('Attendance review and presence challenge', () => {
  let flagId = '';

  test.beforeAll(async () => {
    const pool = adminPool();
    try {
      flagId = (await pool.query(
        `INSERT INTO attendance_flags (org_id, user_id, work_date, kind, category, details, dedupe_key)
         VALUES ($1, $2, to_char(now() AT TIME ZONE 'Asia/Colombo', 'YYYY-MM-DD'), 'IMPOSSIBLE_TRAVEL', 'SPOOFING', $3, $4) RETURNING id`,
        [ORG_ID, USERS.worker.id, JSON.stringify({ from: 'LK', to: 'GB', km: 8300, kmh: 8300 }), `e2e:${randomUUID()}`],
      )).rows[0].id;
    } finally {
      await pool.end();
    }
  });

  test('the person sees the item in plain words and explains it', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await page.goto('/attendance');
    const mine = page.getByTestId('my-flags').getByTestId('flag').filter({ hasText: 'Impossible travel' });
    await expect(mine).toContainText('VPNs often cause this');
    await expect(mine).toContainText('Nothing was changed or deducted');
    await expect(mine).toContainText('LK to GB: about 8,300 km');
    await mine.getByLabel('Your explanation (optional)').fill('I was on the company VPN in London');
    await mine.getByRole('button', { name: 'Save explanation' }).click();
    await expect(mine.getByRole('status')).toHaveText('Saved.');
    await expect(mine.getByRole('button', { name: 'Resolve' })).toHaveCount(0);
  });

  test('the manager reviews it with the explanation and resolves it with a note', async ({ page }) => {
    await signIn(page, USERS.lead.email);
    await passNoticeGate(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Attendance review' }).click();
    const item = page.getByTestId('review-flags').getByTestId('flag').filter({ hasText: USERS.worker.name }).filter({ hasText: 'Impossible travel' });
    await expect(item).toContainText('I was on the company VPN in London');
    const resolve = item.getByRole('button', { name: 'Resolve' });
    await expect(resolve).toBeDisabled();
    await item.getByLabel('Outcome').selectOption('NO_ACTION');
    await item.getByLabel('Note for the record').fill('Confirmed VPN exit in London');
    await resolve.click();
    await expect(item).toHaveCount(0);
    await page.getByRole('tab', { name: 'Resolved' }).click();
    await expect(page.getByTestId('review-flags')).toContainText('No action needed by Leo Lead');
    const pool = adminPool();
    try {
      expect((await pool.query(`SELECT status, resolved_by FROM attendance_flags WHERE id = $1`, [flagId])).rows[0]).toEqual({ status: 'RESOLVED', resolved_by: USERS.lead.id });
    } finally {
      await pool.end();
    }
  });

  test('an employee has no review page', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Attendance review' })).toHaveCount(0);
    await page.goto('/attendance/review');
    await expect(page.getByTestId('access-denied')).toBeVisible();
  });

  test('"Are you still working?" appears after long idle and the answer resumes tracking', async ({ page }) => {
    test.setTimeout(120_000);
    const pool = adminPool();
    await pool.query(`UPDATE organizations SET att_presence_challenge = true WHERE id = $1`, [ORG_ID]);
    // Start from a fresh session (earlier specs leave the worker's in other states, such as led by an agent).
    await pool.query(`UPDATE attendance_sessions SET status = 'CLOSED', clock_out_at = now(), clock_out_source = 'LOGOUT', current_state = 'OFFLINE' WHERE org_id = $1 AND user_id = $2 AND status = 'OPEN'`, [ORG_ID, USERS.worker.id]);
    // Set in the database here, so wait out the API's 30-second policy cache (the admin page clears it at once).
    await new Promise((r) => setTimeout(r, 31_000));
    try {
      await signIn(page, USERS.worker.email);
      await passNoticeGate(page);
      await page.goto('/tasks');
      // A second login of the same person sends 31 idle intervals at once: the idle counter grows per
      // interval, so the pause threshold (15 min) is crossed and the server asks every tab of this person.
      const login = (await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: USERS.worker.email, password: PASSWORD }) })).json()) as { accessToken: string; sessionId: string; sessionSecret: string };
      const s = io(API, { transports: ['websocket'], reconnection: false, auth: { token: login.accessToken } });
      await new Promise<void>((res) => s.once('connect', () => res()));
      let seq = Math.floor(Date.now() / 1000) + 100;
      for (let i = 0; i < 31; i += 1) {
        seq += 1;
        const hb = await signHeartbeatPayload({ orgId: ORG_ID, userId: USERS.worker.id, deviceId: 'e2e-idle-device', sessionId: login.sessionId, sequenceNumber: seq, nonce: randomUUID(),
          activeSeconds: i === 0 ? 30 : 0, idleSeconds: i === 0 ? 0 : 30, tabVisible: true, windowFocused: true, inCall: false }, login.sessionSecret);
        await s.emitWithAck('presence:heartbeat', hb);
      }
      const dialog = page.getByRole('alertdialog', { name: 'Are you still working?' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('timer')).toContainText(/\d+ s left/);
      await expect(dialog.getByRole('button', { name: 'Yes, I am still working' })).toBeFocused();
      await dialog.getByRole('button', { name: 'Yes, I am still working' }).click();
      await expect(page.getByTestId('challenge-result')).toContainText('Tracking continues');
      s.disconnect();
      expect((await pool.query(`SELECT current_state FROM attendance_sessions WHERE org_id = $1 AND user_id = $2 AND status = 'OPEN'`, [ORG_ID, USERS.worker.id])).rows[0].current_state).toBe('ACTIVE');
    } finally {
      await pool.query(`UPDATE organizations SET att_presence_challenge = false WHERE id = $1`, [ORG_ID]);
      await pool.end();
    }
  });
});
