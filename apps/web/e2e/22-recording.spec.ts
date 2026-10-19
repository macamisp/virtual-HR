import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN_USER, adminPool, ORG_ID, USERS } from './fixtures';
import { freshTotp, passNoticeGate, signIn } from './helpers';

/**
 * Meeting recording with consent over a real LiveKit and a real LiveKit Egress (FR-MEET-007,
 * ADR 024): the admin switch, the request, the other person's yes, the banner on both sides,
 * stopping, encryption and watching. Needs the Egress container: LIVEKIT_EGRESS=1.
 */
async function personIn(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  await signIn(page, email);
  await passNoticeGate(page);
  return page;
}

async function join(page: Page): Promise<void> {
  const pre = page.getByTestId('prejoin');
  await expect(pre).toBeVisible();
  await pre.getByRole('button', { name: 'Camera off' }).click();
  await pre.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByTestId('call-view')).toHaveAttribute('data-status', 'connected');
}

test.describe.serial('Meeting recording with consent (FR-MEET-007)', () => {
  test.skip(process.env.LIVEKIT_EGRESS !== '1' || !process.env.S3_ENDPOINT, 'needs LiveKit Egress (LIVEKIT_EGRESS=1) and S3_ENDPOINT');
  test.afterAll(async () => { await adminPool().query(`UPDATE organizations SET recording_enabled = false WHERE id = $1`, [ORG_ID]); });

  test('an admin allows recording (off by default)', async ({ page }) => {
    await signIn(page, ADMIN_USER.email);
    await page.getByLabel('Authentication code').fill(await freshTotp(page, ADMIN_USER.totp));
    await page.getByRole('button', { name: 'Verify' }).click();
    await passNoticeGate(page);
    await page.goto('/admin/retention');
    await expect(page.getByLabel('Meeting recordings (days)')).toHaveValue(/\d+/);
    const allow = page.getByTestId('recording-switch').getByLabel('Allow meeting recording');
    await expect(allow).not.toBeChecked();
    await allow.click(); // saved first, then shown checked
    await expect(allow).toBeChecked();
  });

  test('the host asks, the other person agrees, it records, stops and can be watched', async ({ browser }) => {
    test.setTimeout(180_000);
    const host = await personIn(browser, USERS.worker.email);
    const lead = await personIn(browser, USERS.lead.email);
    await host.goto('/meetings');
    await host.getByRole('button', { name: 'Instant call' }).click();
    await host.getByRole('searchbox', { name: 'Call' }).fill('Leo');
    await host.getByRole('button', { name: new RegExp(USERS.lead.name) }).click();
    await host.getByRole('button', { name: 'Start call' }).click();
    await expect(host).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/);
    const url = host.url();
    await host.getByRole('button', { name: 'Join meeting' }).click();
    await join(host);
    await lead.goto(url);
    await lead.getByRole('button', { name: 'Join meeting' }).click();
    await join(lead);
    await expect(host.getByTestId('tile-remote')).toHaveAttribute('data-identity', USERS.lead.id);

    await host.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(host.getByTestId('recording-banner')).toContainText('Nothing is recorded until everyone agrees');
    const ask = lead.getByTestId('recording-consent');
    await expect(ask).toContainText('May this meeting be recorded?');
    await ask.getByRole('button', { name: 'I agree' }).click();
    await expect(lead.getByTestId('recording-banner')).toContainText('Recording. Everyone in this call agreed', { timeout: 20_000 });
    await expect(host.getByTestId('recording-banner')).toContainText('Recording. Everyone in this call agreed', { timeout: 20_000 });

    // Let Egress record a few seconds of the call.
    await host.waitForTimeout(8_000);
    await host.getByRole('button', { name: 'Stop recording' }).click();
    const card = host.getByTestId('recordings-card');
    await expect(card).toContainText('Ready', { timeout: 90_000 });
    await expect(host.getByTestId('recording-banner')).toHaveCount(0);
    await card.getByRole('button', { name: 'Watch' }).click();
    const player = host.getByTestId('recording-player');
    await expect(player).toBeVisible();
    await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.duration), { timeout: 20_000 }).toBeGreaterThan(3);

    // The other recorded person may watch too.
    await lead.reload();
    await expect(lead.getByTestId('recordings-card').getByRole('button', { name: 'Watch' })).toBeVisible();
    const row = (await adminPool().query(`SELECT status, sha256, staging_key FROM meeting_recordings WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1`, [ORG_ID])).rows[0];
    expect(row.status).toBe('READY');
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.staging_key).toBeNull();
  });
});
