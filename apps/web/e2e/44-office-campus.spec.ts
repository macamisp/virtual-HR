import { expect, test, type Browser, type Page } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

/**
 * Office campus (ADR 055): the Café, Arcade and Garden reached from the Lounge, the frontend-only
 * mini-games opened from their objects (click, tap, or E next to them), and festive mode: on by
 * default, off removes the whole seasonal layer and nothing else, remembered in this browser, no
 * reload. Room permissions and the office's own art are checked to be untouched.
 */
const canvasOf = (p: Page) => p.getByTestId('office-canvas');
const goTo = async (p: Page, room: string) => {
  await p.getByRole('list', { name: 'Rooms' }).getByTestId(`room-${room}`).getByRole('button', { name: `Go to ${room}` }).click();
  await expect(p.getByTestId('my-status')).toContainText(room);
};
type GameSpot = { game: string; x: number; y: number; id: number };
const games = async (p: Page): Promise<GameSpot[]> => JSON.parse((await canvasOf(p).getAttribute('data-games')) || '[]') as GameSpot[];
const festive = async (p: Page) => {
  const [state, pieces, bulbs] = ((await canvasOf(p).getAttribute('data-festive')) ?? '').split(':');
  return { state, pieces: Number(pieces), bulbs: Number(bulbs) };
};

