import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

/**
 * FR-VO-009 / FR-MEET-004 (ADR 045): a shared screen can be seen properly: expanded over the page,
 * in browser full screen, in a separate window and (where supported) picture-in-picture, without
 * cropping and without reconnecting. "Seen" means frames painted into the viewer's <video>
 * (requestVideoFrameCallback), not only a connected participant.
 */

async function inOffice(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  await signIn(page, email);
  await passNoticeGate(page);
  await page.goto('/office');
  await expect(page.getByTestId('office-canvas').locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Turn on audio and video' }).click();
  await page.getByTestId('prejoin').getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(page.getByTestId('office-media')).toBeVisible();
  return page;
}

const goTo = (page: Page, room: string) => page.getByRole('list', { name: 'Rooms' }).getByTestId(`room-${room}`).getByRole('button', { name: `Go to ${room}` }).click();

/** Frames painted into the <video> during one second, and its on-screen box. */
async function painted(video: Locator): Promise<{ frames: number; boxW: number; boxH: number; videoW: number; videoH: number; fit: string }> {
  return await video.evaluate((v: HTMLVideoElement) => new Promise((res) => {
    let frames = 0;
    const t0 = performance.now();
    const tick = () => { frames += 1; if (performance.now() - t0 < 1000) v.requestVideoFrameCallback(tick); };
    v.requestVideoFrameCallback(tick);
    setTimeout(() => { const r = v.getBoundingClientRect(); res({ frames, boxW: r.width, boxH: r.height, videoW: v.videoWidth, videoH: v.videoHeight, fit: getComputedStyle(v).objectFit }); }, 1100);
  }));
}
const showsFrames = async (video: Locator) => (await painted(video)).frames > 0;

test('office: a shared screen can be expanded, shown full screen and in a new window; only the presenter can stop it', async ({ browser }) => {
  test.setTimeout(180_000);
  const lead = await inOffice(browser, USERS.lead.email);
  const worker = await inOffice(browser, USERS.worker.email);
  try {
    await goTo(lead, 'Meeting room A');
    await goTo(worker, 'Meeting room A');
    await expect(lead.getByTestId('office-media').getByTestId('tile-remote')).toHaveAttribute('data-identity', USERS.worker.id);
    await worker.getByTestId('office-media').getByRole('button', { name: 'Share screen' }).click();

    const share = lead.getByTestId('screen-share');
    await expect(share).toContainText(`${USERS.worker.name} is presenting`);
    const inline = share.locator('video');
    await expect.poll(() => showsFrames(inline), { timeout: 20_000 }).toBe(true);
    expect((await painted(inline)).fit).toBe('contain'); // the whole screen, no cropping
    // Only the presenter has the stop button; the viewer can only close their own view.
    await expect(share.getByTestId('screen-stop')).toHaveCount(0);
    await expect(worker.getByTestId('screen-share').getByTestId('screen-stop')).toBeVisible();

    // Expand: a large overlay, aspect ratio kept, frames keep coming, the call stays connected.
    await share.getByRole('button', { name: 'Expand' }).click();
    const big = lead.getByTestId('screen-viewer-expanded');
    await expect(big).toBeVisible();
    const bigVideo = big.locator('video');
    await expect.poll(() => showsFrames(bigVideo), { timeout: 15_000 }).toBe(true);
    const e = await painted(bigVideo);
    const vp = lead.viewportSize();
    expect(e.boxW).toBeGreaterThan((vp?.width ?? 0) * 0.9);
    expect(e.fit).toBe('contain');
    await big.getByRole('button', { name: 'Actual size' }).click();
    await expect(big.getByTestId('screen-zoom')).toHaveText('100%');
    await big.getByRole('button', { name: 'Zoom shared screen in' }).click();
    await expect(big.getByTestId('screen-zoom')).toHaveText('150%');
    await big.getByRole('button', { name: 'Fit to screen' }).click();
    await expect(big.getByTestId('screen-zoom')).toContainText('Fit');
    await lead.keyboard.press('Escape');
    await expect(big).toHaveCount(0);
    await expect(lead.getByTestId('call-view')).toHaveAttribute('data-status', 'connected');

    // Full screen from the office layout; leaving it goes back to the office layout.
    await share.getByRole('button', { name: 'Full screen' }).click();
    await expect(big).toHaveAttribute('data-fullscreen', 'true');
    expect(await lead.evaluate(() => document.fullscreenElement?.getAttribute('data-testid'))).toBe('screen-viewer-expanded');
    await expect.poll(() => showsFrames(bigVideo), { timeout: 15_000 }).toBe(true);
    await big.getByRole('button', { name: 'Exit full screen' }).click();
    await expect(big).toHaveCount(0);
    expect(await lead.evaluate(() => document.fullscreenElement)).toBeNull();

    // A new window: same session (no new token), frames painted there; closing it stops nothing.
    let tokens = 0;
    lead.on('request', (r) => { if (r.url().endsWith('/media/token')) tokens += 1; });
    const popupP = lead.context().waitForEvent('page');
    await share.getByRole('button', { name: 'Open in new window' }).click();
    const popup = await popupP;
    expect(popup.url()).toBe('about:blank'); // nothing in the address bar: no token, no session id
    const popVideo = popup.getByTestId('screen-popout').locator('video');
    await expect.poll(() => showsFrames(popVideo), { timeout: 15_000 }).toBe(true);
    await expect(share).toHaveAttribute('data-viewer', 'popout');
    await popup.getByRole('button', { name: 'Close window' }).click();
    await expect.poll(() => popup.isClosed()).toBe(true);
    await expect(share).toHaveAttribute('data-viewer', 'inline');
    expect(tokens).toBe(0);
    await expect.poll(() => showsFrames(inline), { timeout: 15_000 }).toBe(true);
    await expect(worker.getByTestId('screen-share').getByTestId('screen-stop')).toBeVisible(); // still sharing

    // A blocked pop-up says so instead of failing silently.
    await lead.evaluate(() => { window.open = () => null; });
    await share.getByRole('button', { name: 'Open in new window' }).click();
    await expect(share.getByRole('alert')).toContainText('blocked the new window');

    // Closing the viewer only hides it here; it can be shown again.
    await share.getByRole('button', { name: 'Close viewer' }).click();
    await expect(share).toHaveAttribute('data-viewer', 'closed');
    await share.getByRole('button', { name: 'Show shared screen' }).click();
    await expect.poll(() => showsFrames(lead.getByTestId('screen-share').locator('video')), { timeout: 15_000 }).toBe(true);

    // The presenter stops: every view of it goes away.
    await lead.getByTestId('screen-share').getByRole('button', { name: 'Expand' }).click();
    await expect(big).toBeVisible();
    await worker.getByTestId('screen-share').getByTestId('screen-stop').click();
    await expect(lead.getByTestId('screen-share')).toHaveCount(0);
    await expect(big).toHaveCount(0);
    await expect(worker.getByTestId('office-media').getByRole('button', { name: 'Share screen' })).toBeVisible();
  } finally {
    await worker.context().close();
    await lead.context().close();
  }
});
