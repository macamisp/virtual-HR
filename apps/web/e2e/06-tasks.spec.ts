import { expect, test, type Page } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn, signOut } from './helpers';

const TITLE = `Fix invoice template ${Date.now()}`;

async function openTask(page: Page, title: string) {
  await page.getByRole('link', { name: 'Tasks', exact: true }).click();
  await page.getByRole('link', { name: title }).click();
  await expect(page.getByTestId('task-title')).toHaveText(title);
}

test.describe.serial('Tasks: create, accept, comment with @mention, board (FR-TASK-001/002/005/006/007)', () => {
  let taskUrl = '';

  test('lead assigns a task to a subcontractor; markdown renders sanitised', async ({ page }) => {
    await signIn(page, USERS.lead.email);
    await passNoticeGate(page);
    await page.goto('/tasks/new');
    const form = page.getByRole('form', { name: 'New task' });
    await form.getByLabel('Title').fill(TITLE);
    await form.getByRole('textbox', { name: 'Description' }).fill('**Totals** are wrong <script>window.__xss = 1</script>\n\n- check VAT');
    await form.getByLabel('Assignee').selectOption({ label: 'Sam Subcontractor · subcontractor' });
    await form.getByLabel('Priority').selectOption('HIGH');
    await form.getByLabel('Checklist').fill('Find the bug\nShip the fix');
    await form.getByRole('button', { name: 'Create task' }).click();

    await expect(page.getByTestId('task-title')).toHaveText(TITLE);
    taskUrl = page.url();
    await expect(page.getByText('Awaiting acceptance')).toBeVisible();
    await expect(page.locator('strong', { hasText: 'Totals' })).toBeVisible();
    await expect(page.locator('main script')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    await expect(page.getByTestId('checklist').locator('li')).toHaveCount(2);
  });

  test('the subcontractor must accept before working; then comments with an @mention', async ({ page }) => {
    await signIn(page, USERS.sub.email);
    await passNoticeGate(page);
    await openTask(page, TITLE);

    const status = page.getByLabel('Change status');
    await expect(status).toBeDisabled();
    await page.getByTestId('acceptance-panel').getByRole('button', { name: 'Accept task' }).click();
    await expect(page.getByTestId('acceptance-panel')).toHaveCount(0);
    await expect(status).toBeEnabled();
    await status.selectOption('IN_PROGRESS');
    await expect(page.getByText('In progress').first()).toBeVisible();

    const box = page.getByRole('combobox', { name: 'Add a comment' });
    await box.fill('Started. @Leo');
    await expect(page.getByRole('listbox', { name: 'People you can mention' })).toBeVisible();
    await box.press('Enter');
    await box.pressSequentially('can you check the VAT rule?');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(page.getByTestId('comments').locator('mark.mention', { hasText: '@Leo Lead' })).toBeVisible();
    await expect(page.getByTestId('activity')).toContainText('accepted the task');
    await signOut(page);
  });

  test('lead moves the card on the board by keyboard and by drag and drop', async ({ page }) => {
    await signIn(page, USERS.lead.email);
    await passNoticeGate(page);
    await page.goto('/tasks/board');
    await page.getByRole('button', { name: 'Created by me' }).click();
    const card = page.getByTestId(`card-${TITLE}`);
    await expect(page.getByTestId('column-IN_PROGRESS').getByTestId(`card-${TITLE}`)).toBeVisible();

    // Keyboard path: the "Move to" select
    await card.getByLabel(`Move “${TITLE}” to`).selectOption('IN_REVIEW');
    await expect(page.getByText(`Moved “${TITLE}” to In review.`)).toBeVisible();
    await expect(page.getByTestId('column-IN_REVIEW').getByTestId(`card-${TITLE}`)).toBeVisible();

    // Mouse path: drag to Done
    await page.getByTestId('column-IN_REVIEW').getByTestId(`card-${TITLE}`).dragTo(page.getByTestId('column-DONE'));
    await expect(page.getByTestId('column-DONE').getByTestId(`card-${TITLE}`)).toBeVisible();
  });

  test('a colleague outside the task cannot open it', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await page.goto(taskUrl);
    await expect(page.getByText('Task not found')).toBeVisible();
    await page.goto('/tasks');
    await page.getByRole('button', { name: 'All I can see' }).click();
    await expect(page.getByRole('link', { name: TITLE })).toHaveCount(0);
  });
});