async function office(browser: Browser, email: string, opts: Parameters<Browser['newContext']>[0] = {}) {
  const ctx = await browser.newContext(opts);
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

/**
 * Clicks (or taps) a game object of that kind where the map itself is under the pointer (not the
 * sticky call toolbar or a panel over it), then waits for its dialog.
 */
async function playFromObject(p: Page, game: string, tap = false): Promise<void> {
  const target = async () => {
    const box = (await canvasOf(p).boundingBox())!;
    for (const g of (await games(p)).filter((x) => x.game === game)) {
      const x = box.x + g.x;
      const y = box.y + g.y;
      const onMap = await p.evaluate(([px, py]) => !!document.elementFromPoint(px!, py!)?.closest('[data-testid="office-canvas"]'), [x, y]);
      if (onMap) return { x, y };
    }
    return null;
  };
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.waitForTimeout(600);
  let t = await target();
  if (!t) { await canvasOf(p).scrollIntoViewIfNeeded(); await p.waitForTimeout(600); t = await target(); }
  expect(t, `a ${game} object is visible on the map`).not.toBeNull();
  if (tap) await p.touchscreen.tap(t!.x, t!.y);
  else await p.mouse.click(t!.x, t!.y);
  await expect(p.getByTestId('game-dialog')).toHaveAttribute('data-game', game, { timeout: 15_000 });
}

test.describe.serial('Office campus (ADR 055)', () => {
  test('the campus is reached from the Lounge; the three areas are open; permissions are unchanged', async ({ browser }) => {
    const w = await office(browser, USERS.worker.email);
    const p = w.page;
    const rooms = p.getByRole('list', { name: 'Rooms' });
    await expect(rooms.getByRole('listitem')).toHaveCount(11);
    for (const area of ['Garden', 'Café', 'Arcade']) await expect(rooms.getByTestId(`room-${area}`)).toContainText('Open');
    // Walk from the Lounge through its doorway into the café: down to the bottom row, right to the
    // wall, then up and right together; the wall slide carries the avatar into the doorway (rows 33..35).
    await goTo(p, 'Lounge');
    await canvasOf(p).focus();
    const self = async () => (await canvasOf(p).getAttribute('data-self'))!.split(',').map(Number) as [number, number];
    await p.keyboard.down('KeyS');
    await expect.poll(async () => (await self())[1], { timeout: 10_000 }).toBeGreaterThan(37 * 32);
    await p.keyboard.up('KeyS');
    await p.keyboard.down('KeyD');
    await expect.poll(async () => (await self())[0], { timeout: 15_000 }).toBeGreaterThan(58 * 32);
    await p.keyboard.down('KeyW');
    await expect(p.getByTestId('my-status')).toContainText('Café', { timeout: 20_000 });
    await p.keyboard.up('KeyW');
    await p.keyboard.up('KeyD');
    await expect(p.getByTestId('office-notice')).toHaveCount(0);
    // Access-controlled rooms still say no.
    await goTo(p, 'Garden');
    await rooms.getByTestId('room-Board room').getByRole('button', { name: 'Go to Board room' }).click();
    await expect(p.getByTestId('office-notice')).toContainText('knock-to-enter');
    await expect(p.getByTestId('my-status')).toContainText('Garden');
    expect(w.errors).toEqual([]);
    await w.close();
  });

  test('mini-games open from their objects, play, and close back to the map', async ({ browser }) => {
    const w = await office(browser, USERS.worker.email);
    const p = w.page;
    await goTo(p, 'Café');
    await goTo(p, 'Arcade');

    // Tic-Tac-Toe from a cabinet: walk there by clicking it; the dialog opens on arrival.
    await playFromObject(p, 'tictactoe');
    const dialog = p.getByTestId('game-dialog');
    await expect(dialog.getByRole('heading', { name: 'Tic-Tac-Toe' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Close the game/ })).toBeFocused();
    await dialog.getByTestId('ttt-4').click();
    await expect(dialog.getByTestId('ttt-4')).toHaveText('X');
    await expect.poll(async () => (await dialog.getByRole('button', { name: /: O$/ }).count())).toBe(1); // the computer answered
    await p.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(canvasOf(p)).toBeFocused();

    // Standing next to a game shows the prompt; E opens it from the keyboard.
    await expect(p.getByTestId('game-prompt')).toContainText('Tic-Tac-Toe');
    await p.keyboard.press('KeyE');
    await expect(dialog).toHaveAttribute('data-game', 'tictactoe');
    await dialog.getByRole('button', { name: /Close the game/ }).click();

    // Memory Match: two cards turn; a pair stays, a miss turns back.
    await playFromObject(p, 'memory');
    await dialog.getByTestId('card-0').click();
    await dialog.getByTestId('card-1').click();
    await expect(dialog.getByTestId('game-status')).toContainText('moves: 1');
    await expect.poll(async () => (await dialog.locator('[aria-pressed="true"]').count()) % 2).toBe(0);
    await p.keyboard.press('Escape');

    // Sliding puzzle: a piece next to the gap slides; the move counts.
    await playFromObject(p, 'puzzle');
    await dialog.getByRole('button', { name: /next to the gap/ }).first().click();
    await expect(dialog.getByTestId('game-status')).toContainText('moves: 1');
    await dialog.getByRole('button', { name: /Close the game/ }).click();
    await expect(dialog).toHaveCount(0);
    expect(w.errors).toEqual([]);
    await w.close();
  });

  test('festive mode: on by default; off removes only the seasonal layer, without a reload; remembered', async ({ browser }) => {
    const w = await office(browser, USERS.lead.email);
    const p = w.page;
    const toggle = p.getByRole('switch', { name: 'Festive mode' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await festive(p)).state).toBe('on');
    const on = await festive(p);
    expect(on.pieces, 'decorations').toBeGreaterThan(20);
    expect(on.bulbs, 'fairy lights').toBeGreaterThan(100);
    const env = await canvasOf(p).getAttribute('data-env');

    await p.evaluate(() => { (window as unknown as { marker: number }).marker = 42; });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(canvasOf(p)).toHaveAttribute('data-festive', 'off:0:0');
    expect(await p.evaluate(() => (window as unknown as { marker?: number }).marker), 'no reload').toBe(42);
    await expect(canvasOf(p), 'the office art is untouched').toHaveAttribute('data-env', env!);

    // Remembered in this browser.
    await p.reload();
    await expect(canvasOf(p).locator('canvas')).toBeVisible();
    await expect(p.getByRole('switch', { name: 'Festive mode' })).toHaveAttribute('aria-checked', 'false');
    await expect(canvasOf(p)).toHaveAttribute('data-festive', 'off:0:0');
    await p.getByRole('switch', { name: 'Festive mode' }).click();
    await expect.poll(async () => festive(p)).toEqual(on);

    // Leaving and coming back rebuilds the same layer once (nothing left over, nothing doubled).
    for (let i = 0; i < 2; i += 1) {
      await p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Tasks', exact: true }).click();
      await expect(canvasOf(p)).toHaveCount(0);
      await p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Office', exact: true }).click();
      await expect.poll(async () => festive(p)).toEqual(on);
    }
    expect(await p.evaluate(() => [...document.querySelectorAll('canvas')].filter((c) => !c.closest('[data-testid="avatar-settings"]')).length)).toBe(1);
    expect(w.errors).toEqual([]);
    await w.close();
  });

  test('phone: a tap on a game walks there and opens it; the dialog and the switch fit the screen', async ({ browser }) => {
    const m = await office(browser, USERS.sub.email, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const p = m.page;
    await goTo(p, 'Café');
    await goTo(p, 'Arcade');
    await playFromObject(p, 'tictactoe', true);
    const box = (await p.getByTestId('game-dialog').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await p.getByTestId('ttt-0').tap();
    await expect(p.getByTestId('ttt-0')).toHaveText('X');
    await p.getByRole('button', { name: /Close the game/ }).tap();
    await p.getByRole('switch', { name: 'Festive mode' }).scrollIntoViewIfNeeded();
    await expect(p.getByRole('switch', { name: 'Festive mode' })).toBeVisible();
    expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(m.errors).toEqual([]);
    await m.close();
  });
});
