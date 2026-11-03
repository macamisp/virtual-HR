import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { adminPool, ORG_ID, USERS } from './fixtures';
import { passNoticeGate, signIn, signOut } from './helpers';
import { hearsAudio, localTracks, paintedFrames, PC_HOOK, TRACK_HOOK } from './media';

/**
 * ADR 048 (FR-VO-002, 003, 005, FR-MEET-002, 005, 009, FR-ATT-006): a call and the office presence
 * survive navigation, like Google Meet. Two people with fake devices: A and B talk in a room; A
 * browses other pages while B keeps receiving A's audio and video and sees A "away from the office
 * view"; the floating dock has the controls; Return to office shows the same call (no new token);
 * Leave ends it for A only and stops A's camera; a second tab of A does not double-join and can
 * take over; a reload rejoins; meeting time keeps counting while A is on /tasks; sign-out ends it.
 */

async function inOffice(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(PC_HOOK);
  await ctx.addInitScript(TRACK_HOOK);
  const page = await ctx.newPage();
  await signIn(page, email);
  await passNoticeGate(page);
  await page.goto('/office');
  await expect(page.getByTestId('office-canvas').locator('canvas')).toBeVisible();
  await turnOn(page);
  return page;
}

async function turnOn(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Turn on audio and video' }).click();
  await page.getByTestId('prejoin').getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(page.getByTestId('office-media')).toBeVisible();
}

/** LiveKit only streams video to elements on screen, so the tile is scrolled into view before counting frames. */
async function framesOn(tile: Locator): Promise<number> { await tile.scrollIntoViewIfNeeded(); return paintedFrames(tile.locator('video')); }
/**
 * Turns the camera on once the microphone is published (the media connection is up). On a loaded
 * machine LiveKit can still reject a publish right after a room switch ("engine not connected
 * within timeout"); the page then shows the error and the camera stays off, so try once more.
 */
async function cameraOn(page: Page): Promise<void> {
  const media = page.getByTestId('office-media');
  await expect(media.getByTestId('tile-local').getByLabel('Microphone on')).toBeVisible();
  const camera = media.getByRole('button', { name: 'Camera', exact: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await camera.click();
    try { await expect(camera).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 }); return; } catch { /* rejected publish: once more */ }
  }
  await expect(camera).toHaveAttribute('aria-pressed', 'true');
}
const goTo = (page: Page, room: string) => page.getByRole('list', { name: 'Rooms' }).getByTestId(`room-${room}`).getByRole('button', { name: `Go to ${room}` }).click();
const nav = (page: Page, link: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: link, exact: true }).click();
const seconds = (text: string): number => { const m = text.match(/(\d+)h\s*(\d+)m|(\d+)m\s*(\d+)s|(\d+)m|(\d+)s/); if (!m) return 0; if (m[1]) return Number(m[1]) * 3600 + Number(m[2]) * 60; if (m[3]) return Number(m[3]) * 60 + Number(m[4]); if (m[5]) return Number(m[5]) * 60; return Number(m[6]); };

