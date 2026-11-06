import { expect, test, type Page } from '@playwright/test';

/**
 * ADR 050: the public landing page. Served at / on a marketing host (site.localhost stands in for
 * virtual-hr.site: browsers resolve *.localhost to this computer) and at /welcome on the app host.
 * The application's own routing must not change.
 */
const WEB_PORT = 3100;
const API_PORT = 3101;
const SITE = `http://site.localhost:${WEB_PORT}`;
const APP = `http://localhost:${WEB_PORT}`;

async function noHorizontalScroll(page: Page): Promise<void> {
  const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll, 'no horizontal page scroll').toBeLessThanOrEqual(client + 1);
}

test.describe('Landing page (ADR 050)', () => {
  test('the app host keeps its routing: / still goes into the app, login and signup unchanged', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await page.goto('/signup');
    await expect(page.getByText('Create your workspace').first()).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  });

  test('the marketing host shows the page with SEO metadata, and its CTAs open the app', async ({ page }) => {
    const errors: string[] = [];
    const apiCalls: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { if (new URL(r.url()).port === String(API_PORT)) apiCalls.push(r.url()); });

    await page.goto(`${SITE}/`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Your team.s office, online/);
    await expect(page).toHaveTitle(/Virtual-HR/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://virtual-hr.site');
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /Virtual-HR/);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /^https:\/\/virtual-hr\.site\/_next\/static\/media\/office\./);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /virtual office|office/i);

    const header = page.getByRole('banner');
    await expect(header.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', `${APP}/login`);
    await expect(header.getByRole('link', { name: 'Get started' })).toHaveAttribute('href', `${APP}/signup`);
    for (const name of ['Features', 'How it works', 'Security', 'FAQ']) {
      await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name })).toBeVisible();
    }
    // Every link into the app points at the app host's login or signup page.
    const appHrefs = await page.locator('a[href^="http"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(new Set(appHrefs)).toEqual(new Set([`${APP}/login`, `${APP}/signup`]));

    await page.getByRole('link', { name: 'Create your workspace' }).click();
    await expect(page).toHaveURL(`${APP}/signup`);
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();

    expect(errors, 'no uncaught errors').toEqual([]);
    expect(apiCalls, 'the landing page makes no API calls').toEqual([]);
  });

  test('on virtual-hr.site other paths go to the app and www goes to the apex; robots.txt and sitemap.xml are served', async ({ page, request }) => {
    const asProduction = (host: string, path: string) =>
      request.get(`${APP}${path}`, { headers: { Host: host, 'X-Forwarded-Proto': 'https' }, maxRedirects: 0 });
    const login = await asProduction('virtual-hr.site', '/login?from=site');
    expect(login.status()).toBe(308);
    expect(login.headers()['location']).toBe('https://app.virtual-hr.site/login?from=site');
    const www = await asProduction('www.virtual-hr.site', '/');
    expect(www.status()).toBe(308);
    expect(www.headers()['location']).toBe('https://virtual-hr.site/');
    // Links stay on HTTPS even if the proxy does not say the request was HTTPS.
    const plain = await request.get(`${APP}/`, { headers: { Host: 'virtual-hr.site' }, maxRedirects: 0 });
    expect(await plain.text()).toContain('href="https://app.virtual-hr.site/login"');
    const home = await asProduction('virtual-hr.site', '/');
    expect(home.status()).toBe(200);
    expect(await home.text()).toContain('href="https://app.virtual-hr.site/signup"');
    // The app host itself is untouched by the marketing rules.
    const app = await request.get(`${APP}/`, { maxRedirects: 0 });
    expect(app.status()).toBe(307);
    expect(app.headers()['location']).toMatch(/\/attendance$/);

    await page.goto(`${SITE}/robots.txt`);
    await expect(page.locator('body')).toContainText('Sitemap: https://virtual-hr.site/sitemap.xml');
    const sitemap = await request.get(`${APP}/welcome/sitemap.xml`);
    expect(sitemap.headers()['content-type']).toContain('application/xml');
    expect(await sitemap.text()).toContain('<loc>https://virtual-hr.site/</loc>');
  });

  test('accessibility structure: one h1, ordered headings, alt text, skip link, labelled landmarks', async ({ page }) => {
    await page.goto(`${SITE}/`);
    await expect(page.locator('h1')).toHaveCount(1);
    const levels = await page.locator('h1, h2, h3, h4, h5, h6').evaluateAll((hs) => hs.map((h) => Number(h.tagName[1])));
    for (let i = 1; i < levels.length; i++) expect(levels[i]! - levels[i - 1]!, `heading ${i} does not skip a level`).toBeLessThanOrEqual(1);
    const alts = await page.locator('main img').evaluateAll((imgs) => imgs.map((i) => i.getAttribute('alt') ?? ''));
    expect(alts.length).toBeGreaterThanOrEqual(6);
    for (const alt of alts) expect(alt.length, 'every screenshot has a description').toBeGreaterThan(20);

    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toHaveAttribute('href', '#main');
    await expect(page.locator('main#main')).toHaveCount(1);
    await expect(page.getByRole('banner')).toHaveCount(1);
    await expect(page.getByRole('contentinfo')).toHaveCount(1);
  });

  test('FAQ answers open one at a time and are in the page text', async ({ page }) => {
    await page.goto(`${SITE}/`);
    const faq = page.locator('#faq details');
    await expect(faq).toHaveCount(7);
    await faq.nth(1).locator('summary').click();
    await expect(faq.nth(1)).toHaveAttribute('open', '');
    await expect(faq.nth(1)).toContainText('No screenshots, keystroke content');
    await faq.nth(2).locator('summary').click();
    await expect(faq.nth(2)).toHaveAttribute('open', '');
    await expect(faq.nth(1)).not.toHaveAttribute('open', '');
  });

  for (const [label, width, height] of [['phone', 390, 844], ['tablet', 820, 1180], ['desktop', 1440, 900]] as const) {
    test(`fits a ${label} screen without sideways scrolling`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto(`${SITE}/`);
      await noHorizontalScroll(page);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    });
  }

  test('phone menu: opens, a link closes it and scrolls to the section, Escape closes it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${SITE}/`);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
    const menu = page.locator('summary[aria-label="Menu"]');
    await menu.click();
    const mobile = page.getByRole('navigation', { name: 'Mobile' });
    await expect(mobile).toBeVisible();
    await expect(mobile.getByRole('link', { name: 'Get started' })).toHaveAttribute('href', `${APP}/signup`);
    await mobile.getByRole('link', { name: 'Security' }).click();
    await expect(mobile).toBeHidden();
    await expect(page).toHaveURL(/#security$/);
    await expect(page.getByRole('heading', { name: 'Built for records people can trust' })).toBeInViewport();

    await menu.click();
    await expect(mobile).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(mobile).toBeHidden();
    await expect(menu).toBeFocused();
  });

  test('reduced motion: every section is visible without scrolling animations', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(`${SITE}/`);
    const opacities = await page.locator('#features li, #security li').evaluateAll((els) => els.map((e) => getComputedStyle(e).opacity));
    expect(new Set(opacities)).toEqual(new Set(['1']));
    await ctx.close();
  });

  test('the preview at /welcome on the app host links to the same app host', async ({ page }) => {
    await page.goto('/welcome');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('banner').getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
  });
});
