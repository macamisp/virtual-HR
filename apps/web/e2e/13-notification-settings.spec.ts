import { expect, test } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

test.describe.serial('Notification settings and unsubscribe (FR-NOTIF-002, 004)', () => {
  test('a person sets quiet hours and switches an email off; security notices stay on', async ({ page }) => {
    await signIn(page, USERS.sub.email);
    await passNoticeGate(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Notification settings' }).click();
    const form = page.getByRole('form', { name: 'Notification settings' });
    await form.getByLabel('Hold emails during quiet hours').check();
    await form.getByLabel('From', { exact: true }).fill('21:00');
    await form.getByLabel('Until', { exact: true }).fill('21:00');
    await expect(form.getByRole('alert')).toContainText('Start and end must differ');
    await form.getByLabel('Until', { exact: true }).fill('06:30');
    await form.getByLabel('Your timezone').selectOption('Europe/Berlin');
    await form.getByLabel('Task status changed: email').uncheck();
    await expect(form.getByLabel('Malware found in an upload: email')).toBeDisabled();
    await form.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved.' })).toBeVisible();
    await page.reload();
    const again = page.getByRole('form', { name: 'Notification settings' });
    await expect(again.getByLabel('Until', { exact: true })).toHaveValue('06:30');
    await expect(again.getByLabel('Your timezone')).toHaveValue('Europe/Berlin');
    await expect(again.getByLabel('Task status changed: email')).not.toBeChecked();
    await expect(again.getByLabel('Task status changed: in app')).toBeChecked();
  });

  test('the unsubscribe page refuses an incomplete or tampered link', async ({ page }) => {
    await page.goto('/unsubscribe');
    await expect(page.getByTestId('unsubscribe')).toContainText('This link is incomplete');
    await page.goto('/unsubscribe#v1.bm90YXJlYWx0b2tlbg.dGFtcGVyZWRtYWN0YW1wZXJlZG1hYw');
    await page.getByRole('button', { name: 'Stop these emails' }).click();
    await expect(page.getByTestId('unsubscribe').getByRole('alert').filter({ hasText: 'not valid' })).toBeVisible();
  });
});
