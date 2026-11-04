import { expect, test, type Browser, type Page } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';
import { hearsAudio, inboundAudio, localTracks, paintedFrames, PC_HOOK, TRACK_HOOK } from './media';

/**
 * ADR 048 §3b: the office call toolbar above the map. Every control is checked against what the
 * other person actually sees or hears (B's tile of A, B's audio), the speaker switch against A's
 * audio elements (A's microphone and subscriptions stay), and the toolbar against the dock across
 * pages, a room change, a network drop, a token expiry and a take-over. One session per tab: no
 * second token, at most one live microphone and camera track.
 */

async function open(browser: Browser, email: string, mobile = false): Promise<Page> {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}) });
  await ctx.addInitScript(PC_HOOK);
  await ctx.addInitScript(TRACK_HOOK);
  const page = await ctx.newPage();
  await signIn(page, email);
  await passNoticeGate(page);
  await page.goto('/office');
  await expect(page.getByTestId('office-canvas')).toHaveAttribute('data-connected', 'true');
  return page;
}
const bar = (p: Page) => p.getByTestId('office-toolbar');
const btn = (p: Page, name: string) => bar(p).getByRole('button', { name, exact: true });
async function turnOn(p: Page): Promise<void> {
  await expect(p.getByRole('button', { name: 'Turn on audio and video' })).toHaveCount(1);
  await p.getByRole('button', { name: 'Turn on audio and video' }).click();
  await p.getByTestId('prejoin').getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(btn(p, 'Mute speakers')).toBeVisible();
}
const goTo = (p: Page, room: string) => p.getByRole('list', { name: 'Rooms' }).getByTestId(`room-${room}`).getByRole('button', { name: `Go to ${room}` }).click();
const nav = (p: Page, link: string) => p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: link, exact: true }).click();
const remoteOf = (p: Page) => p.getByTestId('office-media').getByTestId('tile-remote');
const audioEls = (p: Page) => p.evaluate(() => Array.from(document.querySelectorAll('audio')).map((a) => a.muted));
const liveKinds = (p: Page) => p.evaluate(() => {
  const t = (window as unknown as { __tracks: MediaStreamTrack[] }).__tracks.filter((x) => x.readyState === 'live');
  return { audio: t.filter((x) => x.kind === 'audio').length, video: t.filter((x) => x.kind === 'video').length };
});
const openPcs = (p: Page) => p.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.filter((x) => x.connectionState !== 'closed').length);
const note = (type: string, description: string) => { test.info().annotations.push({ type, description }); console.log(`[qa] ${type}: ${description}`); };

