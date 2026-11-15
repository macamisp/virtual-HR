import { expect, test, type Page } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

/**
 * Pixel-art office environment (FR-VO-001, ADR 054). The art is paint only, so this checks what
 * must not change: the scene is a handful of static textures (not rebuilt per visit or per
 * frame), doorways are still walked through, labels and controls are still there, the sampling
 * follows the zoom, and repeated visits neither leak textures nor throw.
 *
 * ADR 057 (FR-VO-015): the arcade's redesign is paint too. Its rugs, signs and glow add no
 * texture and block nobody; its doorways, cabinets and games are where they were.
 */
const canvasOf = (p: Page) => p.getByTestId('office-canvas');
const self = async (p: Page) => (await canvasOf(p).getAttribute('data-self'))!.split(',').map(Number) as [number, number];
/**
 * Short key presses left or right until the avatar stands still between two x positions. A held
 * key overshoots by however long the page takes to report the position, which varies with load.
 */
async function standAtX(p: Page, lo: number, hi: number): Promise<void> {
  const mid = (lo + hi) / 2;
  for (let i = 0; i < 80; i += 1) {
    const x = (await self(p))[0];
    if (x > lo && x < hi) {
      await p.waitForTimeout(300); // and still there once any last step has landed
      const again = (await self(p))[0];
      if (again > lo && again < hi) return;
      continue;
    }
    await p.keyboard.press(x >= hi ? 'KeyA' : 'KeyD', { delay: Math.min(400, Math.max(40, Math.abs(x - mid) * 3)) });
    await p.waitForTimeout(250);
  }
  throw new Error(`the avatar did not settle between x ${lo} and ${hi}`);
}
const goTo = (p: Page, room: string) => p.getByRole('list', { name: 'Rooms' }).getByTestId(`room-${room}`).getByRole('button', { name: `Go to ${room}` }).click();

test('the environment is static textures; doors stay open; zoom, labels and repeated visits work', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page, USERS.worker.email);
  await passNoticeGate(page);
  await page.goto('/office');
  const canvas = canvasOf(page);
  await expect(canvas.locator('canvas')).toBeVisible();
  // The default 3200 x 1280 map (office and campus, ADR 055) is eight 1024 px chunks, sampled crisply at normal zoom.
  await expect(canvas).toHaveAttribute('data-env', '8:nearest');

  // A doorway is still a doorway: from the middle of the lounge, walk left until under the wide
  // opening in its top wall (tiles 30..35), then straight up through it into the open area.
  await goTo(page, 'Lounge');
  await expect(page.getByTestId('my-status')).toContainText('Lounge');
  await canvas.focus();
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(1200);
  await page.keyboard.up('KeyA');
  await expect.poll(async () => (await self(page))[0]).toBeLessThan(35 * 32);
  expect((await self(page))[0]).toBeGreaterThan(31 * 32);
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await self(page))[1], { timeout: 10_000 }).toBeLessThan(29 * 32);
  await page.keyboard.up('KeyW');
  await expect(page.getByTestId('my-status')).not.toContainText('Lounge');
  await expect(page.getByTestId('office-notice')).toHaveCount(0);

  // Zoomed far out the scene is smoothed; zooming back in is crisp again. Same textures throughout.
  for (let i = 0; i < 6; i += 1) await page.getByRole('button', { name: 'Zoom out' }).click();
  await expect(canvas).toHaveAttribute('data-env', '8:linear');
  for (let i = 0; i < 8; i += 1) await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(canvas).toHaveAttribute('data-env', '8:nearest');

  // Leaving and coming back keeps one scene (old textures are released, not piled up).
  for (let i = 0; i < 3; i += 1) {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Tasks', exact: true }).click();
    await expect(canvasOf(page)).toHaveCount(0);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Office', exact: true }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-env', '8:nearest');
  }
  await expect(page.getByRole('list', { name: 'Rooms' }).getByRole('listitem')).toHaveCount(11);
  expect(errors).toEqual([]);
});

test('arcade (ADR 057): the decoration adds no texture, blocks nobody and leaves the doorways and games alone', async ({ browser }) => {
  for (const opts of [{ viewport: { width: 1440, height: 900 } }, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' as const }]) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await page.goto('/office');
    const canvas = canvasOf(page);
    await expect(canvas.locator('canvas')).toBeVisible();
    await expect(canvas).toHaveAttribute('data-connected', 'true');
    // Still the same eight floor textures: signs, posters, rugs and glow are painted into them.
    await expect(canvas).toHaveAttribute('data-env', '8:nearest');
    // Walk onto the rug in front of the arcade sofa: right of the game tables, then down to the sofa.
    await goTo(page, 'Arcade');
    await expect(page.getByTestId('my-status')).toContainText('Arcade');
    await canvas.focus();
    // Right of the game tables (x up to 2922) and left of the beanbag (x from 3030).
    await standAtX(page, 2945, 3005);
    await page.keyboard.down('KeyS');
    await expect.poll(async () => (await self(page))[1], { timeout: 10_000 }).toBeGreaterThan(1140);
    await page.keyboard.up('KeyS');
    // Back up to the middle of the room, left to under the doorway in the top wall (tiles 88..90),
    // and out through it into the garden: the neon, the wall art and the floor border are no wall.
    await page.keyboard.down('KeyW');
    await expect.poll(async () => (await self(page))[1], { timeout: 10_000, intervals: [50] }).toBeLessThan(960);
    await page.keyboard.up('KeyW');
    await standAtX(page, 2836, 2892);
    await page.keyboard.down('KeyW');
    await expect.poll(async () => (await self(page))[1], { timeout: 15_000 }).toBeLessThan(20 * 32);
    await page.keyboard.up('KeyW');
    await expect(page.getByTestId('my-status')).toContainText('Garden');
    await expect(page.getByTestId('office-notice')).toHaveCount(0);

    // Leaving and coming back builds one scene again, not a second one.
    await page.goto('/tasks');
    await expect(canvasOf(page)).toHaveCount(0);
    await page.goto('/office');
    await expect(canvasOf(page)).toHaveAttribute('data-env', '8:nearest');
    expect(errors).toEqual([]);
    await ctx.close();
  }
});
