import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

/**
 * Avatar nudge (ADR 058, FR-VO-016) between two real people in two browsers: the bell on a nearby
 * colleague's avatar (hover, keyboard, touch), the notification with Accept and Ignore, the chime
 * once the page may make sound, and the same outcome on both screens for accepted, ignored,
 * cancelled, expired and left. Cooldown, Do not disturb, distance, the phone layout and reduced
 * motion. The API suite (office-nudge-e2e) covers the server rules and organisation isolation.
 * The e2e API runs with an 8 s cooldown and a 6 s expiry (playwright.config.ts).
 * NUDGE_SHOTS_DIR=<dir> also writes screenshots.
 */
const COOLDOWN_MS = 8_000;
const canvasOf = (p: Page) => p.getByTestId('office-canvas');
const notices = (p: Page) => p.getByTestId('nudge-notices');
const bell = (p: Page) => p.getByTestId('nudge-bell');
const result = (p: Page) => p.getByTestId('nudge-result');
const avatarButton = (p: Page, name: string) => p.getByRole('button', { name: `Avatar actions for ${name}` });
const opacity = (p: Page) => bell(p).evaluate((el) => getComputedStyle(el).opacity);
const shotsDir = process.env.NUDGE_SHOTS_DIR;
async function shot(p: Page, name: string): Promise<void> {
  const path = shotsDir ? join(shotsDir, `${name}.png`) : test.info().outputPath(`${name}.png`);
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  await p.screenshot({ path });
}

async function office(browser: Browser, email: string, opts: BrowserContextOptions = {}) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  // Every nudge this person sends (the office socket frame), for the server's rate rules below.
  page.on('websocket', (ws) => ws.on('framesent', (f) => { if (typeof f.payload === 'string' && f.payload.includes('"office:nudge",')) (sent[email] ??= []).push(Date.now()); }));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
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

async function setStatus(p: Page, value: 'AUTO' | 'DND'): Promise<void> {
  const form = p.getByRole('form', { name: 'My status' });
  await form.getByLabel('Status').selectOption(value);
  await form.getByRole('button', { name: 'Set' }).click();
}

/** Both screens show how the nudge ended, then the cards are cleared for the next step. */
async function ended(sender: Page, recipient: Page, outcome: string, senderText: RegExp, recipientText: RegExp | null): Promise<void> {
  await expect(result(sender)).toHaveAttribute('data-outcome', outcome);
  await expect(result(sender)).toHaveAttribute('data-role', 'sender');
  await expect(result(sender)).toContainText(senderText);
  await expect(sender.getByTestId('nudge-pending')).toHaveCount(0);
  if (recipientText) {
    await expect(result(recipient)).toHaveAttribute('data-outcome', outcome);
    await expect(result(recipient)).toHaveAttribute('data-role', 'recipient');
    await expect(result(recipient)).toContainText(recipientText);
    await expect(recipient.getByTestId('nudge-request')).toHaveCount(0);
    await result(recipient).getByRole('button', { name: 'Dismiss' }).click();
    await expect(result(recipient)).toHaveCount(0);
  }
  await result(sender).getByRole('button', { name: 'Dismiss' }).click();
  await expect(result(sender)).toHaveCount(0);
}

/**
 * The server's nudge rules outlive a browser (they are per person and per pair): the 8 s pair
 * cooldown (playwright.config) and NUDGES_PER_MINUTE per sender. A later test that starts quickly
 * waits only for what is left of them after the earlier tests' nudges, so it never depends on how
 * long the earlier tests happened to take.
 */
