# Virtual-HR public landing page: release notes and root-domain deployment plan

Date: 2026-11-06. Branch: `feat/landing-page-2026-11-06` (from V3 `44ea7f3`, the deployed commit).
Decision record: [ADR 050](../adr/050-public-landing-page.md). Status: **local QA done; not deployed.**

## What it is

A public marketing page for `https://virtual-hr.site`, served by the existing web app:

- navigation (Features, How it works, Security, FAQ, Log in, Get started) with a phone menu;
- hero with the real office screenshot and calls to action into the app;
- twelve feature cards; three-step "How it works";
- product tour with real screenshots: attendance, smart time tracking, tasks, meetings, analytics;
- security and privacy section (verified statements only, see ADR 050 §6);
- FAQ (native disclosures), closing call to action, footer;
- SEO: title, description, canonical, Open Graph and Twitter card, robots.txt, sitemap.xml;
- light and dark themes, reduced-motion support, no horizontal scrolling at 390, 820 and 1440 px.

Log in and Get started open `https://app.virtual-hr.site/login` and `/signup`. Application
routing, authentication, the API and the database are unchanged.

## Local preview

With the repo's local setup (Postgres etc. are not needed for the page itself):

```sh
cd apps/web
npm run dev                       # or: NEXT_DIST_DIR=.next-landing npx next build && NEXT_DIST_DIR=.next-landing npx next start -p 3200
```

- Open `http://site.localhost:3000/`: the page as it appears on the root domain (browsers resolve
  `*.localhost` to this computer). Its Log in / Get started links open `http://localhost:3000`.
- Or open `http://localhost:3000/welcome` on the app host.
- `http://localhost:3000/` still opens the app (login, then attendance).

To check the production mapping without a browser:
`curl -sI -H 'Host: virtual-hr.site' http://localhost:3000/login` → `308` to
`https://app.virtual-hr.site/login`.

To refresh the screenshots after UI changes (synthetic e2e organisation; needs the e2e stack):
`npx playwright test --config playwright.landing-shots.config.ts` in `apps/web` (with the env the
other e2e specs use), review `test-results/landing-shots/`, copy the chosen files to
`src/app/welcome/shots/`.

## Screenshots

In [landing-page-2026-11-06/](landing-page-2026-11-06/): `desktop-light-first-screen.jpg`,
`mobile-light-first-screen.jpg`, full pages `desktop-light-full.jpg`, `desktop-dark-full.jpg`,
`tablet-light-full.jpg`, `mobile-light-full.jpg` (captured with reduced motion so every section is
shown; with motion, sections fade in as they scroll into view).

## Tests

Run locally on 2026-11-06 against the real API and Postgres (e2e stack under podman).

| Check | Result |
| --- | --- |
| `npm run lint` (repo + web) | PASS |
| `tsc --noEmit` (root) and `apps/web` typecheck | PASS |
| `next build` (production) | PASS; `/welcome` 8.8 kB, 112 kB first load (no app-page code) |
| New spec `e2e/41-landing.spec.ts` (11 tests) | PASS: app-host routing unchanged; marketing-host page, SEO tags, CTAs, no API calls, no page errors; production host mapping (308 to app, www → apex, HTTPS links); robots/sitemap; headings, alt text, skip link, landmarks; FAQ; 390/820/1440 px without sideways scroll; phone menu (link, Escape, focus return); reduced motion; `/welcome` preview |
| Full Playwright suite (regression, 41 specs) | PASS: 124 passed, 2 skipped (as before). First run: 94 passed, 8 media specs failed because the local LiveKit container was down (it needs Redis on 6379), and one landing test ran against a stale build. After starting Redis + LiveKit, those 9 files re-ran: 30/30 passed |
| Login / signup regression | PASS (specs 01, 31, 32, 33 in the full run; spec 41 checks `/`, `/login`, `/signup` on the app host) |
| axe-core 4.14 (WCAG 2.0/2.1 A + AA + best practice), desktop and phone, light and dark, FAQ and menu open | PASS: 0 violations. Hero text over the gradient (axe "needs review") computed by hand at the gradient's strongest point: body text 4.91:1 light / 5.20:1 dark, headings 11.9:1 / 10.4:1 |
| Manual review of screenshots (desktop, tablet, phone, light, dark) | PASS |

Not tested: real Safari / Firefox engines (Playwright Chromium only; scroll reveal is Chromium and
Safari 26 only and is decorative); the live root domain (not deployed).

## Root-domain deployment plan (needs separate approval)

Nothing below has been done. Each step is reversible.

### 0. Prerequisites

- PR approved and merged (after or together with PR #6; this branch contains V3 `44ea7f3`, which
  is what production runs, so the web image built from it changes only the landing page).
- CI green on the exact commit to deploy.
- Current state recorded: host checkout, web image tag, Cloudflare tunnel ingress and DNS records
  for `virtual-hr.site` and `www.virtual-hr.site` (including any existing redirect rule).

### 1. Ship the web image (no Cloudflare change yet)

- On the host, per `docs/runbooks/staging-ec2.md` §5: tag the current web image for rollback, check
  out the approved commit, rebuild **web only**, `up -d --no-deps web`. No migration (no database
  change), API, Postgres, Redis and storage untouched.
- Verify the app is unchanged: `https://app.virtual-hr.site/` → login; sign in; office loads.
- Verify the page before DNS: `https://app.virtual-hr.site/welcome` renders, and on the host
  `curl -sI -H 'Host: virtual-hr.site' http://127.0.0.1:<web port>/` → `200`,
  `.../login` → `308` to `https://app.virtual-hr.site/login`.

### 2. Route the root domain to the same web container (Cloudflare, operator step)

- In the existing Cloudflare tunnel, add public hostnames `virtual-hr.site` and
  `www.virtual-hr.site` pointing at the same service as `app.virtual-hr.site` (the web container).
  The tunnel creates the proxied DNS records.
- Remove or disable any existing redirect rule on `virtual-hr.site` that would override it.
- Keep SSL/TLS "Full (strict)" / "Always use HTTPS" as for the app host.
- No API change: the page makes no API calls, so `CORS_ORIGINS` stays as it is.

### 3. Verify live

- `https://virtual-hr.site/` shows the page; `https://www.virtual-hr.site/` → 308 to the apex;
  `https://virtual-hr.site/login` → 308 to the app login; Log in and Get started open the app.
- `https://virtual-hr.site/robots.txt` and `/sitemap.xml`; page source has canonical and `og:*`.
- Phone check (390 px), light and dark.
- App regression: login with 2FA, office, attendance badge.

### 4. Rollback

- Root domain only: remove the two public hostnames (or restore the previous redirect rule). The
  app is unaffected.
- Web image: retag the saved image to the live tag and `up -d --no-deps web`; check out the
  previous commit. No database restore is ever needed for this change.
