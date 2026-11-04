import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { adminPool, ORG_ID, USERS } from './fixtures';
import { passNoticeGate, signIn, signInAdmin, signOut } from './helpers';
import { hearsAudio, localTracks, paintedFrames, PC_HOOK, TRACK_HOOK } from './media';

/**
 * Version 2 QA sweep (ADR 048): what specs 16, 34–37 do not exercise. Office rooms (furniture and
 * wall collisions, occupancy, invite/knock/full rooms, live presence); a proximity call that follows
 * a user across Dashboard, Tasks and My attendance with camera and screen share from the dock; a
 * background/frozen tab; network loss and token expiry on another page; reload on another page;
 * meeting_seconds against the wall clock; console errors per role; resources after repeated calls
 * and after sign-out; phone-sized layout.
 */

const SOCKET_HOOK = () => {
  const w = window as unknown as { __ws: WebSocket[] };
  w.__ws = [];
  const Orig = window.WebSocket;
  window.WebSocket = class extends Orig { constructor(...a: ConstructorParameters<typeof WebSocket>) { super(...a); w.__ws.push(this); } };
};

async function open(browser: Browser, email: string, opts: { media?: boolean; mobile?: boolean } = {}): Promise<Page> {
  const ctx = await browser.newContext({
    ...(opts.media ? { permissions: ['camera', 'microphone'] } : {}),
    ...(opts.mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}),
  });
  await ctx.addInitScript(PC_HOOK);
  await ctx.addInitScript(TRACK_HOOK);
  await ctx.addInitScript(SOCKET_HOOK);
  const page = await ctx.newPage();
  await signIn(page, email);
  await passNoticeGate(page);
  return page;
}
async function toOffice(page: Page): Promise<void> {
  await page.goto('/office');
  await expect(page.getByTestId('office-canvas').locator('canvas')).toBeVisible();
  await expect(page.getByTestId('office-canvas')).toHaveAttribute('data-connected', 'true');
}
async function turnOn(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Turn on audio and video' }).click();
  await page.getByTestId('prejoin').getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(page.getByTestId('office-media')).toBeVisible();
}
const goTo = (page: Page, room: string) => page.getByRole('list', { name: 'Rooms' }).getByTestId(`room-${room}`).getByRole('button', { name: `Go to ${room}` }).click();
const nav = (page: Page, link: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: link, exact: true }).click();
const selfPos = async (page: Page): Promise<[number, number]> => {
  const [x, y] = ((await page.getByTestId('office-canvas').getAttribute('data-self')) ?? '0,0').split(',').map(Number);
  return [x ?? 0, y ?? 0];
};
async function hold(page: Page, key: string, ms: number): Promise<void> {
  await page.getByTestId('office-canvas').focus();
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
  await page.waitForTimeout(300);
}
function peopleRow(page: Page, name: string) {
  return page.getByTestId('people-list').getByRole('listitem').filter({ hasText: name });
}
async function find(page: Page, name: string) {
  await page.getByLabel('Find a colleague').fill(name.split(' ')[0]!);
  return peopleRow(page, name);
}
async function openSockets(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __ws: WebSocket[] }).__ws.filter((s) => s.readyState <= 1).length);
}
async function openPcs(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.filter((p) => p.connectionState !== 'closed').length);
}
async function heapMb(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  await cdp.detach();
  return Math.round(usedSize / 1e5) / 10;
}
const note = (type: string, description: string) => { test.info().annotations.push({ type, description }); console.log(`[qa] ${type}: ${description}`); };
const close = async (...ctxs: (BrowserContext | undefined)[]) => { for (const c of ctxs) await c?.close().catch(() => undefined); };

