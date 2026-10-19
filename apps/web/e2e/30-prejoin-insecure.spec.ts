import { expect, test } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn, signOut } from './helpers';

/**
 * FR-MEET-011: opened over plain http:// (a LAN address or a tunnel without TLS) the browser
 * gives no camera or microphone. The pre-join must say that HTTPS (or localhost) is required
 * instead of a generic failure. The test makes the page an insecure context before it loads.
 */
test('the pre-join explains that camera and microphone need HTTPS or localhost', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'isSecureContext', { get: () => false });
    Object.defineProperty(Navigator.prototype, 'mediaDevices', { get: () => undefined });
  });
  await signIn(page, USERS.worker.email);
  await passNoticeGate(page);
  await page.goto('/office');
  await page.getByRole('button', { name: 'Turn on audio and video' }).click();
  const error = page.getByTestId('prejoin').getByTestId('prejoin-error');
  await expect(error).toContainText('only works on a secure connection');
  await expect(error).toContainText('HTTPS');
  await expect(error).toContainText('localhost');
  await signOut(page);
});
