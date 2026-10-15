import { expect, test } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

const TITLE = `Prepare payroll export ${Date.now()}`;

test.describe.serial('Notifications: live bell, list, mark read (FR-TASK-011, FR-NOTIF-001)', () => {
  test('the assignee sees a live unread badge when the lead assigns a task, then reads it', async ({ browser }) => {
    const workerCtx = await browser.newContext();
    const leadCtx = await browser.newContext();
    const worker = await workerCtx.newPage();
    const lead = await leadCtx.newPage();

    await signIn(worker, USERS.worker.email);
    await passNoticeGate(worker);
    // Start from zero unread so the count below is exact.
    const bell = worker.getByTestId('notification-bell');
    await bell.click();
    const markAll = worker.getByTestId('notification-panel').getByRole('button', { name: 'Mark all read' });
    if (await markAll.isEnabled()) await markAll.click();
    await expect(bell).toHaveAttribute('aria-label', 'Notifications');
    await bell.click();
    await expect(worker.getByTestId('notification-panel')).toHaveCount(0);

    await signIn(lead, USERS.lead.email);
    await passNoticeGate(lead);
    await lead.goto('/tasks/new');
    const form = lead.getByRole('form', { name: 'New task' });
    await form.getByLabel('Title').fill(TITLE);
    await form.getByLabel('Assignee').selectOption({ label: USERS.worker.name });
    await form.getByRole('button', { name: 'Create task' }).click();
    await expect(lead.getByTestId('task-title')).toHaveText(TITLE);

    // Arrives over the socket (the poll fallback is 60 s, longer than this timeout).
    await expect(bell).toHaveAttribute('aria-label', 'Notifications, 1 unread');
    await expect(worker.getByTestId('notification-count')).toHaveText('1');

    await bell.click();
    const panel = worker.getByTestId('notification-panel');
    const entry = panel.getByRole('link', { name: new RegExp(`New task: ${TITLE}`) });
    await expect(entry).toContainText('unread');
    await entry.click();
    await expect(worker.getByTestId('task-title')).toHaveText(TITLE);
    await expect(bell).toHaveAttribute('aria-label', 'Notifications');
    await expect(worker.getByTestId('notification-count')).toHaveCount(0);

    await bell.click();
    await expect(panel.getByRole('link', { name: new RegExp(`New task: ${TITLE}`) })).not.toContainText('unread');
    await worker.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);

    await workerCtx.close();
    await leadCtx.close();
  });
});
