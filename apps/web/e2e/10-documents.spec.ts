import { expect, test } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

const stamp = Date.now();
const TITLE = `Remote work policy ${stamp}`;
const pdf = (text: string) => Buffer.from(
  `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n` +
    `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj\n% ${text}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
);
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

test.describe.serial('Documents: upload, scan, preview, versions, sharing, quarantine (FR-DOC-001..004, 009, 013, 019)', () => {
  test.skip(!process.env.S3_ENDPOINT || !process.env.CLAMAV_HOST, 'needs S3_ENDPOINT and CLAMAV_HOST');

  test('the worker uploads a PDF straight to storage; it is scanned, previewed, downloaded and versioned', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await page.getByRole('link', { name: 'Documents', exact: true }).click();
    await page.getByRole('button', { name: 'Upload' }).click();
    const form = page.getByRole('form', { name: 'Upload a document' });
    await form.getByLabel('File').setInputFiles({ name: 'policy.pdf', mimeType: 'application/pdf', buffer: pdf('v1') });
    await form.getByLabel('Title').fill(TITLE);
    await form.getByLabel('Category').selectOption('POLICY');
    await form.getByLabel('Tags (comma-separated)').fill('remote, hr');
    await form.getByRole('button', { name: 'Upload', exact: true }).click();

    await expect(page.getByTestId('document-title')).toHaveText(TITLE);
    await expect(page.getByTestId('scan-status').first()).toHaveText('Ready');
    await expect(page.getByTestId('preview')).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download', exact: true }).click()]);
    expect(download.suggestedFilename()).toBe('policy.pdf');
    const fs = await import('node:fs/promises');
    expect((await fs.readFile((await download.path())!)).toString()).toContain('% v1');

    await page.getByRole('button', { name: 'New version' }).click();
    const vform = page.getByRole('form', { name: 'Upload a new version' });
    await vform.getByLabel('File').setInputFiles({ name: 'policy-v2.pdf', mimeType: 'application/pdf', buffer: pdf('v2') });
    await vform.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.getByTestId('version-2')).toContainText('(current)');
    await page.getByTestId('version-1').getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByTestId('version-3')).toContainText('restored from v1');
    await expect(page.getByTestId('version-3')).toContainText('(current)');
  });

  test('sharing with a colleague gives exactly the granted level', async ({ page, browser }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await page.getByRole('link', { name: 'Documents', exact: true }).click();
    await page.getByRole('link', { name: TITLE }).click();
    const share = page.getByTestId('sharing');
    await share.getByLabel('Person').selectOption({ label: `${USERS.lead.name} · team_lead` });
    await share.getByLabel('Permission').selectOption('VIEW');
    await share.getByRole('button', { name: 'Share' }).click();
    await expect(share).toContainText(`${USERS.lead.name}: View`);
    await expect(page.getByTestId('access-log')).toContainText('ACL_CHANGE');

    const ctx = await browser.newContext();
    const lead = await ctx.newPage();
    await signIn(lead, USERS.lead.email);
    await passNoticeGate(lead);
    await lead.getByRole('link', { name: 'Documents', exact: true }).click();
    await lead.getByRole('link', { name: TITLE }).click();
    await expect(lead.getByTestId('preview')).toBeVisible();
    await expect(lead.getByRole('button', { name: 'Download', exact: true })).toHaveCount(0);
    await expect(lead.getByTestId('sharing')).toHaveCount(0);
    await ctx.close();
  });

  test('a subcontractor sees only their own documents; an infected upload is quarantined and reported', async ({ page }) => {
    await signIn(page, USERS.sub.email);
    await passNoticeGate(page);
    await page.getByRole('link', { name: 'Documents', exact: true }).click();
    await expect(page.getByText('No documents here')).toBeVisible();
    await page.getByRole('button', { name: 'Upload' }).click();
    const form = page.getByRole('form', { name: 'Upload a document' });
    await form.getByLabel('File').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(EICAR) });
    await form.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.getByTestId('quarantined')).toContainText('Malware detected');
    await expect(page.getByRole('button', { name: 'Download', exact: true })).toHaveCount(0);
    await page.getByTestId('notification-bell').click();
    await expect(page.getByTestId('notification-panel')).toContainText('Malware found in your upload: notes');
  });
});
