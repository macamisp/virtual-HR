import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

/**
 * Avatar actions (ADR 056) between two real people in the office: jump (Space), wave and dance
 * from the Actions menu with Stop, a high five declined and a hug accepted (nothing plays before
 * the yes), a cancelled request, sitting at a desk with E and standing up by walking, reduced
 * motion, a dropped connection, and the phone layout. Remote effects are checked on the other
 * person's screen. AVATAR_SHOTS_DIR=<dir> also writes screenshots.
 */
interface SpriteState { id: string; self: boolean; key: string; pose: string | null; lastPose: string | null; maxLift: number; walking: boolean }
const canvasOf = (p: Page) => p.getByTestId('office-canvas');
async function sprites(p: Page): Promise<SpriteState[]> {
  const v = await canvasOf(p).getAttribute('data-avatar-sprites');
  return v ? (JSON.parse(v) as SpriteState[]) : [];
}
const mine = async (p: Page) => (await sprites(p)).find((s) => s.self);
const of = async (p: Page, id: string) => (await sprites(p)).find((s) => s.id === id);
const self = async (p: Page) => (await canvasOf(p).getAttribute('data-self')) ?? '';
const menuItem = (p: Page, name: RegExp | string) => p.getByTestId('action-menu').getByRole('menuitem', { name });
async function openMenu(p: Page): Promise<void> {
  await p.getByTestId('actions-button').click();
  await expect(p.getByTestId('action-menu')).toBeVisible();
}
const shotsDir = process.env.AVATAR_SHOTS_DIR;
async function shot(p: Page, name: string): Promise<void> {
  const path = shotsDir ? join(shotsDir, `${name}.png`) : test.info().outputPath(`${name}.png`);
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  await canvasOf(p).screenshot({ path });
}

async function office(browser: Browser, email: string, opts: BrowserContextOptions = {}) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page, email);
  await passNoticeGate(page);
  await page.goto('/office');
  await expect(canvasOf(page).locator('canvas')).toBeVisible();
  await expect(canvasOf(page)).toHaveAttribute('data-connected', 'true');
  return { page, errors, ctx };
}

/** `p` walks up to the colleague called `name` (teleport next to them). */
async function goNextTo(p: Page, name: string): Promise<void> {
  await p.getByLabel('Find a colleague').fill(name.split(' ')[0]!);
  await p.getByTestId('people-list').getByRole('button', { name: `Go to ${name}` }).click();
  await expect(p.getByTestId('proximity')).toContainText(name);
  await p.evaluate(() => window.scrollTo(0, 0));
}