test.describe.serial('Office call toolbar (ADR 048 §3b)', () => {
  test('desktop: every control works on its own and matches what the colleague sees and hears', async ({ browser }) => {
    test.setTimeout(360_000);
    const a = await open(browser, USERS.worker.email);
    const b = await open(browser, USERS.lead.email);
    let tokens = 0;
    a.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/media/token')) tokens += 1; });
    try {
      // Before media: one prominent enable action, the status says it is off, the card only explains.
      await expect(a.getByTestId('office-call-status')).toContainText('Audio and video off');
      await expect(a.getByTestId('office-media-off').getByRole('button')).toHaveCount(0);
      // Both start side by side (a proximity call); alone in the Lounge there is nobody to talk to.
      await goTo(a, 'Lounge');
      await expect(a.getByTestId('my-status')).toContainText('Lounge');
      await turnOn(a);
      await turnOn(b);
      await expect(a.getByTestId('office-call-status')).toContainText('Nobody to talk to here');
      // No call yet: no live microphone, so the button shows it off, and it is disabled.
      await expect(btn(a, 'Unmute')).toBeDisabled();
      await expect(bar(a)).toHaveAttribute('data-mic', 'off');
      await expect(btn(a, 'Mute speakers')).toBeEnabled();

      await goTo(a, 'Meeting room A');
      await goTo(b, 'Meeting room A');
      await expect(bar(a)).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
      await expect(a.getByTestId('office-call-status')).toContainText('Connected · Meeting room A · 2 in call');
      await expect(remoteOf(b)).toHaveAttribute('data-identity', USERS.worker.id);
      await expect.poll(() => hearsAudio(b), { timeout: 20_000 }).toBe(true);
      const tokensInCall = tokens;

      // Microphone.
      await btn(a, 'Mute').click();
      await expect(bar(a)).toHaveAttribute('data-mic', 'off');
      await expect(btn(a, 'Unmute')).toHaveAttribute('aria-pressed', 'false');
      await expect(remoteOf(b).getByLabel('Muted')).toBeVisible();
      await expect.poll(() => hearsAudio(b), { timeout: 15_000 }).toBe(false);
      await btn(a, 'Unmute').click();
      await expect(bar(a)).toHaveAttribute('data-mic', 'on');
      await expect(remoteOf(b).getByLabel('Microphone on')).toBeVisible();
      await expect.poll(() => hearsAudio(b), { timeout: 15_000 }).toBe(true);

      // Camera.
      await btn(a, 'Camera').click();
      await expect(bar(a)).toHaveAttribute('data-cam', 'on', { timeout: 20_000 });
      await expect(btn(a, 'Camera')).toHaveAttribute('aria-pressed', 'true');
      await remoteOf(b).scrollIntoViewIfNeeded();
      await expect.poll(() => paintedFrames(remoteOf(b).locator('video')), { timeout: 20_000 }).toBeGreaterThan(0);
      await btn(a, 'Camera').click();
      await expect(bar(a)).toHaveAttribute('data-cam', 'off');
      await expect(remoteOf(b).locator('video')).toHaveCount(0, { timeout: 15_000 });

      // Speakers: A hears nothing, but A's microphone still reaches B and A still receives audio.
      await btn(a, 'Mute speakers').click();
      await expect(bar(a)).toHaveAttribute('data-speaker', 'off');
      await expect(btn(a, 'Unmute speakers')).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(async () => { const m = await audioEls(a); return m.length > 0 && m.every(Boolean); }).toBe(true);
      expect(await liveKinds(a), 'microphone untouched').toMatchObject({ audio: 1 });
      await expect(bar(a)).toHaveAttribute('data-mic', 'on');
      await expect.poll(() => hearsAudio(b), { timeout: 15_000 }).toBe(true);
      const in0 = await inboundAudio(a);
      await a.waitForTimeout(2000);
      expect((await inboundAudio(a)).packets, 'still subscribed while the speakers are off').toBeGreaterThan(in0.packets);
      await expect(bar(a)).toHaveAttribute('data-status', 'connected');
      // The setting survives a room change: the new call's audio elements start muted.
      await goTo(a, 'Meeting room B');
      await goTo(b, 'Meeting room B');
      await expect(a.getByTestId('office-call-status')).toContainText('Connected · Meeting room B · 2 in call', { timeout: 30_000 });
      await expect.poll(async () => { const m = await audioEls(a); return m.length > 0 && m.every(Boolean); }, { timeout: 20_000 }).toBe(true);
      await btn(a, 'Unmute speakers').click();
      await expect(bar(a)).toHaveAttribute('data-speaker', 'on');
      await expect.poll(async () => { const m = await audioEls(a); return m.length > 0 && m.every((x) => !x); }).toBe(true);
      await expect.poll(() => hearsAudio(a), { timeout: 15_000 }).toBe(true);

      // Privacy: a muted microphone stays muted when the call changes (walking into another room).
      await btn(a, 'Mute').click();
      await expect(remoteOf(b).getByLabel('Muted')).toBeVisible();
      await goTo(a, 'Meeting room A');
      await goTo(b, 'Meeting room A');
      await expect(a.getByTestId('office-call-status')).toContainText('Connected · Meeting room A · 2 in call', { timeout: 30_000 });
      await expect(remoteOf(b)).toHaveAttribute('data-identity', USERS.worker.id);
      await a.waitForTimeout(3000);
      await expect(bar(a), 'still muted after the room change').toHaveAttribute('data-mic', 'off');
      await expect(remoteOf(b).getByLabel('Muted')).toBeVisible();
      await expect.poll(() => hearsAudio(b), { timeout: 10_000 }).toBe(false);
      await btn(a, 'Unmute').click();
      await expect(remoteOf(b).getByLabel('Microphone on')).toBeVisible();
      await expect.poll(() => hearsAudio(b), { timeout: 15_000 }).toBe(true);

      // Screen share and hand.
      await btn(a, 'Share screen').click();
      await expect(btn(a, 'Stop sharing')).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });
      await expect(b.getByTestId('office-media').getByTestId('screen-share')).toContainText(`${USERS.worker.name} is presenting`, { timeout: 20_000 });
      await btn(a, 'Stop sharing').click();
      await expect(b.getByTestId('office-media').getByTestId('screen-share')).toHaveCount(0, { timeout: 20_000 });
      await btn(a, 'Raise hand').click();
      await expect(remoteOf(b).getByLabel('Hand raised')).toBeVisible();
      await btn(a, 'Lower hand').click();
      await expect(remoteOf(b).getByLabel('Hand raised')).toHaveCount(0);

      // Audio only: B's camera stops showing on A; A's camera goes off; off again brings B's video back.
      await btn(b, 'Camera').click();
      await expect(bar(b)).toHaveAttribute('data-cam', 'on', { timeout: 20_000 });
      await remoteOf(a).scrollIntoViewIfNeeded();
      await expect.poll(() => paintedFrames(remoteOf(a).locator('video')), { timeout: 20_000 }).toBeGreaterThan(0);
      await btn(a, 'Audio only').click();
      await expect(btn(a, 'Audio only')).toHaveAttribute('aria-pressed', 'true');
      await expect(remoteOf(a).locator('video')).toHaveCount(0);
      await btn(a, 'Audio only').click();
      await expect(btn(a, 'Audio only')).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(() => paintedFrames(remoteOf(a).locator('video')), { timeout: 20_000 }).toBeGreaterThan(0);
      await btn(b, 'Camera').click();

      // Keyboard and screen readers: every control has a name and a tooltip; Space and Enter toggle.
      const names = await bar(a).getByRole('button').evaluateAll((els) => els.map((e) => ({ n: e.getAttribute('aria-label') ?? e.textContent ?? '', t: e.getAttribute('title') })));
      expect(names.filter((x) => !x.n.trim())).toEqual([]);
      expect(names.filter((x) => x.n !== 'Return to meeting' && !x.t)).toEqual([]);
      await expect(bar(a).getByRole('toolbar', { name: 'Call controls' })).toBeVisible();
      await expect(a.getByTestId('office-call-status')).toHaveAttribute('role', 'status');
      await btn(a, 'Mute').focus();
      await a.keyboard.press('Space');
      await expect(bar(a)).toHaveAttribute('data-mic', 'off');
      await btn(a, 'Unmute').focus();
      await a.keyboard.press('Enter');
      await expect(bar(a)).toHaveAttribute('data-mic', 'on');

      // One session: room changes needed new tokens, toggles did not; one live microphone, no duplicate peer connections.
      note('session', `media tokens: ${tokens} (1 per room joined; ${tokensInCall} before the controls, then rooms B and A), live tracks ${JSON.stringify(await liveKinds(a))}, open peer connections ${await openPcs(a)}`);
      expect(tokens).toBe(tokensInCall + 2);
      expect(await liveKinds(a)).toEqual({ audio: 1, video: 0 });
      expect(await openPcs(a)).toBeLessThanOrEqual(2);

      // Sticky above the map while scrolling (desktop).
      await a.evaluate(() => window.scrollTo(0, 0));
      await a.screenshot({ path: test.info().outputPath('toolbar-desktop.png') });
      await a.evaluate(() => window.scrollBy(0, 900));
      expect(await a.evaluate(() => window.scrollY), 'the page scrolled').toBeGreaterThan(100);
      await expect.poll(async () => (await bar(a).boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(56);
      expect((await bar(a).boundingBox())!.y).toBeLessThan(80);
      await a.screenshot({ path: test.info().outputPath('toolbar-desktop-scrolled.png') });
      await a.evaluate(() => window.scrollTo(0, 0));

      // Leave call: back to the enable action; devices released; B no longer has A.
      await btn(a, 'Leave call').click();
      await expect(a.getByRole('button', { name: 'Turn on audio and video' })).toBeVisible();
      await expect(remoteOf(b)).toHaveCount(0);
      await expect.poll(() => localTracks(a), { timeout: 10_000 }).toMatchObject({ live: 0 });
    } finally {
      await b.context().close();
      await a.context().close();
    }
  });

  test('toolbar and dock agree across pages; reconnecting is shown; token expiry; take-over', async ({ browser }) => {
    test.setTimeout(480_000);
    const a = await open(browser, USERS.worker.email);
    const b = await open(browser, USERS.lead.email);
    let tokens = 0;
    a.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/media/token')) tokens += 1; });
    const dock = a.getByTestId('call-dock');
    try {
      await turnOn(a); await turnOn(b);
      await goTo(a, 'Meeting room A'); await goTo(b, 'Meeting room A');
      await expect(a.getByTestId('office-call-status')).toContainText('Connected · Meeting room A · 2 in call', { timeout: 30_000 });
      const t0 = tokens;
      // Muted on the toolbar → muted in the dock on Tasks; changed in the dock → shown on the toolbar back in the office.
      await btn(a, 'Mute').click();
      await btn(a, 'Mute speakers').click();
      await nav(a, 'Tasks');
      await expect(dock).toHaveAttribute('data-mic', 'off');
      await expect(dock).toHaveAttribute('data-speaker', 'off');
      await dock.getByRole('button', { name: 'Unmute', exact: true }).click();
      await dock.getByRole('button', { name: 'Unmute speakers', exact: true }).click();
      await expect(remoteOf(b).getByLabel('Microphone on')).toBeVisible();
      await dock.getByRole('button', { name: 'Return to office', exact: true }).click();
      await expect(bar(a)).toHaveAttribute('data-mic', 'on');
      await expect(bar(a)).toHaveAttribute('data-speaker', 'on');
      await expect(bar(a)).toHaveAttribute('data-status', 'connected');
      expect(tokens, 'navigation reuses the session').toBe(t0);

      // Network drop: the toolbar says Reconnecting…, then connected; audio flows again.
      await a.context().setOffline(true);
      await expect(a.getByTestId('office-call-status')).toContainText('Reconnecting…', { timeout: 30_000 });
      await a.context().setOffline(false);
      await expect(bar(a)).toHaveAttribute('data-status', 'connected', { timeout: 60_000 });
      await expect.poll(() => hearsAudio(b), { timeout: 30_000 }).toBe(true);
      note('network', `offline: toolbar showed Reconnecting…; back online: connected, audio flows (tokens ${tokens - t0} new)`);

      // Token expiry (two-minute tokens in e2e): controls still work and the avatar still moves.
      await a.waitForTimeout(130_000);
      await expect(bar(a)).toHaveAttribute('data-status', 'connected');
      await btn(a, 'Mute').click();
      await expect(remoteOf(b).getByLabel('Muted')).toBeVisible();
      await btn(a, 'Unmute').click();
      await expect(remoteOf(b).getByLabel('Microphone on')).toBeVisible();
      const before = await a.getByTestId('office-canvas').getAttribute('data-self');
      await a.getByTestId('office-canvas').focus();
      await a.keyboard.down('KeyD'); await a.waitForTimeout(700); await a.keyboard.up('KeyD');
      await expect.poll(() => a.getByTestId('office-canvas').getAttribute('data-self')).not.toBe(before);

      // Second tab: its toolbar offers Take over; after it, its indicators match the real call and the first tab is off.
      const a2 = await a.context().newPage();
      await a2.goto('/office');
      await expect(a2.getByTestId('office-canvas')).toHaveAttribute('data-connected', 'true');
      await a2.getByRole('button', { name: 'Turn on audio and video' }).click();
      await a2.getByTestId('prejoin').getByRole('button', { name: 'Turn on', exact: true }).click();
      await expect(bar(a2).getByTestId('call-elsewhere')).toContainText('This call is open in another tab');
      await expect(a2.getByTestId('office-call-status')).toContainText('Open in another tab');
      await bar(a2).getByRole('button', { name: 'Take over', exact: true }).click();
      await expect(bar(a2)).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
      await expect(bar(a2)).toHaveAttribute('data-mic', 'on');
      await expect(a2.getByTestId('office-media').getByTestId('tile-local').getByLabel('Microphone on')).toBeVisible();
      await expect(a.getByRole('button', { name: 'Turn on audio and video' })).toBeVisible();
      await expect(a.getByTestId('office-media-off')).toContainText('taken over by another tab');
      await expect(remoteOf(b)).toHaveCount(1);
      await btn(a2, 'Mute').click();
      await expect(remoteOf(b).getByLabel('Muted')).toBeVisible();
      await a2.close();
      await expect(remoteOf(b)).toHaveCount(0);
    } finally {
      await b.context().close();
      await a.context().close();
    }
  });

  test('phone: the toolbar fits, is not sticky over the map, and the controls work by touch', async ({ browser }) => {
    test.setTimeout(240_000);
    const a = await open(browser, USERS.worker.email, true);
    const b = await open(browser, USERS.lead.email);
    try {
      const fits = () => a.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      expect(await fits()).toBe(true);
      await a.screenshot({ path: test.info().outputPath('toolbar-mobile-off.png') });
      await turnOn(a); await turnOn(b);
      await goTo(b, 'Meeting room A'); await goTo(a, 'Meeting room A');
      await expect(a.getByTestId('office-call-status')).toContainText('Connected · Meeting room A · 2 in call', { timeout: 30_000 });
      expect(await fits(), 'no horizontal overflow in a call').toBe(true);
      expect(await bar(a).evaluate((el) => getComputedStyle(el).position), 'not sticky on a phone').not.toBe('sticky');
      const box = (await bar(a).boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      note('mobile', `toolbar ${Math.round(box.width)}x${Math.round(box.height)} at y=${Math.round(box.y)}`);
      await a.evaluate(() => window.scrollTo(0, 0));
      await a.screenshot({ path: test.info().outputPath('toolbar-mobile-call.png') });
      await btn(a, 'Mute').tap();
      await expect(remoteOf(b).getByLabel('Muted')).toBeVisible();
      await btn(a, 'Mute speakers').tap();
      await expect(bar(a)).toHaveAttribute('data-speaker', 'off');
      await btn(a, 'Leave call').tap();
      await expect(remoteOf(b)).toHaveCount(0);
      await expect.poll(() => localTracks(a), { timeout: 10_000 }).toMatchObject({ live: 0 });
    } finally {
      await b.context().close();
      await a.context().close();
    }
  });
});
