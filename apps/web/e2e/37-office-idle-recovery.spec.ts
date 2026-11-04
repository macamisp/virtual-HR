import { expect, test, type Browser, type Page } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';
import { hearsAudio, PC_HOOK } from './media';

/**
 * Regression for the "avatar freezes after a while" bug (ADR 048 §8): the office socket must
 * survive the access token's expiry (the server kicks the socket at `exp`; a kicked Socket.IO
 * client never reconnects on its own) and a network drop in the middle of a walk (a move whose
 * acknowledgement never comes must not block every later move). The e2e API issues two-minute
 * tokens (playwright.config.ts) so the expiry happens inside the test.
 *
 * "Recovered" is judged by what the other user sees: the walk reaches the server (room changes
 * in B's people list), the ring reaches A (UI socket), and A's page shows no "Connecting" alert.
 */

async function inOffice(browser: Browser, email: string, media = false): Promise<Page> {
  const ctx = await browser.newContext(media ? { permissions: ['camera', 'microphone'] } : {});
  if (media) await ctx.addInitScript(PC_HOOK);
  const page = await ctx.newPage();
  await signIn(page, email);
  await passNoticeGate(page);
  await page.goto('/office');
  await expect(page.getByTestId('office-canvas').locator('canvas')).toBeVisible();
  await expect(page.getByTestId('office-canvas')).toHaveAttribute('data-connected', 'true');
  if (media) {
    await page.getByRole('button', { name: 'Turn on audio and video' }).click();
    await page.getByTestId('prejoin').getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(page.getByTestId('office-media')).toBeVisible();
  }
  return page;
}
const selfPos = async (page: Page) => (await page.getByTestId('office-canvas').getAttribute('data-self')) ?? '';
const goTo = (page: Page, room: string) => page.getByRole('list', { name: 'Rooms' }).getByTestId(`room-${room}`).getByRole('button', { name: `Go to ${room}` }).click();

/** Walks right for `ms` with the keyboard and returns the own position before and after. */
async function walk(page: Page, ms: number): Promise<{ before: string; after: string }> {
  const before = await selfPos(page);
  await page.getByTestId('office-canvas').focus();
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(ms);
  await page.keyboard.up('KeyD');
  await page.waitForTimeout(300);
  return { before, after: await selfPos(page) };
}

