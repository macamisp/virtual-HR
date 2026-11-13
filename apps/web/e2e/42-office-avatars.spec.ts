import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { adminPool, USERS } from './fixtures';
import { passNoticeGate, signIn, signOut } from './helpers';

/**
 * Pixel-art office avatars (FR-VO-002, ADR 053), in the real app: the own and remote characters
 * on the PixiJS map, walking / idle / facing inferred from movement, the status ring and away
 * badge around the sprite, the accessible avatar menu, choosing and saving a character (preview
 * first, then saved, synchronised to a colleague, kept after a refresh and a new sign-in), a
 * failed save, the renderer surviving repeated office visits, a phone viewport, and many avatars.
 *
 * The canvas is read through `data-avatar-sprites` (the renderer's avatar state, refreshed every
 * 500 ms). AVATAR_SHOTS_DIR=<dir> also writes screenshots of the rendered office there.
 */
interface SpriteState { id: string; self: boolean; key: string; facing: string; frame: number; walking: boolean; status: string | null; away: boolean }

const canvasOf = (p: Page) => p.getByTestId('office-canvas');
async function sprites(p: Page): Promise<SpriteState[]> {
  const v = await canvasOf(p).getAttribute('data-avatar-sprites');
  return v ? (JSON.parse(v) as SpriteState[]) : [];
}
const mine = async (p: Page) => (await sprites(p)).find((s) => s.self);
const spriteOf = async (p: Page, id: string) => (await sprites(p)).find((s) => s.id === id);
const nav = (p: Page, link: string) => p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: link, exact: true }).click();

const shotsDir = process.env.AVATAR_SHOTS_DIR;
async function shot(p: Page, name: string, full = false): Promise<void> {
  const path = shotsDir ? join(shotsDir, `${name}.png`) : test.info().outputPath(`${name}.png`);
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  if (full) await p.screenshot({ path, fullPage: false });
  else await canvasOf(p).screenshot({ path });
  await test.info().attach(name, { path, contentType: 'image/png' });
}

async function openOffice(browser: Browser, email: string, viewport?: { width: number; height: number }): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const ctx = await browser.newContext(viewport ? { viewport, deviceScaleFactor: 2, hasTouch: true, isMobile: true } : {});
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page, email);
  await passNoticeGate(page);
  await page.goto('/office');
  await expect(canvasOf(page).locator('canvas')).toBeVisible();
  await expect(canvasOf(page)).toHaveAttribute('data-connected', 'true');
  return { page, errors, close: () => ctx.close() };
}

