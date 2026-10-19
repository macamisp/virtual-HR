import { expect, test, type Browser, type Page } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

/** Chat (FR-MEET-012, 013; ADR 017): a public channel, live delivery, mentions, a thread, search and a DM. */
async function personIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, email);
  await passNoticeGate(page);
  return page;
}

test.describe.serial('Chat: channels, mentions, threads, DMs', () => {
  test('a message reaches a channel member live; a thread reply and search work', async ({ browser }) => {
    const worker = await personIn(browser, USERS.worker.email);
    await worker.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Chat' }).click();
    await worker.getByRole('button', { name: 'New' }).click();
    await worker.getByLabel('Type').selectOption('PUBLIC');
    await worker.getByLabel('Name').fill('e2e-general');
    await worker.getByLabel('Topic').fill('Everything');
    await worker.getByRole('button', { name: 'Create' }).click();
    await expect(worker.getByTestId('channel-e2e-general')).toHaveAttribute('aria-current', 'true');

    const lead = await personIn(browser, USERS.lead.email);
    await lead.goto('/chat');
    await lead.getByTestId('channel-e2e-general').click();
    await lead.getByRole('button', { name: 'Join channel' }).click();
    await expect(lead.getByRole('textbox', { name: 'Message e2e-general' })).toBeVisible();

    // A mention through the picker, sent with Enter; it arrives on the other page without a reload.
    const box = worker.getByRole('textbox', { name: 'Message e2e-general' });
    await worker.getByRole('button', { name: 'Mention someone' }).click();
    await worker.getByRole('searchbox', { name: 'Mention someone' }).fill('Leo');
    await worker.getByRole('button', { name: new RegExp(USERS.lead.name) }).click();
    // The picked mention is inserted by an effect after the click: wait for it, then type after it.
    await expect(box).toHaveValue(new RegExp(USERS.lead.name));
    await box.press('End');
    await box.pressSequentially('hello team');
    await box.press('Enter');
    const leadMsg = lead.getByTestId('chat-message').filter({ hasText: 'hello team' });
    await expect(leadMsg).toContainText(`@${USERS.lead.name} hello team`);

    // Thread reply from the lead; the worker sees the reply count.
    await leadMsg.getByRole('button', { name: 'Reply in thread' }).click();
    const reply = lead.getByTestId('thread').getByRole('textbox', { name: 'Reply in thread' });
    await reply.fill('on it');
    await reply.press('Enter');
    await expect(lead.getByTestId('thread')).toContainText('on it');
    await expect(worker.getByTestId('chat-message').filter({ hasText: 'hello team' })).toContainText('1 reply');

    await worker.getByLabel('Search messages').fill('hello');
    await expect(worker.getByTestId('chat-search-results')).toContainText('e2e-general');
    await lead.context().close();
    await worker.context().close();
  });

  test('a direct message; a subcontractor does not see public channels', async ({ browser }) => {
    const worker = await personIn(browser, USERS.worker.email);
    await worker.goto('/chat');
    await worker.getByRole('button', { name: 'New' }).click();
    await worker.getByRole('searchbox', { name: 'Person' }).fill('Sam');
    await worker.getByRole('button', { name: new RegExp(USERS.sub.name) }).click();
    await worker.getByRole('button', { name: 'Create' }).click();
    const box = worker.getByRole('textbox', { name: `Message ${USERS.sub.name}` });
    await box.fill('quick question');
    await box.press('Enter');

    const sub = await personIn(browser, USERS.sub.email);
    await sub.goto('/chat');
    await expect(sub.getByTestId(`channel-${USERS.worker.name}`)).toBeVisible();
    await expect(sub.getByTestId('channel-e2e-general')).toHaveCount(0);
    await sub.getByTestId(`channel-${USERS.worker.name}`).click();
    await expect(sub.getByTestId('chat-message')).toContainText('quick question');
    await sub.context().close();
    await worker.context().close();
  });
});