test.describe.serial('office idle and network recovery (ADR 048 §8)', () => {
  test('the avatar keeps moving after the access token expired while the user was idle', async ({ browser }) => {
    test.setTimeout(300_000);
    const a = await inOffice(browser, USERS.worker.email);
    const b = await inOffice(browser, USERS.lead.email);
    try {
      await b.getByLabel('Find a colleague').fill('Wendy');
      const row = b.getByTestId('people-list').getByRole('listitem').filter({ hasText: USERS.worker.name });
      await expect(row).toContainText(/in the open area|in Reception/);
      const tokenLife = 120_000;
      // Idle past the token's life: no input at all on A (the attendance heartbeat keeps running).
      await a.waitForTimeout(tokenLife + 10_000);
      await expect(a.getByTestId('office-canvas')).toHaveAttribute('data-connected', 'true', { timeout: 20_000 });
      await expect(a.getByText('Connecting to the office…')).toHaveCount(0);
      await expect(a.getByTestId('office-notice')).toHaveCount(0);
      // Keyboard still moves the avatar, and the server still accepts the moves (B sees the room change).
      const w = await walk(a, 800);
      expect(w.after, 'the avatar moved').not.toBe(w.before);
      await goTo(a, 'Meeting room A');
      await expect(a.getByTestId('my-status')).toContainText('Meeting room A');
      await expect(row).toContainText('in Meeting room A', { timeout: 15_000 });
      // The UI socket (rings, broadcasts) survived too: B's call rings on A's page.
      await b.getByRole('button', { name: `Call ${USERS.worker.name}`, exact: true }).click();
      await expect(a.getByTestId('ring')).toBeVisible({ timeout: 20_000 });
      await a.getByTestId('ring').getByRole('button', { name: 'Decline', exact: true }).click();
    } finally {
      await b.context().close();
      await a.context().close();
    }
  });

  test('a network drop in the middle of a walk does not leave the avatar stuck', async ({ browser }) => {
    test.setTimeout(180_000);
    const a = await inOffice(browser, USERS.worker.email);
    const b = await inOffice(browser, USERS.lead.email);
    try {
      await b.getByLabel('Find a colleague').fill('Wendy');
      const row = b.getByTestId('people-list').getByRole('listitem').filter({ hasText: USERS.worker.name });
      await expect(row).toContainText(/in the open area|in Reception/);
      // Walk, lose the network while a move is in flight, keep walking, then get the network back.
      await a.getByTestId('office-canvas').focus();
      await a.keyboard.down('KeyD');
      await a.waitForTimeout(400);
      await a.context().setOffline(true);
      await a.waitForTimeout(1500);
      await a.keyboard.up('KeyD');
      await a.waitForTimeout(4000);
      await a.context().setOffline(false);
      await expect(a.getByTestId('office-canvas')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 });
      await expect(a.getByText('Connecting to the office…')).toHaveCount(0, { timeout: 30_000 });
      // Moves reach the server again: B sees A enter a room by walking there (not by teleport).
      const w = await walk(a, 800);
      expect(w.after).not.toBe(w.before);
      await goTo(a, 'Meeting room A');
      await expect(a.getByTestId('my-status')).toContainText('Meeting room A');
      await expect(row).toContainText('in Meeting room A', { timeout: 15_000 });
      // And a walk out of the room is accepted (the move stream, not only teleports): the teleport
      // puts the avatar just below the table, in the door column (as in spec 34).
      await a.getByTestId('office-canvas').focus();
      await a.keyboard.down('KeyS');
      await a.waitForTimeout(1500);
      await a.keyboard.up('KeyS');
      await expect(a.getByTestId('my-status')).not.toContainText('Meeting room A', { timeout: 15_000 });
      await expect(row).not.toContainText('in Meeting room A', { timeout: 15_000 });
    } finally {
      await b.context().close();
      await a.context().close();
    }
  });

  test('a short network drop during a room call: the call resumes (same session) and the office reconnects', async ({ browser }) => {
    test.setTimeout(240_000);
    const a = await inOffice(browser, USERS.worker.email, true);
    const b = await inOffice(browser, USERS.lead.email, true);
    let tokens = 0;
    a.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/media/token')) tokens += 1; });
    try {
      await goTo(a, 'Meeting room A');
      await goTo(b, 'Meeting room A');
      const bRemote = b.getByTestId('office-media').getByTestId('tile-remote');
      await expect(bRemote).toHaveAttribute('data-identity', USERS.worker.id);
      await expect(a.getByTestId('call-view')).toHaveAttribute('data-status', 'connected');
      await expect.poll(() => hearsAudio(b), { timeout: 20_000 }).toBe(true);
      const tokensBefore = tokens;
      await a.context().setOffline(true);
      await a.waitForTimeout(5_000);
      await a.context().setOffline(false);
      // LiveKit resumes the same session; the office socket comes back; audio flows again.
      await expect(a.getByTestId('call-view')).toHaveAttribute('data-status', 'connected', { timeout: 60_000 });
      await expect(a.getByTestId('office-canvas')).toHaveAttribute('data-connected', 'true', { timeout: 30_000 });
      await expect(a.getByText('Connecting to the office…')).toHaveCount(0, { timeout: 30_000 });
      await expect(a.getByTestId('my-status')).toContainText('Meeting room A');
      await expect(bRemote).toHaveCount(1);
      await expect.poll(() => hearsAudio(b), { timeout: 30_000 }).toBe(true);
      expect(tokens, 'the call resumed without a new media token').toBe(tokensBefore);
    } finally {
      await b.context().close();
      await a.context().close();
    }
  });
});
