import { expect, test, type Browser, type Page } from '@playwright/test';
import { adminPool, USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';
import { hearsAudio, localTracks, paintedFrames, PC_HOOK, TRACK_HOOK } from './media';

/**
 * Meetings over a real LiveKit with Chromium's fake camera and microphone (FR-MEET-001, 004, 005,
 * 011; ADR 016): ring, pre-join device check, two people seeing each other, attendance credited
 * from LiveKit webhooks, and the lobby.
 */
async function personIn(browser: Browser, email: string, hooks = false): Promise<Page> {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  if (hooks) { await ctx.addInitScript(PC_HOOK); await ctx.addInitScript(TRACK_HOOK); }
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

  /**
   * Two people, both directions (meeting system repair, 2026-11-17): each hears and sees the other;
   * mute and camera reach the other side; the controls wait while LiveKit connects and reconnects;
   * the call survives a network drop and a page change; Leave releases every device and connection.
   */
  test('two people hear and see each other both ways; controls follow the connection; Leave releases everything', async ({ browser }) => {
    test.setTimeout(300_000);
    const host = await personIn(browser, USERS.worker.email, true);
    const guest = await personIn(browser, USERS.lead.email, true);
    const controls = (p: Page) => p.getByTestId('call-view').getByRole('toolbar', { name: 'Call controls' });
    const ctl = (p: Page, name: string) => controls(p).getByRole('button', { name, exact: true });
    const openPcs = (p: Page) => p.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.filter((x) => x.connectionState !== 'closed').length);
    try {
      await guest.goto('/meetings');
      await host.goto('/meetings');
      await host.getByRole('button', { name: 'Instant call' }).click();
      await host.getByRole('searchbox', { name: 'Call' }).fill('Leo');
      await host.getByRole('button', { name: new RegExp(USERS.lead.name) }).click();
      await host.getByRole('button', { name: 'Start call' }).click();
      await expect(host).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/);
      await host.getByRole('button', { name: 'Join meeting' }).click();

      // While LiveKit is still connecting, the meeting page says so and offers no call controls yet.
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let held = 0;
      await host.routeWebSocket((u) => u.pathname.startsWith('/rtc'), async (ws) => {
        held += 1;
        if (held === 1) await gate;
        try { ws.connectToServer(); } catch { /* the page already gave up on this connection */ }
      });
      await passPreJoin(host, true);
      const joining = host.getByRole('status').filter({ hasText: 'Joining…' });
      await expect(joining).toBeVisible();
      await host.waitForTimeout(1500);
      expect(held, 'the signalling connection is held').toBe(1);
      await expect(joining, 'still joining while the signalling is held').toBeVisible();
      await expect(host.getByTestId('call-view')).toHaveCount(0);
      await expect(host.getByRole('toolbar', { name: 'Call controls' })).toHaveCount(0);
      release();
      await expect(host.getByTestId('call-view')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
      for (const name of ['Mute', 'Camera', 'Share screen', 'Raise hand']) await expect(ctl(host, name), `${name} once connected`).toBeEnabled();

      const ring = guest.getByTestId('ring');
      await ring.getByRole('button', { name: 'Accept', exact: true }).click();
      await passPreJoin(guest, true);
      await expect(guest.getByTestId('call-view')).toHaveAttribute('data-status', 'connected');

      // Both directions: each sees the other's camera and hears the other's microphone.
      await expect(host.getByTestId('tile-remote')).toHaveAttribute('data-identity', USERS.lead.id);
      await expect(guest.getByTestId('tile-remote')).toHaveAttribute('data-identity', USERS.worker.id);
      await expect.poll(() => paintedFrames(host.getByTestId('tile-remote').locator('video')), { timeout: 20_000 }).toBeGreaterThan(0);
      await expect.poll(() => paintedFrames(guest.getByTestId('tile-remote').locator('video')), { timeout: 20_000 }).toBeGreaterThan(0);
      await expect.poll(() => hearsAudio(guest), { timeout: 20_000 }).toBe(true);
      await expect.poll(() => hearsAudio(host), { timeout: 20_000 }).toBe(true);

      // Mute and unmute reach the other side.
      await ctl(host, 'Mute').click();
      await expect(guest.getByTestId('tile-remote').getByLabel('Muted')).toBeVisible();
      await expect.poll(() => hearsAudio(guest), { timeout: 15_000 }).toBe(false);
      await ctl(host, 'Unmute').click();
      await expect(guest.getByTestId('tile-remote').getByLabel('Microphone on')).toBeVisible();
      await expect.poll(() => hearsAudio(guest), { timeout: 15_000 }).toBe(true);

      // Camera off and on reach the other side.
      await ctl(host, 'Camera').click();
      await expect(ctl(host, 'Camera')).toHaveAttribute('aria-pressed', 'false');
      await expect(guest.getByTestId('tile-remote').locator('video')).toHaveCount(0, { timeout: 15_000 });
      await ctl(host, 'Camera').click();
      await expect(ctl(host, 'Camera')).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });
      await expect.poll(() => paintedFrames(guest.getByTestId('tile-remote').locator('video')), { timeout: 20_000 }).toBeGreaterThan(0);

      // A network drop: the page says so, the controls wait, then the call comes back both ways.
      await guest.context().setOffline(true);
      await expect(guest.getByTestId('call-view')).toHaveAttribute('data-status', 'reconnecting', { timeout: 30_000 });
      await expect(guest.getByTestId('call-view')).toContainText('Reconnecting…');
      for (const name of ['Mute', 'Camera', 'Share screen', 'Raise hand']) await expect(ctl(guest, name), `${name} while reconnecting`).toBeDisabled();
      await guest.context().setOffline(false);
      await expect(guest.getByTestId('call-view')).toHaveAttribute('data-status', 'connected', { timeout: 60_000 });
      await expect(ctl(guest, 'Mute')).toBeEnabled();
      await expect.poll(() => hearsAudio(guest), { timeout: 30_000 }).toBe(true);
      await expect.poll(() => hearsAudio(host), { timeout: 30_000 }).toBe(true);

      // Another page keeps the call (the dock); back on the meeting it is the same call.
      await guest.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Tasks', exact: true }).click();
      await expect(guest.getByTestId('call-dock')).toHaveAttribute('data-status', 'connected');
      await expect.poll(() => hearsAudio(host), { timeout: 15_000 }).toBe(true);
      await guest.getByTestId('call-dock').getByRole('button', { name: 'Return to meeting', exact: true }).click();
      await expect(guest.getByTestId('call-view')).toHaveAttribute('data-status', 'connected');

      // Leave: the other side loses the tile; every device and peer connection is released.
      await ctl(guest, 'Leave').click();
      await expect(host.getByTestId('tile-remote')).toHaveCount(0, { timeout: 15_000 });
      await expect.poll(() => localTracks(guest), { timeout: 10_000 }).toMatchObject({ live: 0 });
      await expect.poll(() => openPcs(guest), { timeout: 10_000 }).toBe(0);
      await ctl(host, 'Leave').click();
      await expect.poll(() => localTracks(host), { timeout: 10_000 }).toMatchObject({ live: 0 });
      await expect.poll(() => openPcs(host), { timeout: 10_000 }).toBe(0);
    } finally {
      await guest.context().close();
      await host.context().close();
    }
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
    await worker.getByTestId('office-toolbar').getByRole('button', { name: 'Share screen' }).click();
    await expect(lead.getByTestId('office-media').getByTestId('screen-share')).toContainText(`${USERS.worker.name} is presenting`);
    await worker.getByTestId('office-toolbar').getByRole('button', { name: 'Stop sharing' }).click();
    await expect(lead.getByTestId('office-media').getByTestId('screen-share')).toHaveCount(0);
    await lead.context().close();
    await worker.context().close();
  });
});
