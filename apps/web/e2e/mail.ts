import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';

/**
 * ADR 039: the API under test writes every e-mail as a JSON file (MAIL_TRANSPORT=file); the
 * browser tests read the real message, open its HTML and press its button, as a person would.
 */
export const MAIL_DIR = join(process.cwd(), '.e2e-mail');

export interface SentMail { to: string; subject: string; text: string; html?: string; sentAt: string }

export function clearMail(): void {
  rmSync(MAIL_DIR, { recursive: true, force: true });
}

export function mailsTo(to: string): SentMail[] {
  let files: string[];
  try { files = readdirSync(MAIL_DIR).sort(); } catch { return []; }
  return files.map((f) => JSON.parse(readFileSync(join(MAIL_DIR, f), 'utf8')) as SentMail).filter((m) => m.to.toLowerCase() === to.toLowerCase());
}

/** Waits for the `n`-th e-mail (1-based) to that address. */
export async function waitForMail(to: string, n = 1): Promise<SentMail> {
  await expect.poll(() => mailsTo(to).length, { message: `${n} e-mail(s) to ${to}`, timeout: 15_000 }).toBeGreaterThanOrEqual(n);
  return mailsTo(to)[n - 1]!;
}

/**
 * Shows the e-mail's HTML in the page, checks it has one button and the same plain link, both
 * pointing at the web app, and presses the button. The page then opens the link.
 */
export async function pressEmailButton(page: Page, mail: SentMail, buttonName: string): Promise<string> {
  expect(mail.html, 'the e-mail has an HTML part').toBeTruthy();
  // From a blank page, as from a mail program: pressing the button is a full page load even when the
  // browser is already on the same address (a link that differs only after # would not reload).
  await page.goto('about:blank');
  await page.setContent(mail.html!);
  const button = page.getByTestId('email-action');
  await expect(button).toHaveText(buttonName);
  const href = (await button.getAttribute('href'))!;
  await expect(page.getByTestId('email-link')).toHaveAttribute('href', href);
  expect(mail.text, 'the text part has the same link').toContain(`${buttonName}: ${href}`);
  expect(href.startsWith(process.env.E2E_WEB_URL ?? 'http://localhost:3100'), `the link uses APP_WEB_URL (${href})`).toBe(true);
  await button.click();
  await page.waitForURL((u) => u.href.startsWith(href.split('#')[0]!));
  return href;
}
