import { expect, test } from '@playwright/test';
import { ORG_ID, USERS, adminPool } from './fixtures';
import { passNoticeGate, signIn, signInAdmin, signOut } from './helpers';

/**
 * Subcontractor profiles in the browser (FR-ORG-002; ADR 033): the subcontractor fills in their
 * own contact, tax and bank details and sees them masked until they reveal them; they cannot
 * open HR's screens. An admin sees the profile masked, reveals it (audited) and edits identity.
 */
const ACCOUNT = '0071-2299-4471';

test.describe.serial('Subcontractor profile', () => {
  test.afterAll(async () => {
    const pool = adminPool();
    try { await pool.query(`DELETE FROM subcontractor_details WHERE org_id = $1`, [ORG_ID]); } finally { await pool.end(); }
  });

  test('the subcontractor fills in their own profile and sees tax and bank details masked until revealed', async ({ page }) => {
    await signIn(page, USERS.sub.email);
    await passNoticeGate(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'My contractor profile' }).click();
    await expect(page.getByLabel('Legal name')).toHaveAttribute('readonly', '');

    const contact = page.getByRole('form', { name: 'Contact details' });
    await contact.getByLabel('Phone').fill('+94 77 123 4567');
    await contact.getByRole('button', { name: 'Save contact details' }).click();
    await expect(page.getByText('Contact details saved.')).toBeVisible();

    const tax = page.getByRole('form', { name: 'Replace tax ID' });
    await tax.getByLabel('New tax ID').fill('LK-TIN-918273645');
    await tax.getByRole('button', { name: 'Save tax ID' }).click();
    await expect(page.getByText('Tax ID saved.')).toBeVisible();
    await expect(tax.getByLabel('New tax ID')).toHaveValue('', { timeout: 5000 });

    const bank = page.getByRole('form', { name: 'Replace bank details' });
    await bank.getByLabel('Account holder').fill('Sam Contractor');
    await bank.getByLabel('Bank', { exact: true }).fill('Ceylon Test Bank');
    await bank.getByLabel('Account number').fill(ACCOUNT);
    await bank.getByRole('button', { name: 'Save bank details' }).click();
    await expect(page.getByText('Bank details saved.')).toBeVisible();

    const masked = page.getByTestId('sensitive-masked');
    await expect(masked).toContainText('•••• 3645');
    await expect(masked).toContainText('Ceylon Test Bank •••• 4471');
    await expect(page.getByText(ACCOUNT)).toHaveCount(0);
    await page.getByRole('button', { name: 'Reveal tax and bank details' }).click();
    await expect(page.getByTestId('sensitive-clear')).toContainText(`account ${ACCOUNT}`);
    await page.getByRole('button', { name: 'Hide' }).click();
    await expect(page.getByTestId('sensitive-clear')).toHaveCount(0);

    await page.goto('/admin/subcontractors');
    await expect(page.getByTestId('access-denied')).toBeVisible();
    await signOut(page);
  });

  test('an admin sees the profile masked, reveals it, and edits the legal identity', async ({ page }) => {
    await signInAdmin(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Subcontractors' }).click();
    const row = page.getByTestId('subcontractors').getByRole('row').filter({ hasText: USERS.sub.name });
    await expect(row).toContainText('On file');
    await row.getByRole('link', { name: USERS.sub.name }).click();
    await expect(page.getByTestId('sensitive-masked')).toContainText('•••• 4471');
    await expect(page.getByText(ACCOUNT)).toHaveCount(0);
    await page.getByRole('button', { name: 'Reveal tax and bank details' }).click();
    await expect(page.getByTestId('sensitive-clear')).toContainText('LK-TIN-918273645');

    const identity = page.getByRole('form', { name: 'Identity' });
    await identity.getByLabel('Legal name').fill('Sam Contractor');
    await identity.getByLabel('Company').fill('Sam Builds (Pvt) Ltd');
    await identity.getByLabel('Country (ISO code)').fill('lk');
    await identity.getByRole('button', { name: 'Save identity' }).click();
    await expect(page.getByText('Identity saved.')).toBeVisible();

    const pool = adminPool();
    try {
      const reveals = (await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = 'SUBCONTRACTOR_SENSITIVE_READ' AND entity_id = $2`, [ORG_ID, USERS.sub.id])).rows[0].n;
      expect(reveals).toBe(2); // Sam's own reveal and the admin's
      const row2 = (await pool.query(`SELECT legal_name, country, tax_id_enc IS NOT NULL AS tax FROM subcontractor_details WHERE user_id = $1`, [USERS.sub.id])).rows[0];
      expect(row2).toEqual({ legal_name: 'Sam Contractor', country: 'LK', tax: true });
    } finally { await pool.end(); }
    await signOut(page);
  });
});
