import { expect, test, type Browser, type Page } from '@playwright/test';
import { adminPool, USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

/**
 * Meetings over a real LiveKit with Chromium's fake camera and microphone (FR-MEET-001, 004, 005,
 * 011; ADR 016): ring, pre-join device check, two people seeing each other, attendance credited
 * from LiveKit webhooks, and the lobby.
 */
async function personIn(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  await signIn(page, email);
  await passNoticeGate(page);
  return page;
}

async function passPreJoin(page: Page, camera: boolean): Promise<void> {
  const pre = page.getByTestId('prejoin');
  await expect(pre).toBeVisible();
  // The fake microphone plays a tone, so the level meter moves.
  await expect.poll(async () => Number(await pre.getByRole('meter', { name: 'Microphone level' }).getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  if (camera) {
    await pre.getByRole('button', { name: 'Camera off' }).click();
    // Real frames from the fake camera, not just an empty element.
    await expect.poll(() => pre.getByTestId('prejoin-video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  }
  await pre.getByRole('button', { name: 'Join', exact: true }).click();
}

test.describe.serial('Meetings: instant call, device check, lobby', () => {
  test('an instant call rings the invitee; both join and see each other; attendance is recorded', async ({ browser }) => {
    const lead = await personIn(browser, USERS.lead.email);
    await lead.goto('/meetings');
    const host = await personIn(browser, USERS.worker.email);
    await host.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Meetings' }).click();
    await host.getByRole('button', { name: 'Instant call' }).click();
    await host.getByRole('searchbox', { name: 'Call' }).fill('Leo');
    await host.getByRole('button', { name: new RegExp(USERS.lead.name) }).click();
    await host.getByRole('button', { name: 'Start call' }).click();
    await expect(host).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/);
    const meetingId = host.url().split('/').pop()!;
    await host.getByRole('button', { name: 'Join meeting' }).click();
    await passPreJoin(host, true);
    await expect(host.getByTestId('call-view')).toHaveAttribute('data-status', 'connected');
    await expect(host.getByTestId('tile-local')).toBeVisible();

    // The invitee gets a ring (who is calling, and the call), accepts it and joins.
    const ring = lead.getByTestId('ring');
    await expect(ring).toContainText(`${USERS.worker.name} is calling you`);
    await expect(ring).toContainText('Call with');
    await ring.getByRole('button', { name: 'Accept', exact: true }).click();
    await passPreJoin(lead, false);
    await expect(lead.getByTestId('call-view')).toHaveAttribute('data-status', 'connected');

    // Each sees the other; the host's fake camera reaches the invitee.
    await expect(host.getByTestId('tile-remote')).toHaveAttribute('data-identity', USERS.lead.id);
    await expect(lead.getByTestId('tile-remote')).toHaveAttribute('data-identity', USERS.worker.id);
    await expect(lead.getByTestId('tile-remote').locator('video')).toBeVisible();
    await expect.poll(() => lead.getByTestId('tile-remote').locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 20_000 }).toBeGreaterThan(0);

    // LiveKit webhooks credit both (server clock), and the meeting is live.
    const pool = adminPool();
    try {
      await expect.poll(async () => (await pool.query(`SELECT count(DISTINCT user_id)::int AS n FROM meeting_participants WHERE meeting_id = $1`, [meetingId])).rows[0].n, { timeout: 20_000 }).toBe(2);
      expect((await pool.query(`SELECT status FROM meetings WHERE id = $1`, [meetingId])).rows[0].status).toBe('LIVE');
    } finally {
      await pool.end();
    }

    // Mute and raise a hand; the other side sees it.
    await lead.getByRole('toolbar', { name: 'Call controls' }).getByRole('button', { name: 'Raise hand' }).click();
    await expect(host.getByTestId('tile-remote').getByLabel('Hand raised')).toBeVisible();

    // Screen share next to a live camera reaches the other side (regression: H.264 negotiation).
    await host.getByRole('button', { name: 'Share screen' }).click();
    await expect(lead.getByTestId('screen-share')).toContainText(`${USERS.worker.name} is presenting`);
    await expect.poll(() => lead.getByTestId('screen-share').locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 20_000 }).toBeGreaterThan(0);
    await host.getByRole('button', { name: 'Stop sharing' }).click();
    await expect(lead.getByTestId('screen-share')).toHaveCount(0);

    await lead.getByRole('button', { name: 'Leave' }).click();
    await expect(host.getByTestId('tile-remote')).toHaveCount(0);
    await host.getByRole('button', { name: 'Leave' }).click();
    await lead.context().close();
    await host.context().close();
  });

  test('someone who was not invited waits in the lobby until the host admits them', async ({ browser }) => {
    const host = await personIn(browser, USERS.worker.email);
    await host.goto('/meetings');
    await host.getByRole('button', { name: 'Instant call' }).click();
    await host.getByRole('button', { name: 'Start call' }).click();
    await expect(host).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/);
    const meetingId = host.url().split('/').pop()!;
    await host.getByRole('button', { name: 'Join meeting' }).click();
    await passPreJoin(host, false);
    await expect(host.getByTestId('call-view')).toHaveAttribute('data-status', 'connected');

    const guest = await personIn(browser, USERS.sub.email);
    await guest.goto(`/meetings/${meetingId}?join=1`);
    await passPreJoin(guest, false);
    await expect(guest.getByTestId('lobby-waiting')).toContainText('Waiting for the host');

    const lobby = host.getByTestId('lobby');
    await expect(lobby).toContainText(USERS.sub.name);
    await lobby.getByRole('button', { name: 'Admit' }).click();
    await expect(guest.getByTestId('call-view')).toHaveAttribute('data-status', 'connected');
    await expect(host.getByTestId('tile-remote')).toHaveAttribute('data-identity', USERS.sub.id);

    // Host control: remove the guest.
    await host.getByLabel('Participant to remove').selectOption(USERS.sub.id);
    await host.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(guest.getByTestId('join-denied')).toContainText('removed');
    await expect(host.getByTestId('tile-remote')).toHaveCount(0);
    await guest.context().close();
    await host.context().close();
  });

  test('office: standing next to a colleague joins a proximity call; screen share reaches them', async ({ browser }) => {
    const turnOn = async (page: Page) => {
      await page.goto('/office');
      await expect(page.getByTestId('office-canvas').locator('canvas')).toBeVisible();
      await page.getByRole('button', { name: 'Turn on audio and video' }).click();
      const pre = page.getByTestId('prejoin');
      await pre.getByRole('button', { name: 'Turn on', exact: true }).click();
      await expect(page.getByTestId('office-media')).toBeVisible();
    };
    const lead = await personIn(browser, USERS.lead.email);
    await turnOn(lead);
    const worker = await personIn(browser, USERS.worker.email);
    await turnOn(worker);
    await worker.getByLabel('Find a colleague').fill('Leo');
    await worker.getByTestId('people-list').getByRole('button', { name: `Go to ${USERS.lead.name}` }).click();
    await expect(worker.getByTestId('proximity')).toContainText(USERS.lead.name);

    const media = worker.getByTestId('office-media');
    await expect(media).toContainText('Nearby');
    await expect(media.getByTestId('tile-remote')).toHaveAttribute('data-identity', USERS.lead.id);
    await expect(lead.getByTestId('office-media').getByTestId('tile-remote')).toHaveAttribute('data-identity', USERS.worker.id);

    // FR-VO-009: screen share (Chromium picks the fake screen without a prompt).
    await media.getByRole('button', { name: 'Share screen' }).click();
    await expect(lead.getByTestId('office-media').getByTestId('screen-share')).toContainText(`${USERS.worker.name} is presenting`);
    await media.getByRole('button', { name: 'Stop sharing' }).click();
    await expect(lead.getByTestId('office-media').getByTestId('screen-share')).toHaveCount(0);
    await lead.context().close();
    await worker.context().close();
  });
});
