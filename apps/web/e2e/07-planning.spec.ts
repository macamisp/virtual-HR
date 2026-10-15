import { expect, test } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

const stamp = Date.now();
const PLANNED = `Write release notes ${stamp}`;
const BACKLOG = `Refactor billing ${stamp}`;

function colomboToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo' }).format(new Date());
}

test.describe.serial('Planning: Today, end-of-day, weekly planner, workload, calendar (FR-TASK-003/004/005)', () => {
  test('the worker plans the day, confirms it and submits an end-of-day report', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    for (const [title, planned, hours] of [[PLANNED, colomboToday(), '2'], [BACKLOG, '', '3']] as const) {
      await page.goto(`/tasks/new${planned ? `?planned=${planned}` : ''}`);
      const form = page.getByRole('form', { name: 'New task' });
      await form.getByLabel('Title').fill(title);
      await form.getByLabel('Estimate (hours)').fill(hours);
      await form.getByRole('button', { name: 'Create task' }).click();
      await expect(page.getByTestId('task-title')).toHaveText(title);
    }

    await page.goto('/tasks/today');
    const start = page.getByTestId('start-of-day');
    await expect(start.getByLabel(PLANNED)).toBeChecked();
    await start.getByLabel('Goals for today').fill('Get the notes out');
    await start.getByRole('button', { name: 'Confirm my plan' }).click();
    await expect(page.getByTestId('plan-confirmed')).toContainText('Goals: Get the notes out');
    const item = page.getByTestId('today-items').locator('li', { hasText: PLANNED });
    await expect(item.getByText('In my plan')).toBeVisible();

    const eod = page.getByTestId('end-of-day');
    await eod.getByLabel('Done today').fill('Drafted half of the notes');
    await eod.getByLabel('Tomorrow').fill('Finish the notes');
    await eod.getByRole('button', { name: 'Submit report' }).click();
    await expect(eod.getByText('Report submitted.')).toBeVisible();
    await expect(item.getByText('Carried to next work day')).toBeVisible();
  });

  test('the weekly planner schedules by drag and by keyboard, shows capacity and keeps goals', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await page.goto('/tasks/week');
    const firstDay = page.locator('[data-testid^="day-"]').first();
    const mondayId = (await firstDay.getAttribute('data-testid'))!;
    const tuesdayId = (await page.locator('[data-testid^="day-"]').nth(1).getAttribute('data-testid'))!;

    await page.getByTestId('backlog').getByTestId(`week-card-${BACKLOG}`).dragTo(firstDay);
    await expect(page.getByTestId(mondayId).getByTestId(`week-card-${BACKLOG}`)).toBeVisible();
    await expect(page.getByText(new RegExp(`Planned “${BACKLOG}” for`))).toBeVisible();

    const card = page.getByTestId(mondayId).getByTestId(`week-card-${BACKLOG}`);
    await card.focus();
    await card.press('Alt+ArrowRight');
    await expect(page.getByTestId(tuesdayId).getByTestId(`week-card-${BACKLOG}`)).toBeVisible();
    // Includes this task (3h) and, depending on the weekday, the 2h task carried over at end of day.
    await expect(page.getByTestId('capacity-text')).toContainText('of 40h');
    const scheduled = Number(/Scheduled (\d+)h/.exec((await page.getByTestId('capacity-text').innerText()) ?? '')?.[1] ?? 0);
    expect(scheduled).toBeGreaterThanOrEqual(3);

    await page.getByLabel('New weekly goal').fill('Ship v2');
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByTestId('weekly-goals')).toContainText('Ship v2');
    await expect(page.getByText('Goals saved')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('weekly-goals')).toContainText('Ship v2');
  });

  test('the team lead sees the report on the workload view; the calendar shows planned work', async ({ page }) => {
    await signIn(page, USERS.lead.email);
    await passNoticeGate(page);
    await page.goto('/tasks/workload');
    await expect(page.getByTestId(`workload-${USERS.worker.email}`).getByText('Report in')).toBeVisible();

    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await page.goto('/tasks/calendar');
    await page.getByRole('button', { name: 'By planned date' }).click();
    await expect(page.getByTestId('calendar').getByRole('link', { name: BACKLOG })).toBeVisible();
  });
});
