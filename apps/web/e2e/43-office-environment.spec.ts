import { expect, test, type Page } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

/**
 * Pixel-art office environment (FR-VO-001, ADR 054). The art is paint only, so this checks what
 * must not change: the scene is a handful of static textures (not rebuilt per visit or per
 * frame), doorways are still walked through, labels and controls are still there, the sampling
 * follows the zoom, and repeated visits neither leak textures nor throw.
 */
const canvasOf = (p: Page) => p.getByTestId('office-canvas');
const self = async (p: Page) => (await canvasOf(p).getAttribute('data-self'))!.split(',').map(Number) as [number, number];
const goTo = (p: Page, room: string) => p.getByRole('list', { name: 'Rooms' }).getByTestId(`room-${room}`).getByRole('button', { name: `Go to ${room}` }).click();

test('the environment is static textures; doors stay open; zoom, labels and repeated visits work', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page, USERS.worker.email);
  await passNoticeGate(page);
  await page.goto('/office');
  const canvas = canvasOf(page);
  await expect(canvas.locator('canvas')).toBeVisible();
  // The default 1920 x 1280 map is four 1024 px chunks, sampled crisply at normal zoom.
  await expect(canvas).toHaveAttribute('data-env', '4:nearest');

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
  await expect(canvas).toHaveAttribute('data-env', '4:linear');
  for (let i = 0; i < 8; i += 1) await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(canvas).toHaveAttribute('data-env', '4:nearest');

  // Leaving and coming back keeps one scene (old textures are released, not piled up).
  for (let i = 0; i < 3; i += 1) {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Tasks', exact: true }).click();
    await expect(canvasOf(page)).toHaveCount(0);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Office', exact: true }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-env', '4:nearest');
  }
  await expect(page.getByRole('list', { name: 'Rooms' }).getByRole('listitem')).toHaveCount(8);
  expect(errors).toEqual([]);
});