const NUDGES_PER_MINUTE = 6; // packages/shared/src/office/nudge.ts
const sent: Record<string, number[]> = {};
/** `planned`: how many nudges the caller sends within the next minute (they must all fit the per-minute limit). */
async function nudgeAllowed(p: Page, email: string, planned = 1): Promise<void> {
  const times = sent[email] ?? [];
  const now = Date.now();
  const cooldownLeft = times.length ? times[times.length - 1]! + COOLDOWN_MS - now : 0;
  const recent = times.filter((t) => now - t < 60_000);
  const keep = Math.max(0, NUDGES_PER_MINUTE - planned); // sends that may still be in the window
  const windowLeft = recent.length > keep ? recent[recent.length - keep - 1]! + 60_000 - now : 0;
  await p.waitForTimeout(Math.max(0, cooldownLeft, windowLeft) + 250);
}

test.describe.serial('Office avatar nudge (ADR 058)', () => {
  test('two people: bell on hover, chime, Accept, cooldown, keyboard and Ignore, Cancel, expiry, Do not disturb, distance, leaving', async ({ browser }) => {
    test.setTimeout(240_000);
    const w = await office(browser, USERS.worker.email, { viewport: { width: 1440, height: 900 } });
    const l = await office(browser, USERS.lead.email, { viewport: { width: 1440, height: 900 } });
    const worker = w.page;
    const lead = l.page;
    await goNextTo(worker, USERS.lead.name);
    await expect(avatarButton(worker, USERS.lead.name)).toBeVisible();
    await expect(avatarButton(lead, USERS.worker.name)).toBeVisible();

    // Nobody can nudge themselves: there is no bell (and no avatar button) for my own avatar.
    await expect(worker.getByRole('button', { name: `Nudge ${USERS.worker.name}` })).toHaveCount(0);
    await nudgeAllowed(worker, USERS.worker.email, NUDGES_PER_MINUTE); // a clear minute: this test sends several
    // The bell for a nearby colleague is hidden until the pointer is over their avatar.
    await expect(bell(worker)).toHaveCount(1);
    await expect.poll(() => opacity(worker)).toBe('0');
    await avatarButton(worker, USERS.lead.name).hover();
    await expect.poll(() => opacity(worker)).toBe('1');
    await expect(bell(worker)).toHaveAccessibleName(`Nudge ${USERS.lead.name}`);
    await shot(worker, 'nudge-01-bell-on-hover');

    // The lead has not touched the office page since it loaded, so the browser allows no sound yet:
    // the notification still arrives, silently.
    await bell(worker).click();
    await expect(worker.getByTestId('nudge-pending')).toContainText(`Nudge sent to ${USERS.lead.name}`);
    await expect(worker.getByTestId('nudge-marker')).toHaveAttribute('data-state', 'sent');
    await expect(bell(worker)).toHaveCount(0); // one at a time
    const request = lead.getByTestId('nudge-request');
    await expect(request).toContainText(`${USERS.worker.name} nudged you.`);
    await expect(notices(lead)).toHaveAttribute('data-sound', 'blocked');
    await expect(lead.getByTestId('nudge-marker')).toHaveAttribute('data-state', 'received');
    expect(await lead.getByTestId('nudge-bell-icon').evaluate((el) => getComputedStyle(el).animationName)).toBe('bounce');
    await shot(lead, 'nudge-02-request');
    await shot(worker, 'nudge-03-pending');
    await request.getByRole('button', { name: 'Accept' }).click();
    await expect(result(lead)).toBeVisible();
    await shot(lead, 'nudge-04-accepted-recipient');
    await shot(worker, 'nudge-05-accepted-sender');
    await ended(worker, lead, 'accepted', new RegExp(`${USERS.lead.name} accepted your nudge`), new RegExp(`You accepted ${USERS.worker.name}'s nudge`));

    // Cooldown: the same person cannot be nudged again straight away; nothing reaches them.
    await avatarButton(worker, USERS.lead.name).hover();
    await bell(worker).click();
    await expect(worker.getByTestId('office-notice')).toContainText(`You nudged ${USERS.lead.name} a moment ago. Try again in`);
    await expect(worker.getByTestId('nudge-pending')).toHaveCount(0);
    await expect(lead.getByTestId('nudge-request')).toHaveCount(0);
    await shot(worker, 'nudge-06-cooldown');
    await worker.getByTestId('office-notice').getByRole('button', { name: 'Dismiss' }).click();
    await worker.waitForTimeout(COOLDOWN_MS);

    // Keyboard only: the avatar's menu has "Nudge"; the lead answers Ignore from the keyboard too.
    // By now the lead has clicked on the page, so the chime plays.
    await avatarButton(worker, USERS.lead.name).focus();
    await worker.keyboard.press('Shift+F10');
    await expect(worker.getByRole('menu')).toBeVisible();
    const item = worker.getByTestId('nudge-menu-item');
    await expect(item).toHaveAttribute('aria-disabled', 'false');
    await item.focus();
    await worker.keyboard.press('Enter');
    await expect(worker.getByTestId('nudge-pending')).toBeVisible();
    await expect(avatarButton(worker, USERS.lead.name)).toBeFocused();
    await expect(lead.getByTestId('nudge-request')).toBeVisible();
    await expect(notices(lead)).toHaveAttribute('data-sound', 'played');
    await lead.getByTestId('nudge-request').getByRole('button', { name: 'Ignore' }).focus();
    await lead.keyboard.press('Enter');
    await expect(result(worker)).toBeVisible();
    await shot(worker, 'nudge-07-ignored-sender');
    await ended(worker, lead, 'ignored', new RegExp(`${USERS.lead.name} ignored your nudge`), new RegExp(`You ignored ${USERS.worker.name}'s nudge`));
    await worker.waitForTimeout(COOLDOWN_MS);

    // The sender takes it back: both are told.
    await avatarButton(worker, USERS.lead.name).hover();
    await bell(worker).click();
    await expect(lead.getByTestId('nudge-request')).toBeVisible();
    await worker.getByTestId('nudge-pending').getByRole('button', { name: 'Cancel' }).click();
    await ended(worker, lead, 'cancelled', new RegExp(`You cancelled the nudge to ${USERS.lead.name}`), new RegExp(`${USERS.worker.name} cancelled the nudge`));
    await worker.waitForTimeout(COOLDOWN_MS);

    // Nobody answers: it expires for both (6 s in this run).
    await avatarButton(worker, USERS.lead.name).hover();
    await bell(worker).click();
    await expect(lead.getByTestId('nudge-request')).toBeVisible();
    await expect(result(worker)).toHaveAttribute('data-outcome', 'expired', { timeout: 12_000 });
    await shot(worker, 'nudge-08-expired-sender');
    await ended(worker, lead, 'expired', new RegExp(`${USERS.lead.name} did not answer`), new RegExp(`${USERS.worker.name}'s nudge expired`));

    // Do not disturb: no bell is offered and the menu says why (the server refuses one sent anyway: office-nudge-e2e).
    await setStatus(lead, 'DND');
    await expect(bell(worker)).toHaveCount(0);
    await avatarButton(worker, USERS.lead.name).click();
    await expect(worker.getByTestId('nudge-menu-item')).toHaveAttribute('aria-disabled', 'true');
    await expect(worker.getByTestId('nudge-menu-item')).toContainText('do not disturb');
    await worker.getByTestId('nudge-menu-item').click({ force: true }); // disabled: a click does nothing
    await expect(worker.getByTestId('nudge-pending')).toHaveCount(0);
    await shot(worker, 'nudge-09-do-not-disturb');
    await worker.keyboard.press('Escape');
    await expect(lead.getByTestId('nudge-request')).toHaveCount(0);
    await setStatus(lead, 'AUTO');
    await expect(bell(worker)).toHaveCount(1);

    // Too far: after walking away there is no bell; back next to them there is.
    await canvasOf(worker).focus();
    await worker.keyboard.down('KeyD');
    await expect(bell(worker)).toHaveCount(0, { timeout: 10_000 });
    await worker.keyboard.up('KeyD');
    await goNextTo(worker, USERS.lead.name);
    await expect(bell(worker)).toHaveCount(1);

    // The person nudged leaves (closes the browser): the sender is told at once.
    await avatarButton(worker, USERS.lead.name).hover();
    await bell(worker).click();
    await expect(lead.getByTestId('nudge-request')).toBeVisible();
    expect(l.errors).toEqual([]);
    await l.ctx.close();
    await expect(result(worker)).toHaveAttribute('data-outcome', 'gone', { timeout: 10_000 });
    await expect(result(worker)).toContainText(`${USERS.lead.name} has left the office`);
    await expect(worker.getByTestId('nudge-pending')).toHaveCount(0);
    await shot(worker, 'nudge-10-left');
    expect(w.errors).toEqual([]);
    await w.ctx.close();
  });

  test('phone: the bell is always shown for a nearby colleague, a tap sends, and the notification fits the screen', async ({ browser }) => {
    test.setTimeout(120_000);
    const w = await office(browser, USERS.worker.email, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const l = await office(browser, USERS.lead.email, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const worker = w.page;
    const lead = l.page;
    await goNextTo(worker, USERS.lead.name);
    await canvasOf(worker).scrollIntoViewIfNeeded();
    await expect(bell(worker)).toHaveCount(1);
    // No hover on a touch screen: the bell is visible as it is, and big enough to tap.
    await expect.poll(() => opacity(worker)).toBe('1');
    const box = (await bell(worker).boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(32);
    await shot(worker, 'nudge-11-phone-bell');
    await nudgeAllowed(worker, USERS.worker.email);
    await bell(worker).tap();
    await expect(worker.getByTestId('nudge-pending')).toBeVisible();
    const request = lead.getByTestId('nudge-request');
    await expect(request).toBeVisible();
    // The card is inside the screen, with both buttons on it, and the page does not scroll sideways.
    const card = (await request.boundingBox())!;
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThanOrEqual(390);
    expect(card.y + card.height).toBeLessThanOrEqual(844);
    expect(await lead.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const name of ['Accept', 'Ignore']) {
      const b = (await request.getByRole('button', { name }).boundingBox())!;
      expect(b.height).toBeGreaterThanOrEqual(32);
    }
    await shot(lead, 'nudge-12-phone-request');
    await request.getByRole('button', { name: 'Accept' }).tap();
    await expect(result(worker)).toHaveAttribute('data-outcome', 'accepted');
    await expect(result(lead)).toHaveAttribute('data-outcome', 'accepted');
    await shot(worker, 'nudge-13-phone-accepted');
    expect(w.errors).toEqual([]);
    expect(l.errors).toEqual([]);
    await w.ctx.close();
    await l.ctx.close();
  });

  test('reduced motion: the notification is the same, and nothing bounces', async ({ browser }) => {
    test.setTimeout(120_000);
    const w = await office(browser, USERS.worker.email, { reducedMotion: 'reduce' });
    const l = await office(browser, USERS.lead.email, { reducedMotion: 'reduce' });
    const worker = w.page;
    const lead = l.page;
    await goNextTo(worker, USERS.lead.name);
    await nudgeAllowed(worker, USERS.worker.email); // the earlier tests' nudges by the same person
    await avatarButton(worker, USERS.lead.name).hover();
    await expect.poll(() => opacity(worker)).toBe('1');
    expect(await bell(worker).evaluate((el) => getComputedStyle(el).transitionProperty)).toBe('none');
    await bell(worker).click();
    await expect(lead.getByTestId('nudge-request')).toContainText(`${USERS.worker.name} nudged you.`);
    expect(await lead.getByTestId('nudge-bell-icon').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    expect(await lead.getByTestId('nudge-marker').locator('svg').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    await shot(lead, 'nudge-14-reduced-motion');
    await lead.getByTestId('nudge-request').getByRole('button', { name: 'Ignore' }).click();
    await expect(result(worker)).toHaveAttribute('data-outcome', 'ignored');
    expect(w.errors).toEqual([]);
    expect(l.errors).toEqual([]);
    await w.ctx.close();
    await l.ctx.close();
  });
});