test.describe.serial('Office pixel avatars (ADR 053)', () => {
  test.beforeAll(async () => {
    const pool = adminPool();
    try { await pool.query(`UPDATE users SET vo_avatar_key = 'sage' WHERE id = ANY($1::uuid[])`, [[USERS.worker.id, USERS.lead.id, USERS.sub.id]]); } finally { await pool.end(); }
  });

  test('characters walk, face, stop and sync; a saved choice reaches a colleague and survives refresh and sign-in', async ({ browser }) => {
    test.setTimeout(180_000);
    const w = await openOffice(browser, USERS.worker.email);
    const l = await openOffice(browser, USERS.lead.email);
    const worker = w.page;
    const lead = l.page;

    // Local avatar: the default character, standing, with the status ring.
    await expect.poll(async () => (await mine(worker))?.key).toBe('sage');
    expect(await mine(worker)).toMatchObject({ walking: false, frame: 0, status: 'ACTIVE', away: false });

    // Remote avatar: go next to the colleague; each sees the other's character.
    await worker.getByLabel('Find a colleague').fill('Leo');
    await worker.getByTestId('people-list').getByRole('button', { name: `Go to ${USERS.lead.name}` }).click();
    await expect(worker.getByTestId('proximity')).toContainText(USERS.lead.name);
    await expect.poll(async () => (await spriteOf(worker, USERS.lead.id))?.key).toBe('sage');
    await expect.poll(async () => (await spriteOf(lead, USERS.worker.id))?.key).toBe('sage');
    for (let i = 0; i < 3; i += 1) await worker.getByRole('button', { name: 'Zoom in' }).click();
    await worker.waitForTimeout(600);
    await shot(worker, '01-default-characters');

    // Walking right: walking frames, facing right; the colleague sees the same walk. Then standing at once.
    await canvasOf(worker).focus();
    await worker.keyboard.down('KeyD');
    await expect.poll(async () => { const s = await mine(worker); return s && s.walking && s.facing === 'right' && (s.frame === 1 || s.frame === 2); }, { timeout: 3000, intervals: [100] }).toBe(true);
    await expect.poll(async () => { const s = await spriteOf(lead, USERS.worker.id); return s?.walking && s.facing === 'right'; }, { timeout: 3000, intervals: [100] }).toBe(true);
    await worker.keyboard.up('KeyD');
    await expect.poll(async () => { const s = await mine(worker); return s && !s.walking && s.frame === 0 && s.facing === 'right'; }, { timeout: 2000, intervals: [100] }).toBe(true);
    await expect.poll(async () => { const s = await spriteOf(lead, USERS.worker.id); return s && !s.walking && s.frame === 0; }, { timeout: 3000, intervals: [100] }).toBe(true);

    // Walking down: the facing changes on both screens.
    await worker.keyboard.down('KeyS');
    await expect.poll(async () => (await mine(worker))?.facing, { timeout: 3000, intervals: [100] }).toBe('down');
    await expect.poll(async () => (await spriteOf(lead, USERS.worker.id))?.facing, { timeout: 3000, intervals: [100] }).toBe('down');
    await worker.keyboard.up('KeyS');

    // Blocked: keep pushing up until a wall or a closed room stops the avatar; it stands, facing up.
    await worker.keyboard.down('KeyW');
    await worker.waitForTimeout(5000);
    const p1 = await canvasOf(worker).getAttribute('data-self');
    await worker.waitForTimeout(700);
    const p2 = await canvasOf(worker).getAttribute('data-self');
    expect(p2, 'the avatar is blocked').toBe(p1);
    expect(await mine(worker)).toMatchObject({ walking: false, frame: 0, facing: 'up' });
    await worker.keyboard.up('KeyW');

    // Back next to the colleague for the rest.
    await worker.getByTestId('people-list').getByRole('button', { name: `Go to ${USERS.lead.name}` }).click();
    await expect.poll(async () => !!(await spriteOf(worker, USERS.lead.id))).toBe(true);

    // Avatar actions stay accessible over the sprite: keyboard opens and closes the menu.
    const trigger = worker.getByRole('button', { name: `Avatar actions for ${USERS.lead.name}` });
    await expect(trigger).toBeVisible();
    await trigger.focus();
    await worker.keyboard.press('Enter');
    const menu = worker.getByRole('menu', { name: `Actions for ${USERS.lead.name}` });
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await expect(menu.getByRole('menuitem', { name: `Go to ${USERS.lead.name}` })).toBeVisible();
    await worker.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // Status ring and away badge follow presence: the colleague leaves the office view, then returns.
    await nav(lead, 'Tasks');
    await expect.poll(async () => (await spriteOf(worker, USERS.lead.id))?.away, { timeout: 15_000 }).toBe(true);
    await shot(worker, '02-colleague-away');
    await nav(lead, 'Office');
    await expect(canvasOf(lead).locator('canvas')).toBeVisible();
    await expect.poll(async () => (await spriteOf(worker, USERS.lead.id))?.away, { timeout: 15_000 }).toBe(false);
    await worker.getByLabel('Status', { exact: true }).selectOption('DND');
    await worker.getByRole('button', { name: 'Set', exact: true }).click();
    await expect.poll(async () => (await mine(worker))?.status).toBe('DND');
    await expect.poll(async () => (await spriteOf(lead, USERS.worker.id))?.status).toBe('DND');
    await worker.getByLabel('Status', { exact: true }).selectOption('AUTO');
    await worker.getByRole('button', { name: 'Set', exact: true }).click();
    await expect.poll(async () => (await mine(worker))?.status).toBe('ACTIVE');

    // Choosing previews only: the map keeps the saved character until it is saved.
    const settings = worker.getByTestId('avatar-settings');
    await expect(settings.getByTestId('avatar-option-sage')).toContainText('(current)');
    await settings.getByTestId('avatar-option-ember').click();
    await expect(settings.getByRole('radio', { name: /Ember/ })).toBeChecked();
    await expect(settings.getByTestId('avatar-preview')).toHaveAttribute('data-avatar', 'ember');
    await expect(settings).toContainText('Preview only, not saved yet.');
    await worker.waitForTimeout(1200);
    expect((await mine(worker))?.key, 'an unsaved preview does not change the map').toBe('sage');
    await shot(worker, '03-picker-preview', true);

    // Save: success message, the own map, and the colleague's map.
    await settings.getByRole('button', { name: 'Save character' }).click();
    await expect(settings.getByRole('status')).toContainText('Character saved');
    await expect.poll(async () => (await mine(worker))?.key).toBe('ember');
    await expect.poll(async () => (await spriteOf(lead, USERS.worker.id))?.key, { timeout: 5000 }).toBe('ember');
    await worker.waitForTimeout(600);
    await shot(worker, '04-saved-ember-own-view');
    for (let i = 0; i < 3; i += 1) await lead.getByRole('button', { name: 'Zoom in' }).click();
    await lead.waitForTimeout(600);
    await shot(lead, '05-colleague-sees-ember');

    // A failed save keeps the saved character and says so.
    await worker.route('**/office/me/avatar', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusCode: 500, message: 'Simulated failure' }) }));
    await settings.getByTestId('avatar-option-river').click();
    await settings.getByRole('button', { name: 'Save character' }).click();
    await expect(settings.getByRole('alert')).toContainText('Could not save your character');
    await worker.unroute('**/office/me/avatar');
    await worker.waitForTimeout(700);
    expect((await mine(worker))?.key).toBe('ember');

    // Refresh, then a new sign-in: the saved character comes back.
    await worker.reload();
    await expect(canvasOf(worker).locator('canvas')).toBeVisible();
    await expect.poll(async () => (await mine(worker))?.key).toBe('ember');
    await expect(worker.getByTestId('avatar-option-ember')).toContainText('(current)');
    await signOut(worker);
    await signIn(worker, USERS.worker.email);
    await passNoticeGate(worker);
    await worker.goto('/office');
    await expect(canvasOf(worker).locator('canvas')).toBeVisible();
    await expect.poll(async () => (await mine(worker))?.key).toBe('ember');

    expect(w.errors, 'no uncaught errors (worker)').toEqual([]);
    expect(l.errors, 'no uncaught errors (lead)').toEqual([]);
    await w.close();
    await l.close();
  });

  test('leaving and re-entering the office cleans up: one canvas, one sprite per person, no errors', async ({ browser }) => {
    const w = await openOffice(browser, USERS.worker.email);
    for (let i = 0; i < 4; i += 1) {
      await nav(w.page, 'Tasks');
      await expect(canvasOf(w.page)).toHaveCount(0);
      await nav(w.page, 'Office');
      await expect(canvasOf(w.page).locator('canvas')).toHaveCount(1);
      await expect.poll(async () => (await sprites(w.page)).filter((s) => s.self).length).toBe(1);
    }
    const ids = (await sprites(w.page)).map((s) => s.id);
    expect(new Set(ids).size, 'no duplicate sprites').toBe(ids.length);
    // The only canvases: the map, and the picker's seven previews.
    expect(await w.page.evaluate(() => [...document.querySelectorAll('canvas')].filter((c) => !c.closest('[data-testid="avatar-settings"]')).length), 'no leftover map canvases from earlier visits').toBe(1);
    expect(await w.page.getByTestId('avatar-settings').locator('canvas').count()).toBe(7);
    expect(w.errors).toEqual([]);
    await w.close();
  });

  test('phone viewport: the character renders and the picker fits without sideways scrolling', async ({ browser }) => {
    const m = await openOffice(browser, USERS.sub.email, { width: 390, height: 844 });
    await expect.poll(async () => (await mine(m.page))?.key).toBe('sage');
    const settings = m.page.getByTestId('avatar-settings');
    await settings.scrollIntoViewIfNeeded();
    await expect(settings.getByRole('radio')).toHaveCount(6);
    expect(await m.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await m.page.evaluate(() => window.scrollTo(0, 0));
    await shot(m.page, '06-phone-office', true);
    await settings.scrollIntoViewIfNeeded();
    await shot(m.page, '07-phone-picker', true);
    expect(m.errors).toEqual([]);
    await m.close();
  });

  test('many avatars: every preset at once, animated from the shared sheet; the frame rate is reported', async ({ browser }) => {
    const b = await openOffice(browser, USERS.worker.email);
    await b.page.goto('/office?bench=40');
    await expect(canvasOf(b.page)).toHaveAttribute('data-avatars', '41', { timeout: 20_000 });
    await expect.poll(async () => new Set((await sprites(b.page)).map((s) => s.key)).size, { timeout: 10_000 }).toBe(6);
    await expect.poll(async () => (await sprites(b.page)).some((s) => !s.self && s.walking), { timeout: 10_000 }).toBe(true);
    await b.page.waitForTimeout(3000);
    const fps = Number(await canvasOf(b.page).getAttribute('data-fps'));
    const frameMs = Number(await canvasOf(b.page).getAttribute('data-frame-ms'));
    test.info().annotations.push({ type: 'bench', description: `40 avatars: ${fps} fps, ${frameMs} ms of script per frame` });
    console.log(JSON.stringify({ avatarBench: true, avatars: 41, fps, frameMs }));
    expect(fps).toBeGreaterThan(0);
    for (let i = 0; i < 3; i += 1) await b.page.getByRole('button', { name: 'Zoom out' }).click();
    await b.page.waitForTimeout(600);
    await shot(b.page, '08-forty-avatars');
    expect(b.errors).toEqual([]);
    await b.close();
  });
});
