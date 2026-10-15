import { expect, test, type Page } from '@playwright/test';
import { PASSWORD, USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

const stamp = Date.now();
const SECRET = `Salary review ${stamp}`;
const PUBLIC = `Brochure ${stamp}`;
const pdf = (text: string) => Buffer.from(
  `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n` +
    `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj\n% ${text}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
);

async function uploadDoc(page: Page, title: string, confidentiality: 'NORMAL' | 'CONFIDENTIAL') {
  await page.goto('/documents');
  await page.getByRole('button', { name: 'Upload' }).click();
  const form = page.getByRole('form', { name: 'Upload a document' });
  await form.getByLabel('File').setInputFiles({ name: `${title}.pdf`, mimeType: 'application/pdf', buffer: pdf(title) });
  await form.getByLabel('Title').fill(title);
  await form.getByLabel('Confidentiality').selectOption(confidentiality);
  await form.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByTestId('document-title')).toHaveText(title);
  await expect(page.getByTestId('scan-status').first()).toHaveText('Ready');
}

test.describe.serial('Confidential vault: re-auth, document password, share links, view-only, trash (FR-DOC-005, 006, 010, 011, 017)', () => {
  test.skip(!process.env.S3_ENDPOINT || !process.env.CLAMAV_HOST, 'needs S3_ENDPOINT and CLAMAV_HOST');

  test('a confidential document asks the owner to confirm it is them, then a document password', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await uploadDoc(page, SECRET, 'CONFIDENTIAL');
    await page.getByTestId('open-preview').click();
    const reauth = page.getByTestId('reauth-dialog');
    await reauth.getByLabel('Your account password').fill('not my password');
    await reauth.getByRole('button', { name: 'Confirm' }).click();
    await expect(reauth).toContainText('did not match');
    await reauth.getByLabel('Your account password').fill(PASSWORD);
    await reauth.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByTestId('preview')).toBeVisible();

    const pw = page.getByRole('form', { name: 'Document password' });
    await pw.getByLabel('Password (10+ characters)').fill('a long document passphrase');
    await pw.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByTestId('password-card')).toContainText('Password set.');
    await page.reload();
    await expect(page.getByTestId('versions')).toContainText('(protected by a password)');
    await page.getByTestId('open-preview').click();
    const dlg = page.getByTestId('doc-password-dialog');
    await dlg.getByLabel('Document password').fill('wrong passphrase!');
    await dlg.getByRole('button', { name: 'Unlock' }).click();
    await expect(dlg).toContainText('Wrong document password');
    await dlg.getByLabel('Document password').fill('a long document passphrase');
    await dlg.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByTestId('preview')).toBeVisible();
  });

  test('a share link opens one document for someone without an account', async ({ page, browser }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await uploadDoc(page, PUBLIC, 'NORMAL');
    const card = page.getByTestId('share-links');
    await card.getByLabel('Max openings (optional)').fill('3');
    await card.getByRole('button', { name: 'Create link' }).click();
    const url = await page.getByTestId('new-link-url').innerText();
    expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{43}$/);
    await expect(page.getByTestId('share-link-list')).toContainText('opened 0/3');

    const guest = await (await browser.newContext()).newPage();
    await guest.goto(new URL(url).pathname);
    await expect(guest.getByTestId('shared-title')).toHaveText(PUBLIC);
    await guest.getByRole('button', { name: 'View' }).click();
    await expect(guest.getByTestId('shared-view')).toBeVisible();
    const [dl] = await Promise.all([guest.waitForEvent('download'), guest.getByRole('button', { name: 'Download' }).click()]);
    expect(dl.suggestedFilename()).toBe(`${PUBLIC}.pdf`);
    await guest.goto(`/s/${'A'.repeat(43)}`);
    await expect(guest.getByTestId('link-invalid')).toContainText('not valid or has expired');

    await page.reload();
    await page.getByTestId('share-links').getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByTestId('share-link-list')).toContainText('Revoked');
    await guest.goto(new URL(url).pathname);
    await expect(guest.getByTestId('link-invalid')).toBeVisible();
  });

  test('a colleague with View access gets the watermarked view only; the owner can trash and restore', async ({ page, browser }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await page.goto('/documents');
    await page.getByRole('link', { name: PUBLIC }).click();
    const share = page.getByTestId('sharing');
    await share.getByLabel('Person').selectOption({ label: `${USERS.lead.name} · team_lead` });
    await share.getByLabel('Permission').selectOption('VIEW');
    await share.getByRole('button', { name: 'Share' }).click();
    await expect(share).toContainText(`${USERS.lead.name}: View`);

    const leadCtx = await browser.newContext();
    const lead = await leadCtx.newPage();
    await signIn(lead, USERS.lead.email);
    await passNoticeGate(lead);
    await lead.goto('/documents');
    await lead.getByRole('link', { name: PUBLIC }).click();
    await expect(lead.getByTestId('view-only-note')).toContainText('watermarked with your name');
    await expect(lead.getByTestId('preview')).toBeVisible();
    await expect(lead.getByRole('button', { name: 'Download', exact: true })).toHaveCount(0);
    await leadCtx.close();

    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page).toHaveURL(/\/documents\/trash$/);
    const row = page.getByTestId('trash').getByRole('row', { name: new RegExp(PUBLIC) });
    await row.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByTestId('trash').getByRole('row', { name: new RegExp(PUBLIC) })).toHaveCount(0);
  });
});
