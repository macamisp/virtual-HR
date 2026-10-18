import { expect, test } from '@playwright/test';
import { generateSync } from 'otplib';
import { ADMIN_USER, ORG_ID, TEAM_ID, USERS, adminPool } from './fixtures';
import { passNoticeGate, signIn, signOut } from './helpers';

/**
 * Teams and the manager hierarchy in the browser (FR-ORG-006; ADR 031): an admin creates a team,
 * moves a person under a new manager, sees it in the organisation chart, and is not offered a
 * manager that would make the hierarchy loop. An employee has neither screen.
 */
test.describe.serial('Teams, managers and the organisation chart', () => {
  test.afterAll(async () => {
    // Other specs rely on the seeded structure: Sam in Support, reporting to Leo.
    const pool = adminPool();
    try {
      await pool.query(`UPDATE users SET team_id = $1, manager_id = $2 WHERE id = $3`, [TEAM_ID, USERS.lead.id, USERS.sub.id]);
      await pool.query(`DELETE FROM teams WHERE org_id = $1 AND id <> $2`, [ORG_ID, TEAM_ID]);
    } finally { await pool.end(); }
  });

  test('an admin creates a team, moves a person under a new manager, and sees it in the chart', async ({ page }) => {
    await signIn(page, ADMIN_USER.email);
    await page.getByLabel('Authentication code').fill(generateSync({ secret: ADMIN_USER.totp }));
    await page.getByRole('button', { name: 'Verify' }).click();
    await passNoticeGate(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Teams and managers' }).click();

    const create = page.getByRole('form', { name: 'Create a team' });
    await create.getByLabel('New team').fill('Night shift');
    await create.getByLabel('Lead (optional)').selectOption({ label: USERS.lead.name });
    await create.getByRole('button', { name: 'Create team' }).click();
    await expect(page.getByText('Created Night shift.')).toBeVisible();
    await expect(page.getByTestId('team-Night shift')).toContainText('0');

    const sam = page.getByTestId(`person-${USERS.sub.email}`);
    await sam.getByLabel(`Team of ${USERS.sub.name}`).selectOption({ label: 'Night shift' });
    await sam.getByLabel(`Manager of ${USERS.sub.name}`).selectOption({ label: USERS.worker.name });
    await sam.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(`Saved ${USERS.sub.name}'s team and manager.`)).toBeVisible();
    await expect(page.getByTestId('team-Night shift').getByRole('cell').nth(2)).toHaveText('1');

    // Leo manages Wendy, who now manages Sam: neither may become Leo's manager.
    const leoManager = page.getByTestId(`person-${USERS.lead.email}`).getByLabel(`Manager of ${USERS.lead.name}`);
    const offered = await leoManager.locator('option').allTextContents();
    expect(offered).not.toContain(USERS.worker.name);
    expect(offered).not.toContain(USERS.sub.name);
    expect(offered).toContain(USERS.hr.name);

    await page.getByRole('link', { name: 'Organisation chart' }).first().click();
    const underWendy = page.getByRole('list', { name: `Reports to ${USERS.worker.name}` });
    await expect(underWendy.getByTestId(`chart-${USERS.sub.email}`)).toContainText('Night shift');
    await expect(page.getByRole('list', { name: `Reports to ${USERS.lead.name}` }).getByTestId(`chart-${USERS.worker.email}`)).toContainText('1 direct report');
    await signOut(page);
  });

  test('an employee has neither screen', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Teams and managers' })).toHaveCount(0);
    await page.goto('/admin/teams');
    await expect(page.getByTestId('access-denied')).toBeVisible();
    await page.goto('/admin/org-chart');
    await expect(page.getByTestId('access-denied')).toBeVisible();
    await signOut(page);
  });
});
