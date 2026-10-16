import { expect, test } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

/**
 * Virtual office (FR-VO-001..005, 007, 008, 012, 013). The canvas is checked through what it
 * exposes (data-fps, data-avatars) and through the accessible list view, which offers every
 * action without the map.
 */
test.describe.serial('Virtual office: map, movement, people, rooms, list view', () => {
  test('the map loads, WASD moves the avatar, and a colleague appears in the people list', async ({ page, browser }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Office' }).click();
    const canvas = page.getByTestId('office-canvas');
    await expect(canvas.locator('canvas')).toBeVisible();
    await expect(canvas).toHaveAttribute('data-avatars', /\d+/);
    await expect(page.getByTestId('my-status')).toContainText('Active');

    const ctx = await browser.newContext();
    const lead = await ctx.newPage();
    await signIn(lead, USERS.lead.email);
    await passNoticeGate(lead);
    await lead.goto('/office');
    await expect(lead.getByTestId('office-canvas').locator('canvas')).toBeVisible();

    const people = page.getByTestId('people-list');
    await page.getByLabel('Find a colleague').fill('Leo');
    await expect(people).toContainText(USERS.lead.name);
    await expect(people).toContainText(/in the open area|in Reception/);

    // Keyboard movement: hold D for a moment; the server accepts it (no correction notice).
    await canvas.focus();
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(600);
    await page.keyboard.up('KeyD');
    await expect(page.getByTestId('office-notice')).toHaveCount(0);

    // Teleport next to the colleague.
    await people.getByRole('button', { name: `Go to ${USERS.lead.name}` }).click();
    await expect(page.getByTestId('proximity')).toContainText(USERS.lead.name);
    await ctx.close();
  });

  test('a knock room asks to knock; the list view works without the map', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await page.goto('/office');
    await page.getByRole('button', { name: 'List', exact: true }).click();
    await expect(page.getByTestId('office-canvas')).toHaveCount(0);
    const rooms = page.getByRole('list', { name: 'Rooms' });
    await expect(rooms.getByRole('listitem')).toHaveCount(8);
    await rooms.getByTestId('room-Board room').getByRole('button', { name: 'Go to Board room' }).click();
    await expect(page.getByTestId('office-notice')).toContainText('knock-to-enter');
    await page.getByTestId('office-notice').getByRole('button', { name: 'Knock' }).click();
    await expect(page.getByTestId('office-notice')).toContainText('Nobody is in the room');
    await rooms.getByTestId('room-Lounge').getByRole('button', { name: 'Go to Lounge' }).click();
    await expect(rooms.getByTestId('room-Lounge')).toContainText('you are here');
    // Status and desk from the keyboard-only panel.
    await page.getByLabel('Status', { exact: true }).selectOption('DND');
    await page.getByLabel('Message').fill('Focus time');
    await page.getByRole('button', { name: 'Set' }).click();
    await page.getByLabel('Claim a free desk').selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Claim' }).click();
    await page.getByRole('button', { name: /Go to my desk/ }).click();
    await expect(rooms.getByTestId('room-Lounge')).not.toContainText('you are here');
    await page.getByRole('button', { name: 'Release desk' }).click();
    await page.getByLabel('Status', { exact: true }).selectOption('AUTO');
    await page.getByRole('button', { name: 'Set' }).click();
    await page.getByRole('button', { name: 'Map', exact: true }).click();
  });

  test('bench: 200 avatars render; the frame rate is reported', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await page.goto('/office?bench=200');
    const canvas = page.getByTestId('office-canvas');
    await expect(canvas).toHaveAttribute('data-avatars', '201', { timeout: 20_000 });
    await page.waitForTimeout(5000);
    const fps = Number(await canvas.getAttribute('data-fps'));
    const frameMs = Number(await canvas.getAttribute('data-frame-ms'));
    test.info().annotations.push({ type: 'bench', description: `200 avatars: ${fps} fps, ${frameMs} ms of script per frame` });
    console.log(JSON.stringify({ officeBench: true, avatars: 200, fps, frameMs }));
    expect(fps).toBeGreaterThan(0);
  });
});
