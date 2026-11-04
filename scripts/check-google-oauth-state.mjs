/**
 * Browser diagnostic for FR-AUTH-005 / ADR 040 / ADR 042. Uses the real web button and API,
 * stops before Google sign-in, then simulates consent cancellation. No credentials,
 * token exchange, account creation or session creation. Logs attributes/results only.
 * Usage: node scripts/check-google-oauth-state.mjs <web-origin> <api-origin> [block-third-party-cookies]
 * The optional third argument makes Chromium refuse third-party cookies, as private windows,
 * Safari and Firefox do: the setting that broke the earlier fetch-started flow (ADR 042).
 *
 * The sign-in now starts with a top-level navigation to the API (ADR 042). `state` is read from
 * the Set-Cookie-bearing 302's Location header; the navigation on to Google is aborted, so no
 * Google page loads and no sign-in is possible here.
 */
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const [web, api, thirdParty] = process.argv.slice(2);
if (!web || !api) throw new Error('Provide the web origin and API origin');
const blockThirdPartyCookies = thirdParty === 'block-third-party-cookies';
const browser = await chromium.launch();
let stage = 'opening login';
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  if (blockThirdPartyCookies) {
    await cdp.send('Network.setCookieControls', { enableThirdPartyCookieRestriction: true, disableThirdPartyCookieMetadata: true, disableThirdPartyCookieHeuristics: true });
  }
  const blockedReasons = new Set();
  const requestUrls = new Map();
  let callbackCookieSent = false;
  let state;
  const authorized = { resolve: null };
  const authorization = new Promise((resolve) => { authorized.resolve = resolve; });
  cdp.on('Network.requestWillBeSent', (event) => {
    requestUrls.set(event.requestId, event.request.url);
    // The onward request to Google carries this attempt's state; CDP sees it before routing aborts it.
    if (!state && event.request.url.startsWith('https://accounts.google.com/')) {
      const seen = new URL(event.request.url).searchParams.get('state');
      if (seen) { state = seen; authorized.resolve(); }
    }
  });
  cdp.on('Network.responseReceivedExtraInfo', (event) => {
    for (const entry of event.blockedCookies ?? []) {
      if (entry.cookieLine?.startsWith('hrvo_oauth=')) {
        for (const reason of entry.blockedReasons) blockedReasons.add(reason);
      }
    }
  });
  cdp.on('Network.requestWillBeSentExtraInfo', (event) => {
    if (requestUrls.get(event.requestId)?.startsWith(`${api}/auth/google/callback`)) {
      callbackCookieSent = /(?:^|;\s*)hrvo_oauth=/.test(event.headers.Cookie ?? event.headers.cookie ?? '');
    }
  });
  // Do not load Google: abort the onward navigation once the state is known.
  void page.route('https://accounts.google.com/**', (route) => route.abort());
  await page.goto(`${web}/login`);
  stage = 'starting authorization';
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  let timeout;
  try {
    await Promise.race([authorization, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Authorization navigation not observed')), 30_000);
    })]);
  } finally { clearTimeout(timeout); }
  stage = 'checking the callback';
  if (!state) throw new Error('Authorization state not present');
  const cookies = (await context.cookies(`${api}/auth/google/callback`)).filter((cookie) => cookie.name === 'hrvo_oauth');
  await page.goto(`${api}/auth/google/callback?${new URLSearchParams({ state, error: 'access_denied' })}`);
  const result = new URL(page.url());
  const passed = cookies.length === 1 && callbackCookieSent && blockedReasons.size === 0 && result.searchParams.get('code') === 'denied';
  console.log(JSON.stringify({
    passed, thirdPartyCookies: blockThirdPartyCookies ? 'blocked' : 'allowed', blockedReasons: [...blockedReasons], callbackCookieSent,
    cookies: cookies.map(({ domain, path, httpOnly, secure, sameSite, partitionKey }) => ({ domain, path, httpOnly, secure, sameSite, partitionKey })),
    callbackResult: result.searchParams.get('code'),
    fullGoogleLoginVerified: false,
  }, null, 2));
  if (!passed) process.exitCode = 1;
} catch {
  // Browser errors may contain authorization URLs. Do not print the error or stack.
  console.error(`OAuth cookie diagnostic could not complete while ${stage}; inspect the browser manually without sharing sensitive values.`);
  process.exitCode = 1;
} finally { await browser.close(); }
