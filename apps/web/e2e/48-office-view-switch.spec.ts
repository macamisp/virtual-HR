import { expect, test, type Browser, type Page } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

/**
 * ADR 061: the office's Classic / Isometric switch. The default is classic (production's default;
 * the suite pins NEXT_PUBLIC_OFFICE_DEFAULT_VIEW=top). The choice is remembered in this browser, and
 * the Map / List toggle no longer erases it (both used to share one storage key). In the isometric
 * view the office still works: keyboard walking, click to go, a game from its cabinet, avatar
 * actions and a nudge between two people.
 */
const canvasOf = (p: Page) => p.getByTestId('office-canvas');
const styleButton = (p: Page, name: 'Classic' | 'Isometric') => p.getByTestId('map-style').getByRole('button', { name });
const self = async (p: Page) => ((await canvasOf(p).getAttribute('data-self')) ?? '0,0').split(',').map(Number) as [number, number];

async function office(browser: Browser, email: string) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page, email);
  await passNoticeGate(page);
  await page.goto('/office');
  await expect(canvasOf(page)).toHaveAttribute('data-connected', 'true');
  return { ctx, page, errors };
}
async function goTo(p: Page, room: string) {
  await p.getByRole('list', { name: 'Rooms' }).getByTestId(`room-${room}`).getByRole('button', { name: `Go to ${room}` }).click();
  await expect(p.getByTestId('my-status')).toContainText(room);
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.waitForTimeout(600);
}

test.describe.serial('Office map style (ADR 061)', () => {
  test('classic by default; isometric is chosen, survives a reload and the Map / List toggle; classic again', async ({ browser }) => {
    test.setTimeout(120_000);
    const { ctx, page: p, errors } = await office(browser, USERS.worker.email);
    await expect(canvasOf(p)).toHaveAttribute('data-view', 'top');
    await expect(styleButton(p, 'Classic')).toHaveAttribute('aria-pressed', 'true');

    await styleButton(p, 'Isometric').click();
    await expect(canvasOf(p)).toHaveAttribute('data-view', 'iso');
    await expect(canvasOf(p)).toHaveAttribute('data-connected', 'true');
    await expect(styleButton(p, 'Isometric')).toHaveAttribute('aria-pressed', 'true');

    await p.reload();
    await expect(canvasOf(p)).toHaveAttribute('data-view', 'iso');
    // The Map / List toggle keeps its own setting.
    await p.getByRole('group', { name: 'View' }).getByRole('button', { name: 'List' }).click();
    await expect(canvasOf(p)).toHaveCount(0);
    await p.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Map' }).click();
    await expect(canvasOf(p)).toHaveAttribute('data-view', 'iso');
    await p.reload();
    await expect(canvasOf(p)).toHaveAttribute('data-view', 'iso');

    await styleButton(p, 'Classic').click();
    await expect(canvasOf(p)).toHaveAttribute('data-view', 'top');
    await p.reload();
    await expect(canvasOf(p)).toHaveAttribute('data-view', 'top');
    expect(errors).toEqual([]);
    await ctx.close();
  });

  test('isometric: walking, click to go, a game from its cabinet, actions and a nudge', async ({ browser }) => {
    test.setTimeout(180_000);
    const w = await office(browser, USERS.worker.email);
    const p = w.page;
    await styleButton(p, 'Isometric').click();
    await expect(canvasOf(p)).toHaveAttribute('data-view', 'iso');
    await expect(canvasOf(p)).toHaveAttribute('data-connected', 'true');

    // W walks up the screen: both map coordinates fall.
    await goTo(p, 'Café');
    await canvasOf(p).focus();
    const [x0, y0] = await self(p);
    await p.keyboard.down('KeyW'); await p.waitForTimeout(350); await p.keyboard.up('KeyW');
    await expect.poll(async () => { const [x, y] = await self(p); return x < x0 - 10 && y < y0 - 10; }).toBe(true);

    // Click to go: 120 px right of the avatar on screen is map (+80, -80) at scale 0.75.
    const box = (await canvasOf(p).boundingBox())!;
    const before = await self(p);
    await p.mouse.click(box.x + box.width / 2 + 120, box.y + box.height / 2);
    await expect.poll(async () => { const [x, y] = await self(p); return Math.abs(x - before[0] - 80) < 24 && Math.abs(y - before[1] + 80) < 24; }, { timeout: 10_000 }).toBe(true);

    // A cabinet opens its game.
    await goTo(p, 'Arcade');
    const games = JSON.parse((await canvasOf(p).getAttribute('data-games')) || '[]') as Array<{ game: string; x: number; y: number }>;
    const b = (await canvasOf(p).boundingBox())!;
    const t = games.find((g) => g.game === 'tictactoe' && g.x > 0 && g.y > 0 && g.x < b.width && g.y < b.height);
    expect(t, 'a cabinet on screen').toBeTruthy();
    await p.mouse.click(b.x + t!.x, b.y + t!.y);
    await expect(p.getByTestId('game-dialog')).toHaveAttribute('data-game', 'tictactoe', { timeout: 15_000 });
    await p.getByTestId('game-dialog').getByRole('button', { name: /Close the game/ }).click();

    // Avatar actions.
    await p.getByTestId('actions-button').click();
    await p.getByTestId('action-menu').getByRole('menuitem', { name: /Wave/ }).click();
    await expect.poll(async () => JSON.parse((await canvasOf(p).getAttribute('data-avatar-sprites')) || '[]').find((s: { self: boolean }) => s.self)?.lastPose ?? null).toMatch(/wave/);

    // A nudge through the colleague's overlay, which lines up with the isometric avatar.
    const l = await office(browser, USERS.lead.email);
    await p.getByLabel('Find a colleague').fill('Leo');
    await p.getByTestId('people-list').getByRole('button', { name: `Go to ${USERS.lead.name}` }).click();
    await expect(p.getByTestId('proximity')).toContainText(USERS.lead.name);
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.getByRole('button', { name: `Avatar actions for ${USERS.lead.name}` }).hover();
    await p.getByTestId('nudge-bell').click();
    await expect(l.page.getByTestId('nudge-request')).toBeVisible();
    await l.page.getByTestId('nudge-request').getByRole('button', { name: 'Ignore' }).click();

    // Back to classic for the next spec.
    await styleButton(p, 'Classic').click();
    await expect(canvasOf(p)).toHaveAttribute('data-view', 'top');
    expect(w.errors).toEqual([]);
    expect(l.errors).toEqual([]);
    await l.ctx.close();
    await w.ctx.close();
  });
});
