import { expect, test, type Browser, type Page } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

/**
 * SRS 8.2: the tracking status is always in the header. On a phone it once wrapped onto three
 * lines (V3 release candidate, D2). At every width: one line, nothing overlaps, no sideways
 * scrolling; the full wording stays available to screen readers; the desktop header is unchanged.
 */
const WIDTHS = [
  { width: 320, height: 640, phone: true },
  { width: 360, height: 740, phone: true },
  { width: 390, height: 844, phone: true },
  { width: 640, height: 900, phone: false },
  { width: 768, height: 1024, phone: false },
  { width: 1024, height: 768, phone: false },
  { width: 1440, height: 900, phone: false },
] as const;

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function open(browser: Browser, w: (typeof WIDTHS)[number]): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: w.width, height: w.height }, ...(w.phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  await signIn(page, USERS.worker.email);
  await passNoticeGate(page);
  return page;
}

/** The header checks shared by every width and state. */
async function headerFits(page: Page, width: number): Promise<void> {
  const badge = page.getByTestId('tracking-badge');
  await expect(badge).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'no sideways scrolling').toBe(true);
  const b = (await badge.boundingBox())!;
  // One line: the badge is as tall as one line of its text plus its padding and border.
  const oneLine = await badge.evaluate((el) => { const s = getComputedStyle(el); return parseFloat(s.lineHeight) + parseFloat(s.paddingTop) + parseFloat(s.paddingBottom) + 2; });
  expect(b.height, 'the badge is one line').toBeLessThanOrEqual(oneLine + 0.5);
  expect(b.x + b.width, 'inside the screen').toBeLessThanOrEqual(width);
  const others = [page.getByTestId('notification-bell'), page.getByRole('button', { name: 'Sign out' }), page.getByTestId('app-name'), page.getByTestId('office-presence')];
  for (const o of others) {
    if (!(await o.isVisible())) continue;
    const ob = (await o.boundingBox())!;
    expect(overlaps(b, ob), 'the badge overlaps nothing').toBe(false);
    expect(ob.x + ob.width, 'header controls inside the screen').toBeLessThanOrEqual(width);
  }
}

test.describe('Header tracking badge at every width (SRS 8.2)', () => {
  for (const w of WIDTHS) {
    test(`${w.width} px: one line, no overlap, full wording for screen readers`, async ({ browser }) => {
      const page = await open(browser, w);
      try {
        const badge = page.getByTestId('tracking-badge');
        // The full wording is always in the badge (read by screen readers); on a phone a short form is shown.
        await expect(badge).toContainText(/Tracking: Active since \d{2}:\d{2}/);
        await headerFits(page, w.width);
        const short = badge.getByTestId('tracking-badge-short');
        if (w.width < 640) {
          await expect(short).toBeVisible();
          // What is shown (innerText skips the time hidden below 360 px).
          await expect.poll(() => short.innerText()).toMatch(w.width >= 360 ? /^Active · \d{2}:\d{2}$/ : /^Active$/);
          await expect(short).toHaveAttribute('aria-hidden', 'true');
        } else {
          await expect(short).toBeHidden();
          await expect(badge.getByText(/^Tracking: Active since \d{2}:\d{2}$/)).toBeVisible();
          await expect(page.getByTestId('app-name')).toBeVisible();
        }
        if (w.width === 1440) await expect(page.getByTestId('current-user')).toBeVisible();
        await page.screenshot({ path: test.info().outputPath(`header-${w.width}.png`) });

        // The widest case: in the office but on another page (the office icons join the header),
        // and the connection lost (the longest status).
        await page.goto('/office');
        await expect(page.getByTestId('office-canvas')).toHaveAttribute('data-connected', 'true');
        const menu = page.getByRole('button', { name: 'Toggle navigation' });
        if (await menu.isVisible()) await menu.click(); // below 768 px the navigation is behind the menu
        await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Tasks', exact: true }).click();
        await expect(page.getByTestId('office-presence')).toBeVisible();
        await headerFits(page, w.width);
        await page.context().setOffline(true);
        // The heartbeat notices the drop on its own schedule (spec 02 allows the same 50 s).
        await expect(badge).toContainText('Reconnecting… tracking paused', { timeout: 50_000 });
        await headerFits(page, w.width);
        await page.screenshot({ path: test.info().outputPath(`header-${w.width}-reconnecting.png`) });
        await page.context().setOffline(false);
      } finally {
        await page.context().close();
      }
    });
  }
});
