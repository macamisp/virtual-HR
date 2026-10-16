import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { anchorKey, signAnchor } from '../../api/src/agent/offline-sync.ts';
import { adminPool, ORG_ID, USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

/**
 * Desktop agent (FR-ATT-011, FR-ATT-012; ADR 018), the real Electron app against the e2e API:
 * explicit consent screen, pairing with a one-time code from the web app, a tray icon at all
 * times, agent heartbeats leading the attendance session, offline buffering and sync flagged
 * OFFLINE_SYNCED, and disconnecting the device from the web app.
 */
const AGENT_DIR = resolve(process.cwd(), '../agent');
const ELECTRON = resolve(process.cwd(), '../../node_modules/electron/dist/electron');

interface Hooks {
  state(): { screen: string; status: { link: string; buffered: number; message: string | null } };
  tray(): { exists: boolean; tooltip: string };
  setIdle(s: number | null): void;
  setLocked(v: boolean | null): void;
  advance(ms: number): void;
  tick(): Promise<void>;
  setOffline(v: boolean): Promise<void>;
  setAnchor(a: { serverTimeMs: number; signature: string }): void;
  deviceId(): string | null;
}
/** Calls a test hook in the agent's main process (HRVO_AGENT_TEST=1 only). */
async function hook<K extends keyof Hooks>(app: ElectronApplication, name: K, arg?: unknown): Promise<Awaited<ReturnType<Hooks[K]>>> {
  return (await app.evaluate(async (_electron, [n, a]) => {
    const h = (globalThis as unknown as { __hrvoAgentTest: Record<string, (x: unknown) => unknown> }).__hrvoAgentTest;
    return await h[n]!(a);
  }, [name, arg] as const)) as Awaited<ReturnType<Hooks[K]>>;
}

test.describe.serial('Desktop agent', () => {
  let app: ElectronApplication;
  let agentWin: Page;
  let dataDir: string;

  test.beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: AGENT_DIR, stdio: 'ignore' });
    dataDir = mkdtempSync(join(tmpdir(), 'hrvo-agent-e2e-'));
  });
  test.afterAll(async () => {
    await app?.close().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('consent screen, pairing with a web code, tray icon, agent heartbeats', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'My desktop agents' }).click();
    await expect(page.getByText('No desktop agent connected')).toBeVisible();
    await page.getByRole('button', { name: 'Connect a desktop agent' }).click();
    const code = (await page.getByTestId('pairing-code').locator('p').first().innerText()).trim();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const env = { ...process.env, HRVO_AGENT_TEST: '1', HRVO_AGENT_DATA_DIR: dataDir, HRVO_API_URL: 'http://localhost:3101' } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    // CI runners (Ubuntu 24.04) restrict the user namespaces Chromium's sandbox needs.
    app = await electron.launch({ executablePath: ELECTRON, args: [...(process.env.CI ? ['--no-sandbox'] : []), AGENT_DIR], cwd: AGENT_DIR, env });
    agentWin = await app.firstWindow();
    expect(await hook(app, 'tray')).toMatchObject({ exists: true });
    // Before it connects: the agent ticks on its own when it comes online, so fix the idle time and
    // the lock state first (a locked screen counts as idle; the test machine's screen may be locked).
    await hook(app, 'setIdle', 0);
    await hook(app, 'setLocked', false);

    // Server, then the explicit consent screen: nothing happens until the user agrees.
    await expect(agentWin.getByLabel('Server address')).toHaveValue('http://localhost:3101');
    await agentWin.getByRole('button', { name: 'Continue' }).click();
    const notice = agentWin.getByTestId('consent-notice');
    await expect(notice).toContainText('never reads');
    await expect(notice).toContainText('tray icon');
    const agree = agentWin.getByRole('button', { name: 'Agree and continue' });
    await expect(agree).toBeDisabled();
    await agentWin.getByLabel('I have read this notice and agree to the desktop agent.').check();
    await agree.click();
    await agentWin.getByLabel('Pairing code').fill(code);
    await agentWin.getByLabel('Name of this computer').fill('E2E laptop');
    await agentWin.getByRole('button', { name: 'Connect' }).click();
    await expect(agentWin.getByTestId('link-state')).toHaveText('Connected');

    // A heartbeat from the agent: the user's open session is now led by this device.
    await hook(app, 'tick');
    const deviceId = await hook(app, 'deviceId');
    expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await hook(app, 'tray')).tooltip).toContain('Tracking: active');
    const pool = adminPool();
    try {
      await expect.poll(async () => (await pool.query(`SELECT agent_device_id FROM attendance_sessions WHERE org_id = $1 AND user_id = $2 AND status = 'OPEN'`, [ORG_ID, USERS.worker.id])).rows[0]?.agent_device_id).toBe(deviceId);
      const consent = (await pool.query(`SELECT granted FROM monitoring_consents WHERE user_id = $1 AND consent_type = 'DESKTOP_AGENT'`, [USERS.worker.id])).rows;
      expect(consent).toEqual([{ granted: true }]);
    } finally {
      await pool.end();
    }
    await page.reload();
    await expect(page.getByTestId('agent-devices')).toContainText('E2E laptop');
  });

  test('offline: intervals are buffered and synced on reconnect, flagged OFFLINE_SYNCED', async () => {
    await hook(app, 'setOffline', true);
    await expect(agentWin.getByTestId('link-state')).toHaveText('Offline');
    // The anchor the agent measures from, as the server would have signed it 3 hours ago.
    const deviceId = (await hook(app, 'deviceId'))!;
    const t = Date.now() - 3 * 3600_000;
    const anchor = { serverTimeMs: t, signature: signAnchor(anchorKey(process.env.JWT_SECRET!), { orgId: ORG_ID, userId: USERS.worker.id, deviceId }, t) };
    await hook(app, 'setAnchor', anchor);
    for (let i = 0; i < 6; i += 1) {
      await hook(app, 'advance', 30_000);
      await hook(app, 'tick');
    }
    await expect(agentWin.getByTestId('buffered')).toContainText('6 intervals (3 min)');
    expect((await hook(app, 'tray')).tooltip).toContain('Offline: 6 intervals saved');

    await hook(app, 'setOffline', false);
    await expect(agentWin.getByTestId('link-state')).toHaveText('Connected');
    await expect(agentWin.getByTestId('buffered')).toContainText('0 intervals');
    await expect(agentWin.getByTestId('agent-message')).toContainText('Synced 6 offline intervals');
    const pool = adminPool();
    try {
      const s = (await pool.query(`SELECT clock_in_at, active_seconds, flags FROM attendance_sessions WHERE user_id = $1 AND clock_in_source = 'OFFLINE_SYNC'`, [USERS.worker.id])).rows;
      expect(s).toHaveLength(1);
      expect(s[0].flags).toEqual(['OFFLINE_SYNCED']);
      expect(s[0].active_seconds).toBe(180);
      // Server anchor + the agent's monotonic offset (a few real milliseconds passed between setting the anchor and the first tick).
      const start = new Date(s[0].clock_in_at).getTime();
      expect(start).toBeGreaterThanOrEqual(t);
      expect(start - t).toBeLessThan(2000);
    } finally {
      await pool.end();
    }
  });

  test('disconnecting the device in the web app stops the agent at once', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await page.goto('/account/agents');
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('agent-devices').getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.getByText('No desktop agent connected')).toBeVisible();
    await expect(agentWin.getByRole('heading', { name: 'Set up the HRVO Agent' })).toBeVisible();
    await expect(agentWin.getByText('This device was disconnected')).toBeVisible();
    expect((await hook(app, 'tray')).tooltip).toContain('Stopped: this device was disconnected');
  });
});