test.describe.serial('V2 QA sweep', () => {
  test('office: collisions, occupancy, invite/knock/full rooms and live presence', async ({ browser }) => {
    test.setTimeout(300_000);
    const a = await open(browser, USERS.worker.email);
    const b = await open(browser, USERS.lead.email);
    let admin: Page | null = null;
    try {
      await toOffice(a);
      await toOffice(b);
      // Walls: walking left for long stops at the wall and stays inside the map.
      await hold(a, 'KeyA', 5000);
      const [wx] = await selfPos(a);
      await hold(a, 'KeyA', 1500);
      const [wx2] = await selfPos(a);
      expect(wx2, 'blocked by the wall').toBe(wx);
      expect(wx, 'not inside the wall tile').toBeGreaterThanOrEqual(16);
      await expect(a.getByTestId('office-notice')).toHaveCount(0);
      // Furniture: the teleport into Meeting room A lands below the table; walking up is blocked by it.
      await goTo(a, 'Meeting room A');
      await expect(a.getByTestId('my-status')).toContainText('Meeting room A');
      // The avatar position settles a moment after the room status; wait until it stops changing.
      let last = '';
      await expect.poll(async () => { const p = (await selfPos(a)).join(','); const same = p === last; last = p; return same; }, { intervals: [500] }).toBe(true);
      const [, ty] = await selfPos(a);
      await hold(a, 'KeyW', 1500);
      const [, ty2] = await selfPos(a);
      await hold(a, 'KeyW', 800);
      const [, ty3] = await selfPos(a);
      expect(ty3, 'stopped at the table').toBe(ty2);
      expect(ty - ty2, 'only the gap to the table was walkable').toBeLessThan(64);
      // Occupancy: both in Meeting room B shows 2/8 and both names; B sees A move live.
      await goTo(a, 'Meeting room B');
      await goTo(b, 'Meeting room B');
      const roomB = a.getByRole('list', { name: 'Rooms' }).getByTestId('room-Meeting room B');
      await expect(roomB).toContainText('2/8');
      await expect(roomB).toContainText(USERS.worker.name);
      await expect(roomB).toContainText(USERS.lead.name);
      const aOnB = await find(b, USERS.worker.name);
      await expect(aOnB).toContainText('in Meeting room B');
      await goTo(a, 'Lounge');
      await expect(aOnB).toContainText('in Lounge', { timeout: 15_000 });
      await expect(b.getByRole('list', { name: 'Rooms' }).getByTestId('room-Meeting room B')).toContainText('1/8');
      // Invite-only room refuses an employee.
      await goTo(a, 'HR office');
      await expect(a.getByTestId('office-notice')).toContainText('HR office is invite-only.');
      await expect(a.getByTestId('my-status')).not.toContainText('HR office');
      // Knock: the admin (allowed in) is in the Board room and lets the worker in.
      admin =await (async () => { const ctx = await browser.newContext(); const p = await ctx.newPage(); await signInAdmin(p); return p; })();
      await toOffice(admin);
      await goTo(admin, 'Board room');
      await expect(admin.getByTestId('my-status')).toContainText('Board room');
      await goTo(a, 'Board room');
      await expect(a.getByTestId('office-notice')).toContainText('Board room is knock-to-enter.');
      await a.getByTestId('office-notice').getByRole('button', { name: 'Knock' }).click();
      const knock = admin.getByTestId('knock');
      await expect(knock).toContainText(`${USERS.worker.name} is knocking on Board room.`);
      await knock.getByRole('button', { name: 'Let in' }).click();
      await expect(a.getByTestId('my-status')).toContainText('Board room', { timeout: 15_000 });
      // Full: the admin sets Meeting room C to one person; the worker gets in, the lead is refused.
      const roomC = admin.getByRole('list', { name: 'Rooms' }).getByTestId('room-Meeting room C');
      await roomC.getByRole('button', { name: 'Settings' }).click();
      const form = admin.getByRole('form', { name: 'Settings for Meeting room C' });
      await form.getByLabel('Capacity').fill('1');
      await form.getByRole('button', { name: 'Save room' }).click();
      await expect(roomC).toContainText('/1', { timeout: 10_000 });
      try {
        await goTo(a, 'Meeting room C');
        await expect(a.getByTestId('my-status')).toContainText('Meeting room C');
        await goTo(b, 'Meeting room C');
        await expect(b.getByTestId('office-notice')).toContainText('Meeting room C is full.');
        await expect(b.getByTestId('my-status')).not.toContainText('Meeting room C');
      } finally {
        await form.getByLabel('Capacity').fill('12');
        await form.getByRole('button', { name: 'Save room' }).click();
        await expect(roomC).toContainText('/12', { timeout: 10_000 });
      }
    } finally {
      await close(admin?.context(), b.context(), a.context());
    }
  });

  test('proximity call follows the user to Dashboard, Tasks and My attendance; camera and screen share from the dock; hidden and frozen tab', async ({ browser }) => {
    test.setTimeout(420_000);
    const a = await open(browser, USERS.worker.email, { media: true });
    const b = await open(browser, USERS.lead.email, { media: true });
    let tokens = 0;
    b.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/media/token')) tokens += 1; });
    const dock = b.getByTestId('call-dock');
    const aRemote = a.getByTestId('office-media').getByTestId('tile-remote');
    try {
      await toOffice(a); await turnOn(a);
      await toOffice(b); await turnOn(b);
      await b.getByLabel('Find a colleague').fill('Wendy');
      await b.getByTestId('people-list').getByRole('button', { name: `Go to ${USERS.worker.name}` }).click();
      await expect(b.getByTestId('proximity')).toContainText(USERS.worker.name);
      await expect(b.getByTestId('call-view')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
      await expect(aRemote).toHaveAttribute('data-identity', USERS.lead.id, { timeout: 30_000 });
      await expect.poll(() => hearsAudio(a), { timeout: 20_000 }).toBe(true);
      const tokensInCall = tokens;
      const bOnA = await find(a, USERS.lead.name);

      for (const [link, url] of [['Dashboard', /\/dashboard$/], ['Tasks', /\/tasks$/], ['My attendance', /\/attendance$/]] as const) {
        await nav(b, link);
        await expect(b).toHaveURL(url);
        await expect(dock).toBeVisible();
        await expect(dock).toHaveAttribute('data-status', 'connected');
        await expect(dock.getByTestId('dock-status')).toContainText('2 in call');
        await expect(bOnA).toContainText('away from the office view');
        await expect.poll(() => hearsAudio(a), { timeout: 20_000 }).toBe(true);
        note('proximity', `${link}: dock connected, 2 in call, audio reaches the colleague`);
        if (link === 'Tasks') {
          // Camera on and off from the dock: frames reach A, then stop.
          await dock.getByRole('button', { name: 'Camera', exact: true }).click();
          await expect(dock).toHaveAttribute('data-cam', 'on', { timeout: 20_000 });
          await aRemote.scrollIntoViewIfNeeded();
          await expect.poll(() => paintedFrames(aRemote.locator('video')), { timeout: 20_000 }).toBeGreaterThan(0);
          await dock.getByRole('button', { name: 'Camera', exact: true }).click();
          await expect(dock).toHaveAttribute('data-cam', 'off');
          // Screen share from the dock: A gets the shared screen; stop from the dock removes it.
          await dock.getByRole('button', { name: 'Share screen', exact: true }).click();
          await expect(dock.getByRole('button', { name: 'Stop sharing', exact: true })).toBeVisible({ timeout: 20_000 });
          await expect(a.getByTestId('screen-share')).toBeVisible({ timeout: 20_000 });
          await dock.getByRole('button', { name: 'Stop sharing', exact: true }).click();
          await expect(a.getByTestId('screen-share')).toHaveCount(0, { timeout: 20_000 });
        }
      }
      expect(tokens, 'no new media token while browsing').toBe(tokensInCall);

      // Hidden tab (the page says it is in the background) for 20 s: nothing ends.
      await b.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await b.waitForTimeout(20_000);
      await b.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect(dock).toHaveAttribute('data-status', 'connected');
      await expect.poll(() => hearsAudio(a), { timeout: 20_000 }).toBe(true);
      note('visibility', 'hidden 20 s on My attendance: call kept, audio flows');

      // Return to office, then freeze the colleague's tab for 70 s (as Chrome does with background tabs):
      // its office socket is dropped by the server; after the thaw it must move and talk again.
      await dock.getByRole('button', { name: 'Return to office', exact: true }).click();
      await expect(b).toHaveURL(/\/office$/);
      await expect(b.getByTestId('call-view')).toHaveAttribute('data-status', 'connected');
      expect(tokens, 'Return to office reuses the session').toBe(tokensInCall);
      const cdp = await a.context().newCDPSession(a);
      let froze = true;
      try { await cdp.send('Page.setWebLifecycleState', { state: 'frozen' }); } catch (e) { froze = false; note('freeze', `not supported: ${String(e)}`); }
      if (froze) {
        await b.waitForTimeout(70_000);
        await cdp.send('Page.setWebLifecycleState', { state: 'active' });
        await expect(a.getByTestId('office-canvas')).toHaveAttribute('data-connected', 'true', { timeout: 45_000 });
        await expect(a.getByText('Connecting to the office…')).toHaveCount(0, { timeout: 30_000 });
        const [x0] = await selfPos(a);
        await hold(a, 'KeyD', 800);
        const [x1] = await selfPos(a);
        expect(x1, 'moves after the thaw').not.toBe(x0);
        await goTo(a, 'Lounge');
        const aOnB = await find(b, USERS.worker.name);
        await expect(aOnB).toContainText('in Lounge', { timeout: 15_000 });
        note('freeze', 'frozen 70 s: office reconnected, avatar moves, server sees the room change');
      }
      await cdp.detach();
    } finally {
      await close(b.context(), a.context());
    }
  });

  test('on another page: network drop, token expiry, then reload; meeting_seconds matches the call time', async ({ browser }) => {
    test.setTimeout(480_000);
    const a = await open(browser, USERS.worker.email, { media: true });
    const b = await open(browser, USERS.lead.email, { media: true });
    const dock = b.getByTestId('call-dock');
    const pool = adminPool();
    try {
      await toOffice(a); await turnOn(a);
      await toOffice(b); await turnOn(b);
      await goTo(a, 'Meeting room B');
      await goTo(b, 'Meeting room B');
      await expect(b.getByTestId('call-view')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
      await expect(b.getByTestId('tracking-badge')).toContainText('In meeting', { timeout: 45_000 });
      const callStart = new Date();
      await nav(b, 'Tasks');
      await expect(dock).toHaveAttribute('data-status', 'connected');

      // Network drop of 6 s on /tasks.
      await b.context().setOffline(true);
      await b.waitForTimeout(6000);
      await b.context().setOffline(false);
      await expect(dock).toHaveAttribute('data-status', 'connected', { timeout: 60_000 });
      await expect.poll(() => hearsAudio(a), { timeout: 30_000 }).toBe(true);
      const bOnA = await find(a, USERS.lead.name);
      await expect(bOnA).toContainText('in Meeting room B · away from the office view');
      note('network', 'offline 6 s on /tasks: dock reconnected, audio flows, presence kept');

      // Idle on /tasks past the two-minute access token.
      await b.waitForTimeout(130_000);
      await expect(dock).toHaveAttribute('data-status', 'connected');
      await expect.poll(() => hearsAudio(a), { timeout: 20_000 }).toBe(true);
      await expect(b.getByTestId('tracking-badge')).toContainText('In meeting');
      note('expiry', 'idle 130 s on /tasks (token 120 s): dock connected, audio flows, still In meeting');

      // Leave from the dock; the IN_MEETING time credited must match the call (heartbeat granularity).
      await dock.getByRole('button', { name: 'Leave', exact: true }).click();
      const callEnd = new Date();
      await expect(dock).toHaveCount(0);
      await expect(b.getByTestId('tracking-badge')).toContainText('Active', { timeout: 45_000 });
      const wall = (callEnd.getTime() - callStart.getTime()) / 1000;
      await expect.poll(async () => {
        const r = await pool.query<{ s: number }>(`SELECT coalesce(sum(g.duration_seconds), 0)::int AS s FROM attendance_segments g JOIN attendance_sessions s ON s.id = g.session_id
          WHERE s.org_id = $1 AND s.user_id = $2 AND g.state = 'IN_MEETING' AND g.ended_at IS NOT NULL AND g.ended_at > $3`, [ORG_ID, USERS.lead.id, callStart]);
        return r.rows[0]!.s;
      }, { timeout: 60_000 }).toBeGreaterThan(wall - 45);
      const seg = await pool.query<{ s: number; n: number }>(`SELECT coalesce(sum(g.duration_seconds), 0)::int AS s, count(*)::int AS n FROM attendance_segments g JOIN attendance_sessions s ON s.id = g.session_id
        WHERE s.org_id = $1 AND s.user_id = $2 AND g.state = 'IN_MEETING' AND g.ended_at > $3`, [ORG_ID, USERS.lead.id, callStart]);
      const credited = seg.rows[0]!.s;
      note('meeting_seconds', `call ${Math.round(wall)} s on the wall clock; IN_MEETING segments credited ${credited} s in ${seg.rows[0]!.n} segment(s)`);
      expect(credited).toBeLessThanOrEqual(wall + 5);
      const sess = await pool.query<{ m: number; n: number; a: number; i: number; b: number }>(`SELECT meeting_seconds AS m, net_seconds AS n, active_seconds AS a, idle_seconds AS i, break_seconds AS b FROM attendance_sessions
        WHERE org_id = $1 AND user_id = $2 ORDER BY clock_in_at DESC LIMIT 1`, [ORG_ID, USERS.lead.id]);
      const s = sess.rows[0]!;
      const segTotal = await pool.query<{ m: number }>(`SELECT coalesce(sum(g.duration_seconds), 0)::int AS m FROM attendance_segments g JOIN attendance_sessions s ON s.id = g.session_id
        WHERE s.org_id = $1 AND s.user_id = $2 AND g.state = 'IN_MEETING' AND s.id = (SELECT id FROM attendance_sessions WHERE org_id = $1 AND user_id = $2 ORDER BY clock_in_at DESC LIMIT 1)`, [ORG_ID, USERS.lead.id]);
      note('meeting_seconds', `session meeting_seconds=${s.m}, sum of its IN_MEETING segments=${segTotal.rows[0]!.m}`);
      expect(s.m, 'session meeting_seconds equals its IN_MEETING segments').toBe(segTotal.rows[0]!.m);

      // Reload on another page while in a call: what happens (recorded, ADR 048 creates the office client on /office).
      await nav(b, 'Office');
      await expect(b.getByTestId('call-view')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 }).catch(async () => { await turnOn(b); });
      await expect(b.getByTestId('call-view')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
      await nav(b, 'Tasks');
      await expect(dock).toHaveAttribute('data-status', 'connected');
      await b.reload();
      await expect(b.getByTestId('tracking-badge')).toBeVisible();
      await b.waitForTimeout(12_000); // past the 8 s leave grace
      const dockAfter = await dock.count();
      const bRow = await find(a, USERS.lead.name);
      const rowText = await bRow.innerText();
      note('reload-other-page', `after a reload on /tasks: dock shown=${dockAfter > 0}; colleague sees "${rowText.replace(/\s+/g, ' ').trim()}"`);
      await nav(b, 'Office');
      // ADR 048: a reload releases the media; only /office creates the office client, so after the
      // grace the avatar has left. Opening Office brings it back, in the office again.
      await expect(b.getByTestId('office-canvas')).toHaveAttribute('data-connected', 'true');
      await expect(bRow).not.toContainText('not in the office', { timeout: 15_000 });
      note('reload-other-page', `opening Office after that reload: in the office again, status "${(await b.getByTestId('my-status').innerText()).replace(/\s+/g, ' ')}"`);
    } finally {
      await pool.end();
      await close(b.context(), a.context());
    }
  });

  test('repeated calls do not leak peer connections, tracks or heap; sign-out closes sockets and devices', async ({ browser }) => {
    test.setTimeout(420_000);
    const a = await open(browser, USERS.worker.email, { media: true });
    const b = await open(browser, USERS.lead.email, { media: true });
    try {
      await toOffice(b); await turnOn(b);
      await goTo(b, 'Meeting room C');
      await toOffice(a); await turnOn(a);
      const base = await heapMb(a);
      const rows: string[] = [];
      for (let i = 1; i <= 6; i += 1) {
        await goTo(a, 'Meeting room C');
        await expect(a.getByTestId('call-view')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
        await expect(a.getByTestId('office-media').getByTestId('tile-remote')).toHaveAttribute('data-identity', USERS.lead.id);
        await nav(a, 'Tasks');
        await expect(a.getByTestId('call-dock')).toHaveAttribute('data-status', 'connected');
        await a.getByTestId('call-dock').getByRole('button', { name: 'Leave', exact: true }).click();
        await expect(a.getByTestId('call-dock')).toHaveCount(0);
        await expect.poll(() => localTracks(a), { timeout: 10_000 }).toMatchObject({ live: 0 });
        await nav(a, 'Office');
        await expect(a.getByTestId('office-canvas')).toHaveAttribute('data-connected', 'true');
        await goTo(a, 'Lounge');
        await expect(a.getByTestId('my-status')).toContainText('Lounge');
        await turnOn(a);
        await a.waitForTimeout(1500);
        const pcs = await openPcs(a);
        const ws = await openSockets(a);
        const heap = await heapMb(a);
        rows.push(`cycle ${i}: open peer connections ${pcs}, open sockets ${ws}, heap ${heap} MB`);
        expect(pcs, 'no peer connections left open between calls').toBe(0);
      }
      const end = await heapMb(a);
      note('resources', `heap before ${base} MB, after 6 call cycles ${end} MB; ${rows.join(' | ')}`);
      expect(end - base, 'heap growth over six calls').toBeLessThan(25);
      // Sign-out during a call: devices released, peer connections and sockets closed.
      await goTo(a, 'Meeting room C');
      await expect(a.getByTestId('call-view')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
      await a.evaluate(() => { (window as unknown as { __marker: number }).__marker = 1; });
      await signOut(a);
      const sameDocument = await a.evaluate(() => (window as unknown as { __marker?: number }).__marker === 1);
      await expect.poll(() => localTracks(a).catch(() => ({ total: 0, live: 0 })), { timeout: 10_000 }).toMatchObject({ live: 0 });
      await expect.poll(() => openPcs(a), { timeout: 10_000 }).toBe(0);
      await expect.poll(() => openSockets(a), { timeout: 10_000 }).toBe(0);
      const bOnB = await find(b, USERS.worker.name);
      await expect(bOnB).toContainText('not in the office', { timeout: 20_000 });
      await expect(b.getByTestId('office-media').getByTestId('tile-remote')).toHaveCount(0);
      note('sign-out', `same document after sign-out=${sameDocument}; live tracks 0, open peer connections 0, open sockets 0; colleague sees "not in the office"`);
    } finally {
      await close(b.context(), a.context());
    }
  });

  test('every page for each role: no uncaught errors or console errors', async ({ browser }) => {
    test.setTimeout(420_000);
    const report: string[] = [];
    const bad: string[] = [];
    for (const who of ['worker', 'lead', 'sub', 'admin'] as const) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const errs: string[] = [];
      page.on('pageerror', (e) => errs.push(`pageerror ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') errs.push(`console ${m.text().slice(0, 160)} @ ${page.url().replace(/^https?:\/\/[^/]+/, '')}`); });
      try {
        if (who === 'admin') await signInAdmin(page); else { await signIn(page, USERS[who].email); await passNoticeGate(page); }
        const links = await page.getByRole('navigation', { name: 'Main' }).getByRole('link').evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? ''));
        for (const href of [...new Set(links)].filter((h) => h.startsWith('/'))) {
          await page.getByRole('navigation', { name: 'Main' }).locator(`a[href="${href}"]`).first().click();
          await expect(page).toHaveURL(new RegExp(`${href.replace(/[/]/g, '\\/')}(\\?|$)`));
          await page.waitForLoadState('networkidle').catch(() => undefined);
          await expect(page.getByRole('alert').filter({ hasText: /Something went wrong|Could not load/i })).toHaveCount(0);
        }
        report.push(`${who}: ${links.length} pages`);
      } finally { await ctx.close(); }
      if (errs.length) bad.push(`${who}: ${errs.join(' || ')}`);
    }
    note('console', `${report.join('; ')}; errors: ${bad.length ? bad.join(' ## ') : 'none'}`);
    expect(bad).toEqual([]);
  });

  test('phone size: pages fit the width, the menu works, the dock stays on screen during a call', async ({ browser }) => {
    test.setTimeout(300_000);
    const a = await open(browser, USERS.worker.email, { media: true, mobile: true });
    const b = await open(browser, USERS.lead.email, { media: true });
    try {
      const overflow: string[] = [];
      for (const path of ['/attendance', '/office', '/tasks', '/chat', '/documents', '/attendance/leave', '/timesheets', '/meetings', '/account/profile', '/account/notifications']) {
        await a.goto(path);
        await expect(a.getByTestId('tracking-badge')).toBeVisible();
        await a.waitForLoadState('networkidle').catch(() => undefined);
        const w = await a.evaluate(() => {
          const v = document.documentElement.clientWidth;
          const out: string[] = [];
          for (const el of Array.from(document.querySelectorAll('main *'))) { const b = el.getBoundingClientRect(); if (b.right > v + 1 && b.width > 0 && out.length < 4) out.push(`${Math.round(b.width)}px ${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).slice(0, 60)} "${(el.textContent ?? '').trim().slice(0, 30)}"`); }
          const wide = out.join(' > ');
          return { s: document.documentElement.scrollWidth, v, wide };
        });
        if (w.s > w.v + 1) overflow.push(`${path} ${w.s}px > ${w.v}px (${w.wide})`);
      }
      note('mobile', `horizontal overflow at 390 px: ${overflow.length ? overflow.join(', ') : 'none'}`);
      // Known, from Version 1 (not part of this release): two pages are a little wider than a phone.
      const known = ['/documents', '/timesheets'];
      expect(overflow.filter((o) => !known.includes(o.split(' ')[0]!))).toEqual([]);
      await a.goto('/office');
      await expect(a.getByTestId('office-canvas')).toHaveAttribute('data-connected', 'true');
      await turnOn(a);
      await toOffice(b); await turnOn(b);
      await goTo(b, 'Meeting room A');
      await goTo(a, 'Meeting room A');
      await expect(a.getByTestId('call-view')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
      await a.getByRole('button', { name: 'Toggle navigation' }).click();
      await nav(a, 'Tasks');
      await expect(a).toHaveURL(/\/tasks$/);
      const dock = a.getByTestId('call-dock');
      await expect(dock).toHaveAttribute('data-status', 'connected');
      const box = (await dock.boundingBox())!;
      const page = await a.evaluate(() => ({ s: document.documentElement.scrollWidth, v: document.documentElement.clientWidth }));
      expect(page.s, 'the header with the office badge fits the phone during a call').toBeLessThanOrEqual(page.v + 1);
      note('mobile', `dock at ${Math.round(box.x)},${Math.round(box.y)} size ${Math.round(box.width)}x${Math.round(box.height)} in 390x844`);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
      await dock.getByRole('button', { name: 'Mute', exact: true }).tap();
      await expect(dock).toHaveAttribute('data-mic', 'off');
      await expect(b.getByTestId('office-media').getByTestId('tile-remote').getByLabel('Muted')).toBeVisible();
      await dock.getByRole('button', { name: 'Return to office', exact: true }).tap();
      await expect(a).toHaveURL(/\/office$/);
      await expect(a.getByTestId('call-view')).toHaveAttribute('data-status', 'connected');
    } finally {
      await close(b.context(), a.context());
    }
  });
});
