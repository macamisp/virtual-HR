import { expect, test } from '@playwright/test';
import { PASSWORD, USERS } from './fixtures';
import { passNoticeGate, signIn, signOut } from './helpers';

const TITLE = `Offer letter ${Date.now()}`;
const pdf = (text: string) => Buffer.from(
  `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n` +
    `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj\n% ${text}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
);

test.describe.serial('E-signature: request, draw with re-authentication, signed copy and verification (FR-DOC-014)', () => {
  test.skip(!process.env.S3_ENDPOINT || !process.env.CLAMAV_HOST, 'needs S3_ENDPOINT and CLAMAV_HOST');

  test('the owner asks a colleague to sign a PDF', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await page.goto('/documents');
    await page.getByRole('button', { name: 'Upload' }).click();
    const form = page.getByRole('form', { name: 'Upload a document' });
    await form.getByLabel('File').setInputFiles({ name: 'offer.pdf', mimeType: 'application/pdf', buffer: pdf(TITLE) });
    await form.getByLabel('Title').fill(TITLE);
    await form.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.getByTestId('scan-status').first()).toHaveText('Ready');
    const card = page.getByTestId('signatures-card');
    await expect(card).toContainText('No signature requests yet.');
    await card.getByRole('button', { name: 'Request signatures' }).click();
    const req = card.getByRole('form', { name: 'Request signatures' });
    await req.getByLabel('Signers').fill('Leo');
    await req.getByRole('button', { name: new RegExp(USERS.lead.name) }).click();
    await req.getByLabel('Message').fill('Please countersign');
    await req.getByRole('button', { name: 'Send request' }).click();
    await expect(card).toContainText('Waiting for signatures');
    await expect(card).toContainText('0 of 1 signed');
    await signOut(page);
  });

  test('the signer draws, consents, confirms with their password and the signed copy is produced', async ({ page }) => {
    await signIn(page, USERS.lead.email);
    await passNoticeGate(page);
    await page.getByRole('link', { name: 'Signatures' }).click();
    const list = page.getByTestId('signature-list');
    await list.getByRole('link', { name: 'Review and sign' }).first().click();
    await expect(page.getByTestId('esign-title')).toHaveText(TITLE);
    await expect(page.getByText('Please countersign')).toBeVisible();
    const sign = page.getByRole('form', { name: 'Sign' });
    const signBtn = sign.getByRole('button', { name: 'Sign', exact: true });
    await expect(signBtn).toBeDisabled();
    const pad = page.getByTestId('signature-pad');
    const box = (await pad.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + box.height * 0.7);
    await page.mouse.down();
    for (let i = 1; i <= 20; i += 1) await page.mouse.move(box.x + 20 + i * 12, box.y + box.height * (0.7 - Math.sin(i / 3) * 0.3));
    await page.mouse.up();
    await page.getByTestId('esign-consent').check();
    await sign.getByLabel('Confirm with your account password').fill('wrong password');
    await signBtn.click();
    await expect(sign.getByRole('alert')).toBeVisible();
    await sign.getByLabel('Confirm with your account password').fill(PASSWORD);
    await signBtn.click();
    await expect(page.getByTestId('esign-status')).toHaveText('Signed');
    await expect(page.getByTestId('esign-signers')).toContainText('Signed');
    const v = page.getByTestId('esign-verification');
    await expect(v.getByText('Unchanged')).toHaveCount(2, { timeout: 30_000 });
    await signOut(page);
  });

  test('the owner sees the signed copy as the current version', async ({ page }) => {
    await signIn(page, USERS.worker.email);
    await passNoticeGate(page);
    await page.goto('/signatures');
    await page.getByRole('tab', { name: 'Sent by me' }).click();
    await page.getByTestId('signature-list').getByRole('link', { name: TITLE }).click();
    await page.getByRole('link', { name: 'Open the document' }).click();
    await expect(page.getByTestId('versions')).toContainText('(signed).pdf');
    await expect(page.getByTestId('signatures-card')).toContainText('Signed');
  });
});
