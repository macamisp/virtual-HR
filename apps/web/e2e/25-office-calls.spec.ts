import { expect, test, type Browser, type Page } from '@playwright/test';
import { adminPool, USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

async function person(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  await signIn(page, email);
  await passNoticeGate(page);
  await page.goto('/office');
  await expect(page.getByRole('list', { name: 'People', exact: true })).toBeVisible();
  return page;
}
async function join(page: Page) {
  const pre = page.getByTestId('prejoin');
  await expect(pre).toBeVisible();
  await expect.poll(async () => Number(await pre.getByRole('meter', { name: 'Microphone level' }).getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  await pre.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByTestId('call-view')).toHaveAttribute('data-status', 'connected');
}

test.describe.serial('FR-VO-008 / FR-MEET-001, 005, 012, 013: office calls and meeting chat', () => {
  test.beforeEach(async () => {
    // Start with nobody in a call: LiveKit reports "left" some seconds after an earlier spec's call
    // ends, and until then the callee is correctly treated as busy and not rung.
    const pool = adminPool();
    try {
      await pool.query(`UPDATE meeting_participants SET left_at = now() WHERE user_id = ANY($1::uuid[]) AND left_at IS NULL`, [[USERS.lead.id, USERS.worker.id]]);
      await pool.query(`UPDATE meeting_calls SET state = 'CANCELLED', decided_at = now() WHERE state IN ('RINGING', 'ACCEPTED') AND (callee_id = ANY($1::uuid[]) OR caller_id = ANY($1::uuid[]))`, [[USERS.lead.id, USERS.worker.id]]);
    } finally { await pool.end(); }
  });

  test('people list rings, decline reaches caller, avatar menu accepts; chat persists for both users', async ({ browser }) => {
    test.setTimeout(180_000); // two sign-ins, two calls, two media joins and a chat round trip
    const lead = await person(browser, USERS.lead.email);
    const host = await person(browser, USERS.worker.email);
    try {
      await host.getByRole('button', { name: `Call ${USERS.lead.name}`, exact: true }).click();
      await lead.getByTestId('ring').getByRole('button', { name: 'Decline', exact: true }).click();
      await expect(host.getByTestId('call-responses')).toContainText('Declined');
      await host.goto('/office');
      const avatar = host.getByRole('button', { name: `Avatar actions for ${USERS.lead.name}`, exact: true });
      await avatar.focus();
      await avatar.press('Shift+F10');
      await host.getByRole('menuitem', { name: `Call ${USERS.lead.name}`, exact: true }).click();
      await expect(lead.getByTestId('ring')).toBeVisible();
      await lead.getByTestId('ring').getByRole('button', { name: 'Accept', exact: true }).click();
      await join(lead);
      await join(host);
      await expect(host.getByTestId('tile-remote')).toBeVisible();
      await host.getByRole('button', { name: 'Chat', exact: true }).click();
      await lead.getByRole('button', { name: 'Chat', exact: true }).click();
      const panel = host.getByRole('region', { name: 'Meeting chat', exact: true });
      await panel.getByRole('button', { name: 'Mention someone', exact: true }).click();
      await panel.getByRole('searchbox', { name: 'Mention someone', exact: true }).fill('Leo');
      await panel.getByRole('button', { name: new RegExp(USERS.lead.name) }).click();
      const message = panel.getByRole('textbox', { name: 'Message this meeting', exact: true });
      // The picked mention is inserted by an effect after the click: wait for it before appending.
      await expect(message).toHaveValue(/Leo Lead/);
      await message.fill(`${await message.inputValue()}hello in the meeting`);
      await message.press('Enter');
      await expect(lead.getByTestId('chat-message')).toContainText('@Leo Lead hello in the meeting');
      await lead.getByRole('textbox', { name: 'Message this meeting', exact: true }).fill('Received, thanks');
      await lead.getByRole('textbox', { name: 'Message this meeting', exact: true }).press('Enter');
      await expect(panel.getByTestId('chat-message').last()).toContainText('Received, thanks');
      await expect(panel.getByRole('button', { name: 'Share a document' })).toBeVisible();
      const meetingUrl = host.url();
      await host.getByRole('button', { name: 'Leave', exact: true }).click();
      await host.goto(meetingUrl);
      await host.getByRole('button', { name: 'Chat', exact: true }).click();
      await expect(host.getByTestId('chat-message').last()).toContainText('Received, thanks');
      const pool = adminPool();
      try {
        const meetingId = meetingUrl.split('/').pop()!.split('?')[0]!;
        const rows = await pool.query(`SELECT count(*)::int AS n FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.meeting_id = $1`, [meetingId]);
        expect(rows.rows[0].n).toBe(2);
      } finally { await pool.end(); }
    } finally { await host.context().close(); await lead.context().close(); }
  });
});