test('the call and the office presence follow the user across pages; one tab owns the call; reload and sign-out', async ({ browser }) => {
  test.setTimeout(600_000);
  const a = await inOffice(browser, USERS.worker.email);
  const b = await inOffice(browser, USERS.lead.email);
  let tokens = 0;
  a.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/media/token')) tokens += 1; });
  const bMedia = b.getByTestId('office-media');
  const bRemote = bMedia.getByTestId('tile-remote');
  const dock = a.getByTestId('call-dock');
  try {
    // 1. A and B talk in a room; A's camera is on so B gets video frames too.
    await goTo(a, 'Meeting room A');
    await goTo(b, 'Meeting room A');
    await expect(bRemote).toHaveAttribute('data-identity', USERS.worker.id);
    await expect(a.getByTestId('call-view')).toHaveAttribute('data-status', 'connected');
    await cameraOn(a);
    await expect.poll(() => hearsAudio(b), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => framesOn(bRemote), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(a.getByTestId('tracking-badge')).toContainText('In meeting');
    const tokensInCall = tokens;

    // 2. A goes to My attendance: the call keeps going, the dock appears, B still gets audio and video,
    //    and B sees A as away from the office view.
    await nav(a, 'My attendance');
    await expect(a).toHaveURL(/\/attendance$/);
    await expect(dock).toBeVisible();
    await expect(dock).toHaveAttribute('data-status', 'connected');
    await expect(dock).toHaveAttribute('data-mic', 'on');
    await expect(dock).toHaveAttribute('data-cam', 'on');
    await expect(dock.getByTestId('dock-status')).toContainText('Meeting room A: Connected, 2 in call. Microphone on, camera on');
    for (const name of ['Mute', 'Camera', 'Share screen', 'Raise hand', 'Leave', 'Return to office']) await expect(dock.getByRole('button', { name, exact: true })).toBeVisible();
    await expect(a.getByTestId('office-presence')).toContainText('In the office');
    await b.getByLabel('Find a colleague').fill('Wendy');
    const bPeople = b.getByTestId('people-list').getByRole('listitem').filter({ hasText: USERS.worker.name });
    await expect(bPeople).toContainText('in Meeting room A · away from the office view');
    await expect.poll(() => hearsAudio(b), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => framesOn(bRemote), { timeout: 20_000 }).toBeGreaterThan(0);
    const meetingBefore = seconds(await a.getByTestId('total-meeting').innerText());

    // 3. On Tasks: the dock controls work (mute, raise hand), meeting time keeps counting.
    await nav(a, 'Tasks');
    await expect(a).toHaveURL(/\/tasks$/);
    await expect(dock).toHaveAttribute('data-status', 'connected');
    await dock.getByRole('button', { name: 'Mute', exact: true }).click();
    await expect(dock).toHaveAttribute('data-mic', 'off');
    await expect(bRemote.getByLabel('Muted')).toBeVisible();
    await dock.getByRole('button', { name: 'Unmute', exact: true }).click();
    await expect(dock).toHaveAttribute('data-mic', 'on');
    await dock.getByRole('button', { name: 'Raise hand', exact: true }).click();
    await expect(bRemote.getByLabel('Hand raised')).toBeVisible();
    await dock.getByRole('button', { name: 'Lower hand', exact: true }).click();
    await expect(bRemote.getByLabel('Hand raised')).toHaveCount(0);
    await expect(a.getByTestId('tracking-badge')).toContainText('In meeting');
    const onTasksAt = new Date();
    await a.waitForTimeout(40_000); // more than a heartbeat interval
    await expect(a.getByTestId('tracking-badge')).toContainText('In meeting');
    expect(tokens, 'no new media token while browsing').toBe(tokensInCall);
    // The heartbeats sent while on /tasks carried inCall and kept the state IN_MEETING (FR-ATT-006, FR-MEET-009).
    const pool = adminPool();
    try {
      const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM presence_events WHERE org_id = $1 AND user_id = $2 AND event_type = 'HEARTBEAT' AND server_ts > $3 AND meta->>'inCall' = 'true' AND state = 'IN_MEETING'`, [ORG_ID, USERS.worker.id, onTasksAt]);
      expect(r.rows[0]!.n, 'in-call heartbeats while on /tasks').toBeGreaterThan(0);
    } finally { await pool.end(); }
    await nav(a, 'My attendance');
    // Totals are shown in minutes: a minute more than before the trip to the other pages.
    await expect.poll(async () => seconds(await a.getByTestId('total-meeting').innerText()), { timeout: 100_000 }).toBeGreaterThanOrEqual(meetingBefore + 60);

    // 4. Return to office: the map is back, the same call (no new token), the dock is gone.
    await dock.getByRole('button', { name: 'Return to office', exact: true }).click();
    await expect(a).toHaveURL(/\/office$/);
    await expect(a.getByTestId('office-canvas').locator('canvas')).toBeVisible();
    await expect(a.getByTestId('call-view')).toHaveAttribute('data-status', 'connected');
    await expect(a.getByTestId('office-media').getByTestId('tile-remote')).toHaveAttribute('data-identity', USERS.lead.id);
    await expect(dock).toHaveCount(0);
    await expect(a.getByTestId('office-presence')).toHaveCount(0);
    expect(tokens, 'Return to office reuses the running session').toBe(tokensInCall);
    await expect(bPeople).not.toContainText('away from the office view');

    // 5. Leave from the dock on another page: ends the call for A only; A's camera and microphone stop.
    await nav(a, 'Tasks');
    await expect(dock).toBeVisible();
    await dock.getByRole('button', { name: 'Leave', exact: true }).click();
    await expect(dock).toHaveCount(0);
    await expect(bRemote).toHaveCount(0);
    await expect(b.getByTestId('call-view')).toHaveAttribute('data-status', 'connected');
    await expect.poll(() => localTracks(a), { timeout: 10_000 }).toMatchObject({ live: 0 });
    expect((await localTracks(a)).total).toBeGreaterThan(0);
    await expect(a.getByTestId('tracking-badge')).toContainText('Active', { timeout: 20_000 });
    // Presence stayed: A is still in the room, just not on the call.
    await expect(bPeople).toContainText('in Meeting room A · away from the office view');

    // 6. Reload: back on the same spot, the call rejoins by itself (office media is still on for this tab).
    await nav(a, 'Office');
    await turnOn(a);
    await expect(a.getByTestId('call-view')).toHaveAttribute('data-status', 'connected');
    await expect(bRemote).toHaveCount(1);
    await a.reload();
    await expect(a.getByTestId('office-canvas').locator('canvas')).toBeVisible();
    await expect(a.getByTestId('my-status')).toContainText('Meeting room A');
    await expect(a.getByTestId('call-view')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
    await expect(bRemote).toHaveCount(1);
    await expect(bRemote).toHaveAttribute('data-identity', USERS.worker.id);
    await expect.poll(() => hearsAudio(b), { timeout: 20_000 }).toBe(true);

    // 7. A second tab of A does not join twice: it offers to take over, and then the first tab leaves.
    const a2 = await a.context().newPage();
    await a2.goto('/office');
    await expect(a2.getByTestId('office-canvas').locator('canvas')).toBeVisible();
    await turnOn(a2);
    await expect(a2.getByTestId('call-elsewhere')).toContainText('This call is open in another tab');
    await expect(a.getByTestId('call-view')).toHaveAttribute('data-status', 'connected');
    await expect(bRemote).toHaveCount(1);
    await a2.getByRole('button', { name: 'Take over', exact: true }).click();
    await expect(a2.getByTestId('call-view')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
    await expect(a.getByTestId('office-media-off')).toContainText('taken over by another tab');
    await expect(a.getByTestId('call-view')).toHaveCount(0);
    await expect(bRemote).toHaveCount(1);
    await a2.close();
    await expect(bRemote).toHaveCount(0);

    // 8. Sign-out ends the call and releases the devices.
    await turnOn(a);
    await expect(a.getByTestId('call-view')).toHaveAttribute('data-status', 'connected');
    await expect(bRemote).toHaveCount(1);
    await signOut(a);
    await expect(bRemote).toHaveCount(0);
    await expect(bPeople).toContainText('not in the office');
    await expect.poll(() => localTracks(a), { timeout: 10_000 }).toMatchObject({ live: 0 });
  } finally {
    await b.context().close();
    await a.context().close();
  }
});
