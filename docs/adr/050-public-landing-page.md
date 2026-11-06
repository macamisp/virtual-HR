# ADR 050: Public landing page on the root domain, served by the web app

Date: 2026-11-06. Status: proposed (built and tested locally; root-domain deployment needs approval).
Related: ADR 006 (web app, CSP), ADR 037 (self-service signup), ADR 046 (single-EC2 staging).

## Context

`https://app.virtual-hr.site` is the application and `https://api.virtual-hr.site` its API. The
root domain `https://virtual-hr.site` should get a public marketing page that explains the product
and sends people to the existing login and signup pages. Application routing, authentication, the
API and the database must not change. No new npm packages and no paid services.

## Decision

1. **Same Next.js app, its own route.** The page is `apps/web/src/app/welcome` (server component,
   static content, no API calls, no cookies, no user data). It reuses Tailwind, the app's colour
   tokens (light and dark), `lucide-react` and `next/image`. A separate app or static site would
   need a second build, image and deploy unit for one page.
2. **Host-based routing in the middleware.** `src/lib/site.ts` lists the marketing hosts:
   `virtual-hr.site`, `www.virtual-hr.site` (308 to the apex) and `site.localhost` (local preview).
   On those hosts only:
   - `/` is rewritten to `/welcome`; `/robots.txt` and `/sitemap.xml` to the page's route handlers;
   - paths under `/welcome` (icon) are served;
   - every other path is a 308 redirect to the same path on `https://app.virtual-hr.site`, so an old
     `virtual-hr.site/login` bookmark still works.

   Every other host (the app, LAN addresses, localhost) skips this code: `/` still redirects to
   `/attendance`, and login, signup, workspace routing and the API are unchanged. The existing CSP
   is applied to the landing page as to every page.
3. **Links into the app.** Built per request from the Host header: on a production marketing host
   always `https://app.virtual-hr.site/login` and `/signup` (HTTPS regardless of proxy headers); at
   `/welcome` on the app host, same-origin `/login` and `/signup`.
4. **Local preview does not redirect other paths.** Next.js turns a middleware redirect whose
   origin equals the server's own address (`http://localhost:<port>`) into a relative one, which on
   `site.localhost` loops. The preview therefore serves other paths directly. Production is not
   affected: the server's own address is internal, never `app.virtual-hr.site`; the e2e test checks
   the production mapping with `Host: virtual-hr.site`.
5. **Screenshots are real.** `apps/web/e2e-capture/landing-shots.spec.ts` (own config,
   `playwright.landing-shots.config.ts`, not part of the suite) drives the app against the synthetic
   e2e organisation and creates every record through the UI. The images are static imports, so they
   are served from `/_next/static` (the web Dockerfile copies no `public/` folder). The page says
   "Screens from the Virtual-HR app with sample data".
6. **Claims.** Only statements backed by code or ADRs: 2FA required for super admin, admin and HR
   manager (FR-AUTH-004); Argon2id and the breached-password check (k-anonymity in production);
   PostgreSQL RLS per workspace; envelope-encrypted documents that are not downloadable until a
   ClamAV scan is clean (ADR 009); audit log; no screenshots, keystroke content or webcam capture
   (SRS §11); recording optional, off by default, with consent (ADR 024). No testimonials, usage
   figures, certifications, guarantees or prices.
7. **Motion and accessibility.** Scroll reveal uses CSS scroll-driven animations inside
   `prefers-reduced-motion: no-preference` and `@supports (animation-timeline: view()) and
   (animation-range: entry)`, as decoration only (no script fallback; content is visible without
   it). The FAQ is native `<details name="faq">` (searchable, works without JavaScript); the phone
   menu is a `<details>` disclosure, closed by link choice, Escape or an outside click. Skip link,
   one `h1`, ordered headings, labelled navigation landmarks, descriptive alt text.
8. **SEO.** Title, description, canonical `https://virtual-hr.site`, Open Graph and Twitter card
   (the office screenshot), robots.txt and a one-URL sitemap on the marketing host.

## Consequences

- Deploying the page is a web image rebuild; going live on the root domain additionally needs a
  Cloudflare hostname for `virtual-hr.site` (and `www`) pointing at the same web container. That is
  an operator step and is not done by this change (see docs/releases/landing-page-2026-11-06.md).
- The API needs no CORS change: the page makes no API calls.
- `/welcome` is also reachable on the app host (the canonical link points search engines at the
  root domain).
- Screenshots go stale when the UI changes; re-run the capture spec and copy the images.
