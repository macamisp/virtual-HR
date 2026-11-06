import { expect, test, type Browser, type Page } from '@playwright/test';
import { USERS } from '../e2e/fixtures';
import { passNoticeGate, signIn } from '../e2e/helpers';

/**
 * Landing-page screenshots from the real application, against the synthetic e2e organisation only
 * (no real people or customer data): every record below is created through the normal UI.
 * Output: LANDING_SHOTS (default test-results/landing-shots); the chosen images are copied to
 * src/app/welcome/shots after review.
 */
const OUT = process.env.LANDING_SHOTS ?? 'test-results/landing-shots';
const VIEWPORT = { width: 1440, height: 900 };

function colomboDay(offset: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo' }).format(new Date(Date.now() + offset * 86_400_000));
}

async function open(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: VIEWPORT, timezoneId: 'Asia/Colombo' });
  const page = await ctx.newPage();
  await signIn(page, email);
  await passNoticeGate(page);
  return page;
}

async function shot(page: Page, name: string, height = VIEWPORT.height): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  // Let fonts, avatars and live counters settle before the capture.
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 82, clip: { x: 0, y: 0, width: VIEWPORT.width, height } });
}

test('landing page screenshots', async ({ browser }) => {
  const lead = await open(browser, USERS.lead.email);

  // Tasks: a small board assigned by the team lead, with estimates for the analytics view.
  const tasks: Array<[title: string, priority: string, assignee: string, hours: string]> = [
    ['Prepare November payroll summary', 'HIGH', USERS.worker.name, '3'],
    ['Review onboarding checklist for new hires', 'MEDIUM', USERS.worker.name, '2'],
    ['Update leave policy page', 'LOW', USERS.worker.name, '1'],
    ['Quarterly client report', 'HIGH', `${USERS.sub.name} · subcontractor`, '4'],
  ];
  for (const [title, priority, assignee, hours] of tasks) {
    await lead.goto('/tasks/new');
    const form = lead.getByRole('form', { name: 'New task' });
    await form.getByLabel('Title').fill(title);
    await form.getByLabel('Assignee').selectOption({ label: assignee });
    await form.getByLabel('Priority').selectOption(priority);
    await form.getByLabel('Estimate (hours)').fill(hours);
    await form.getByRole('button', { name: 'Create task' }).click();
    await expect(lead.getByTestId('task-title')).toHaveText(title);
  }

  // Meetings: two upcoming meetings scheduled by the lead.
  const meetings: Array<[title: string, day: number, time: string]> = [
    ['Weekly team sync', 1, '10:00'],
    ['Payroll review', 2, '14:30'],
  ];
  for (const [title, day, time] of meetings) {
    await lead.goto('/meetings');
    await lead.getByRole('button', { name: 'Schedule', exact: true }).click();
    const form = lead.getByRole('form', { name: 'Schedule a meeting' });
    await form.getByLabel('Title').fill(title);
    await form.getByLabel('Agenda').fill('Status, blockers and next steps');
    await form.getByLabel('Starts').fill(`${colomboDay(day)}T${time}`);
    await form.getByRole('button', { name: 'Schedule', exact: true }).click();
    await expect(lead).toHaveURL(/\/meetings\/[0-9a-f-]+/);
  }

  // The worker starts one task, logs earlier work against the tasks, and runs a timer.
  const worker = await open(browser, USERS.worker.email);
  await worker.goto('/tasks');
  await worker.getByRole('link', { name: 'Review onboarding checklist for new hires' }).click();
  await worker.getByLabel('Change status').selectOption('IN_PROGRESS');
  await expect(worker.getByText('In progress').first()).toBeVisible();

  await worker.goto('/work-time');
  const entries: Array<[task: string, day: number, minutes: string, where: string, kind: string]> = [
    ['Prepare November payroll summary', -1, '90', 'REMOTE', 'ADMIN'],
    ['Review onboarding checklist for new hires', -2, '75', 'OFFICE', 'REVIEW'],
    ['Update leave policy page', -3, '40', 'REMOTE', 'DOCUMENTATION'],
  ];
  for (const [task, day, minutes, where, kind] of entries) {
    const add = worker.getByTestId('add-work');
    await add.getByLabel('My task (optional)').selectOption({ label: task });
    await add.getByLabel('Where').selectOption(where);
    await add.getByLabel('Kind of work').selectOption(kind);
    await add.getByLabel('Day').fill(colomboDay(day));
    await add.getByLabel('Duration').check();
    await add.getByLabel('Minutes').fill(minutes);
    await add.getByLabel('Why are you adding this manually?').fill('Worked offline, logged afterwards');
    await add.getByRole('button', { name: 'Add work' }).click();
    await expect(add.getByRole('status')).toContainText('Added');
  }
  const timer = worker.getByTestId('work-timer');
  await timer.getByLabel('What are you working on?').fill('Prepare November payroll summary');
  await timer.getByLabel('Where').selectOption('REMOTE');
  await timer.getByLabel('Kind of work').selectOption('ADMIN');
  await timer.getByRole('button', { name: 'Start timer' }).click();
  await expect(timer.getByTestId('running-title')).toHaveText('Prepare November payroll summary');
  await shot(worker, 'work-time');

  await worker.goto('/attendance');
  await expect(worker.getByTestId('tracking-badge')).toHaveText(/Tracking: Active since/);
  await shot(worker, 'attendance');

  await lead.goto('/tasks/board');
  await lead.getByRole('button', { name: 'Created by me' }).click();
  await expect(lead.getByText('Prepare November payroll summary').first()).toBeVisible();
  await shot(lead, 'tasks');

  await lead.goto('/meetings');
  await expect(lead.getByText('Weekly team sync')).toBeVisible();
  await shot(lead, 'meetings', 520);

  await lead.goto('/work-time/reports');
  await lead.getByLabel('For').selectOption('team');
  await expect(lead.getByText('Prepare November payroll summary').first()).toBeVisible();
  await shot(lead, 'work-time-reports');

  // Office: colleagues in different places; the worker walks over to the team lead.
  const sub = await open(browser, USERS.sub.email);
  await sub.goto('/office');
  await lead.goto('/office');
  const leadCanvas = lead.getByTestId('office-canvas');
  await expect(leadCanvas.locator('canvas')).toBeVisible();
  await leadCanvas.focus();
  await lead.keyboard.down('KeyD');
  await lead.waitForTimeout(900);
  await lead.keyboard.up('KeyD');
  // Sam joins the lead and steps a little north of him.
  await sub.getByLabel('Find a colleague').fill('Leo');
  await sub.getByTestId('people-list').getByRole('button', { name: `Go to ${USERS.lead.name}` }).click();
  await sub.getByTestId('office-canvas').focus();
  await sub.keyboard.down('KeyW');
  await sub.waitForTimeout(300);
  await sub.keyboard.up('KeyW');
  await worker.goto('/office');
  await expect(worker.getByTestId('office-canvas').locator('canvas')).toBeVisible();
  await worker.getByLabel('Find a colleague').fill('Leo');
  await worker.getByTestId('people-list').getByRole('button', { name: `Go to ${USERS.lead.name}` }).click();
  await expect(worker.getByTestId('proximity')).toContainText(USERS.lead.name);
  await worker.getByLabel('Find a colleague').fill('');
  // Step back so the two name labels do not overlap, and zoom out to show the rooms around.
  const canvas = worker.getByTestId('office-canvas');
  await canvas.focus();
  await worker.keyboard.down('KeyS');
  await worker.waitForTimeout(250);
  await worker.keyboard.up('KeyS');
  await worker.getByRole('button', { name: /zoom out/i }).click();
  await shot(worker, 'office');
});