test.describe.serial('Office avatar actions (ADR 056)', () => {
  test('two people: jump, wave, dance and stop; high five declined; hug accepted; a request cancelled', async ({ browser }) => {
    test.setTimeout(180_000);
    const w = await office(browser, USERS.worker.email);
    const l = await office(browser, USERS.lead.email);
    const worker = w.page;
    const lead = l.page;
    await goNextTo(worker, USERS.lead.name);
    await expect.poll(async () => !!(await of(lead, USERS.worker.id))).toBe(true);
    for (let i = 0; i < 3; i += 1) { await worker.getByRole('button', { name: 'Zoom in' }).click(); await lead.getByRole('button', { name: 'Zoom in' }).click(); }

    // Jump (Space): mine and, on the other screen, theirs; cosmetic: the position does not change.
    const before = await self(worker);
    await canvasOf(worker).focus();
    await worker.keyboard.press('Space');
    await expect.poll(async () => (await mine(worker))?.lastPose).toMatch(/^jump-/);
    await expect.poll(async () => (await of(lead, USERS.worker.id))?.lastPose).toMatch(/^jump-/);
    await expect.poll(async () => (await mine(worker))!.maxLift, { message: 'it rises' }).toBeGreaterThan(4);
    await worker.waitForTimeout(800);
    expect(await self(worker), 'a jump never moves the avatar').toBe(before);

    // Wave from the menu.
    await openMenu(worker);
    await menuItem(worker, 'Wave').click();
    await expect.poll(async () => (await of(lead, USERS.worker.id))?.lastPose).toMatch(/^wave-/);
    await worker.waitForTimeout(300);
    await shot(lead, 'actions-01-wave-seen-by-colleague');

    // Dance with an accessible Stop.
    await openMenu(worker);
    await menuItem(worker, 'Dance').click();
    await expect.poll(async () => (await of(lead, USERS.worker.id))?.pose).toMatch(/^dance-/);
    await shot(worker, 'actions-02-dance');
    await worker.getByTestId('stop-dancing').click();
    await expect.poll(async () => (await of(lead, USERS.worker.id))?.pose ?? null).toBeNull();

    // High five: asked, declined; nothing plays.
    await openMenu(worker);
    await menuItem(worker, /High five/).click();
    await menuItem(worker, USERS.lead.name).click();
    await expect(worker.getByTestId('pair-waiting')).toContainText(`Waiting for ${USERS.lead.name}`);
    await expect(lead.getByTestId('pair-request')).toContainText(`${USERS.worker.name} would like a high five`);
    await lead.getByTestId('pair-request').getByRole('button', { name: 'Decline' }).click();
    await expect(worker.getByTestId('office-notice')).toContainText('said no');
    expect((await of(lead, USERS.worker.id))?.lastPose ?? '').not.toMatch(/^highfive-/);
    await worker.getByTestId('office-notice').getByRole('button', { name: 'Dismiss' }).click();

    // A request can be cancelled; it disappears on the other screen.
    await worker.waitForTimeout(3_100); // the per-person request cooldown
    await openMenu(worker);
    await menuItem(worker, /Friendly hug/).click();
    await menuItem(worker, USERS.lead.name).click();
    await expect(lead.getByTestId('pair-request')).toBeVisible();
    await worker.getByTestId('pair-waiting').getByRole('button', { name: 'Cancel' }).click();
    await expect(lead.getByTestId('pair-request')).toHaveCount(0);

    // Hug: asked, accepted; both play it, facing each other.
    await worker.waitForTimeout(3_100);
    await openMenu(worker);
    await menuItem(worker, /Friendly hug/).click();
    await menuItem(worker, USERS.lead.name).click();
    await lead.getByTestId('pair-request').getByRole('button', { name: 'Accept' }).click();
    await expect.poll(async () => (await of(lead, USERS.worker.id))?.pose).toMatch(/^hug-/);
    await expect.poll(async () => (await mine(lead))?.pose).toMatch(/^hug-/);
    // The asker sees it too, on their own screen (a page behind another one does not animate).
    await worker.bringToFront();
    await expect.poll(async () => (await mine(worker))?.lastPose, { message: 'the asker sees it too' }).toMatch(/^hug-/);
    await expect.poll(async () => (await of(worker, USERS.lead.id))?.lastPose).toMatch(/^hug-/);
    await shot(lead, 'actions-03-hug');
    const a = (await of(lead, USERS.worker.id))!.pose!;
    const b = (await mine(lead))!.pose!;
    expect(a, 'they face each other').not.toBe(b);
    expect(w.errors).toEqual([]);
    expect(l.errors).toEqual([]);
    await w.ctx.close();
    await l.ctx.close();
  });

  test('sit at a desk with E, seen by a colleague; walking stands up; an occupied chair cannot be taken', async ({ browser }) => {
    const w = await office(browser, USERS.worker.email);
    const l = await office(browser, USERS.lead.email);
    const worker = w.page;
    const lead = l.page;
    // The worker claims a desk and goes there (the desk teleport ends on its chair's spot).
    const release = worker.getByRole('button', { name: 'Release desk' });
    if (await release.count()) await release.click();
    await worker.getByLabel('Claim a free desk').selectOption({ label: 'Desk B2' });
    await worker.getByRole('button', { name: 'Claim', exact: true }).click();
    await worker.getByRole('button', { name: /Go to my desk/ }).click();
    await worker.waitForTimeout(500);
    await canvasOf(worker).focus();
    await worker.keyboard.press('KeyE');
    await expect.poll(async () => (await mine(worker))?.pose).toBe('sit-up');
    // The lead comes over and sees the worker sitting, and cannot sit on the same chair.
    await goNextTo(lead, USERS.worker.name);
    await expect.poll(async () => (await of(lead, USERS.worker.id))?.pose).toBe('sit-up');
    await lead.getByTestId('actions-button').click();
    await expect(lead.getByTestId('action-menu').getByRole('menuitem', { name: /Sit down/ })).toBeVisible();
    await lead.keyboard.press('Escape');
    for (let i = 0; i < 3; i += 1) await lead.getByRole('button', { name: 'Zoom in' }).click();
    await shot(lead, 'actions-04-sitting-at-desk');
    // Walking stands the worker up.
    await canvasOf(worker).focus();
    await worker.keyboard.down('KeyS');
    await worker.waitForTimeout(400);
    await worker.keyboard.up('KeyS');
    await expect.poll(async () => (await of(lead, USERS.worker.id))?.pose ?? null).toBeNull();
    await worker.getByRole('button', { name: 'Release desk' }).click();
    expect(w.errors).toEqual([]);
    await w.ctx.close();
    await l.ctx.close();
  });

  test('reduced motion: actions still show, without the jump or the sway', async ({ browser }) => {
    const w = await office(browser, USERS.worker.email, { reducedMotion: 'reduce' });
    await canvasOf(w.page).focus();
    await w.page.keyboard.press('Space');
    await expect.poll(async () => (await mine(w.page))?.lastPose).toBe('jump-air');
    await w.page.waitForTimeout(700);
    expect((await mine(w.page))!.maxLift, 'no vertical motion').toBe(0);
    await w.ctx.close();
  });

  test('a dropped connection ends the action for everyone at once', async ({ browser }) => {
    const w = await office(browser, USERS.worker.email);
    const l = await office(browser, USERS.lead.email);
    await goNextTo(w.page, USERS.lead.name);
    await openMenu(w.page);
    await menuItem(w.page, 'Dance').click();
    await expect.poll(async () => (await of(l.page, USERS.worker.id))?.pose).toMatch(/^dance-/);
    await w.ctx.close(); // the socket drops (no leave message)
    await expect.poll(async () => (await of(l.page, USERS.worker.id))?.pose ?? null, { timeout: 5_000 }).toBeNull();
    await l.ctx.close();
  });

  test('phone: the Actions button and menu work by touch and fit the screen', async ({ browser }) => {
    const m = await office(browser, USERS.sub.email, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const p = m.page;
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.getByTestId('actions-button').tap();
    const menu = p.getByTestId('action-menu');
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await menu.getByRole('menuitem', { name: 'Wave' }).tap();
    await expect.poll(async () => (await mine(p))?.lastPose).toMatch(/^wave-/);
    expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await shot(p, 'actions-05-phone-wave');
    expect(m.errors).toEqual([]);
    await m.ctx.close();
  });
});
