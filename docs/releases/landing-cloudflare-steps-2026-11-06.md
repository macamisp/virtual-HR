# Landing page: Cloudflare steps for the console operator (Phase C), 2026-11-06

Written for: the person or agent with Cloudflare dashboard access to the `virtual-hr.site` zone.
Claude had no Cloudflare access, so none of this has been done.

**State before you start:**
- The web container on EC2 `i-084a36f551ca3a72c` already runs commit `a9b6714`. It serves the
  landing page whenever a request arrives with `Host: virtual-hr.site`.
- `https://app.virtual-hr.site` and `https://api.virtual-hr.site` are unchanged.
- The tunnel is the existing named tunnel **`virtual-hr-staging`**, dashboard-managed (cloudflared
  runs with a token on the host), so hostname routes can only be changed in the dashboard.

Do not create a new tunnel, a load balancer or any paid feature. Free plan only.

## C0. Record the current state (screenshots or notes)

1. **Zero Trust → Networks → Tunnels → `virtual-hr-staging` → Configure → Public Hostnames.**
   Write down every row (hostname, path, service). For the `app.virtual-hr.site` row, open
   *Additional application settings → HTTP Settings* and write down **HTTP Host Header** (expected:
   empty) and any other non-default setting.
2. **DNS → Records**: the records named `virtual-hr.site` (apex). Today they are proxied A/AAAA
   records; note type, content and proxy status. Note that there is **no `www` record**.
3. **Rules**: find the rule that answers `virtual-hr.site/*` with
   `301 https://app.virtual-hr.site/`. Look in *Rules → Redirect Rules* (single redirects), *Rules →
   Page Rules*, or *Bulk Redirects*. Write down its name, type and expression.

## C1. Route the apex to the same web service

1. In **DNS → Records**, delete the apex A/AAAA records you recorded in C0.2. The tunnel needs the
   name for its own CNAME, and the dashboard refuses the hostname while they exist. The edge 301
   stops working at this moment, so do step 2 straight away.
2. **Tunnels → `virtual-hr-staging` → Public Hostnames → Add a public hostname:**
   - Subdomain: *(empty)*. Domain: `virtual-hr.site`. Path: *(empty)*.
   - Service: **exactly the same type and URL as the `app.virtual-hr.site` row** (for example
     `HTTP` → `localhost:3000`).
   - Additional application settings → HTTP Settings → **HTTP Host Header: leave empty.** The
     original `Host: virtual-hr.site` must reach Next.js, because the landing page is chosen by
     host name.
   - Save. The dashboard creates a proxied CNAME `virtual-hr.site → <tunnel-id>.cfargotunnel.com`.
     CNAME flattening at the apex is free.
3. **Disable (do not delete)** the redirect rule from C0.3: toggle it off. For a Bulk Redirect,
   disable the rule that uses the list, and leave the list in place.

## C2. `www` → apex (free, optional)

Add one more public hostname on the same tunnel: Subdomain `www`, Domain `virtual-hr.site`, the
same service as above, HTTP Host Header empty. The app itself answers
`308 https://virtual-hr.site/<path>` for `www` (tested). This needs no redirect rule and no extra
cost.

## C3. Cache

*Caching → Configuration → Purge Cache → Custom purge → URL*: `https://virtual-hr.site/` and
`http://virtual-hr.site/`. Not strictly needed, because edge redirects are not cached, but it is
harmless.

## C4. Tell Claude "Cloudflare done"

Claude then runs the live verification (Phase D):
- `virtual-hr.site` shows the page;
- Log in and Get started reach the app;
- `www` redirects to the bare domain;
- no redirect loops;
- app, API and office are unchanged;
- phone layout and assets load.

## Rollback (root domain only, seconds; the app is unaffected)

1. Tunnels → `virtual-hr-staging` → Public Hostnames: delete the `virtual-hr.site` (and `www`)
   rows. This leaves the `app.` and `api.` rows untouched.
2. DNS → Records: delete the apex CNAME if it is still there, and recreate the apex A/AAAA
   records exactly as recorded in C0.2 (proxied).
3. Re-enable the redirect rule from C0.3.
4. Check: `curl -sI https://virtual-hr.site/` → `301 location: https://app.virtual-hr.site/`.

## Notes

- If the `app.virtual-hr.site` row has an HTTP Host Header override, stop: copying it to the new
  row would send the app instead of the landing page. Tell Claude what it is set to.
- Cloudflare Web Analytics injects `static.cloudflareinsights.com/beacon.min.js` into proxied
  pages. The app's CSP blocks it on every page, including the existing app login, so it is a
  pre-existing console error with no functional effect. Leave it, or turn off automatic Web
  Analytics injection for the zone.
- Browsers that followed the old 301 may have cached it, because it had no `Cache-Control`. They
  keep landing on the app until their cache is cleared. New visitors and search engines see the
  page.
