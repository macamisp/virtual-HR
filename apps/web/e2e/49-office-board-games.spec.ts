import { expect, test, type Browser, type Page } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

/**
 * FR-VO-017 (ADR 062): chess and checkers between two people in two browsers at the arcade's chess
 * table. Invite, accept, moves by clicking squares (the server checks them), fool's mate seen by
 * both, checkers on the same table and a resignation; the same in the isometric view.
 */
const canvasOf = (p: Page) => p.getByTestId('office-canvas');

async function office(browser: Browser, email: string, view: 'top' | 'iso' = 'top') {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((v) => { try { localStorage.setItem('hrvo.office.projection', v); } catch { /* storage unavailable */ } }, view);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page, email);
  await passNoticeGate(page);
  await page.goto('/office');
  await expect(canvasOf(page)).toHaveAttribute('data-connected', 'true');
  await expect(canvasOf(page)).toHaveAttribute('data-view', view);
  return { ctx, page, errors };
}

/** Into the arcade, then a click on the floor in front of the chess table walks there. */
async function toChessTable(p: Page, dx: number) {
  await p.getByRole('list', { name: 'Rooms' }).getByTestId('room-Arcade').getByRole('button', { name: 'Go to Arcade' }).click();
  await expect(p.getByTestId('my-status')).toContainText('Arcade');
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.waitForTimeout(700);
  const box = (await canvasOf(p).boundingBox())!;
  const tables = JSON.parse((await canvasOf(p).getAttribute('data-board-tables')) || '[]') as Array<{ x: number; y: number }>;
  expect(tables.length, 'a chess table on this map').toBeGreaterThan(0);
  await p.mouse.click(box.x + tables[0]!.x + dx, box.y + tables[0]!.y);
  await expect(p.getByTestId('board-prompt')).toBeVisible({ timeout: 15_000 });
}

async function play(p: Page, from: string, to: string) {
  await p.getByTestId(`sq-${from}`).click();
  await p.getByTestId(`sq-${to}`).click();
}

test.describe.serial('Office board games (ADR 062)', () => {
  test('chess: invite, accept, fool\'s mate seen by both; then checkers and a resignation', async ({ browser }) => {
    test.setTimeout(180_000);
    const w = await office(browser, USERS.worker.email);
    const l = await office(browser, USERS.lead.email);
    await toChessTable(w.page, -10);
    await toChessTable(l.page, 14);

    const invite = w.page.getByTestId('board-prompt').getByRole('button', { name: `Invite ${USERS.lead.name} to chess` });
    await expect(invite).toBeVisible({ timeout: 10_000 });
    await invite.click();
    await expect(w.page.getByTestId('board-pending')).toContainText(`Waiting for ${USERS.lead.name}`);
    const card = l.page.getByTestId('board-invite');
    await expect(card).toContainText(`${USERS.worker.name} invites you to a game of chess`);
    await card.getByRole('button', { name: 'Accept' }).click();

    const wb = w.page.getByTestId('board-dialog');
    const lb = l.page.getByTestId('board-dialog');
    await expect(wb).toHaveAttribute('data-game', 'chess');
    await expect(lb).toHaveAttribute('data-game', 'chess');
    await expect(w.page.getByTestId('board-status')).toHaveText('Your turn');
    await expect(l.page.getByTestId('board-status')).toHaveText(`${USERS.worker.name}'s turn`);
    // Black cannot move first: on the other person's turn the empty squares are not even clickable.
    await expect(l.page.getByTestId('sq-e5')).toBeDisabled();

    await play(w.page, 'f2', 'f3');
    await expect(lb).toHaveAttribute('data-turn', 'b');
    await play(l.page, 'e7', 'e5');
    await expect(wb).toHaveAttribute('data-turn', 'w');
    await play(w.page, 'g2', 'g4');
    await expect(lb).toHaveAttribute('data-turn', 'b');
    await play(l.page, 'd8', 'h4');
    await expect(wb).toHaveAttribute('data-result', 'b:checkmate');
    await expect(lb).toHaveAttribute('data-result', 'b:checkmate');
    await expect(l.page.getByTestId('board-status')).toContainText('You win (checkmate)');
    await expect(w.page.getByTestId('board-status')).toContainText(`${USERS.lead.name} wins (checkmate)`);
    await w.page.screenshot({ path: test.info().outputPath('chess-checkmate.png') });
    await wb.getByRole('button', { name: 'Close the game' }).click();
    await lb.getByRole('button', { name: 'Close the game' }).click();

    // Checkers on the same table; the lead resigns.
    await w.page.waitForTimeout(3_200); // the invitation cooldown
    await w.page.getByTestId('board-prompt').getByRole('button', { name: 'Checkers' }).click();
    await w.page.getByTestId('board-prompt').getByRole('button', { name: `Invite ${USERS.lead.name} to checkers` }).click();
    await l.page.getByTestId('board-invite').getByRole('button', { name: 'Accept' }).click();
    await expect(wb).toHaveAttribute('data-game', 'checkers');
    await play(w.page, 'c3', 'd4');
    await expect(lb).toHaveAttribute('data-turn', 'b');
    await lb.getByRole('button', { name: 'Resign' }).click();
    await lb.getByRole('button', { name: 'Yes, resign' }).click();
    await expect(w.page.getByTestId('board-status')).toContainText('You win');
    await expect(wb).toHaveAttribute('data-result', 'w:resigned');
    expect(w.errors).toEqual([]);
    expect(l.errors).toEqual([]);
    await w.ctx.close();
    await l.ctx.close();
  });

  test('isometric view: walk to the table, invite, accept, a move each', async ({ browser }) => {
    test.setTimeout(150_000);
    const w = await office(browser, USERS.worker.email, 'iso');
    const l = await office(browser, USERS.lead.email, 'iso');
    await toChessTable(w.page, -10);
    await toChessTable(l.page, 14);
    await w.page.getByTestId('board-prompt').getByRole('button', { name: `Invite ${USERS.lead.name} to chess` }).click();
    await l.page.getByTestId('board-invite').getByRole('button', { name: 'Accept' }).click();
    await play(w.page, 'e2', 'e4');
    await expect(l.page.getByTestId('board-dialog')).toHaveAttribute('data-turn', 'b');
    await play(l.page, 'e7', 'e5');
    await expect(w.page.getByTestId('board-dialog')).toHaveAttribute('data-turn', 'w');
    await w.page.getByTestId('board-dialog').getByRole('button', { name: 'Resign' }).click();
    await w.page.getByRole('button', { name: 'Yes, resign' }).click();
    await expect(l.page.getByTestId('board-dialog')).toHaveAttribute('data-result', 'b:resigned');
    expect(w.errors).toEqual([]);
    expect(l.errors).toEqual([]);
    await w.ctx.close();
    await l.ctx.close();
  });
});
