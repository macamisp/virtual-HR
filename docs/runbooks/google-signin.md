# Sign in with Google: creating the OAuth client and wiring it up

HRVO signs people in with Google through OpenID Connect (ADR 037): authorization code with PKCE,
`state` and `nonce`, scopes `openid email profile` only, the ID token verified against Google's
keys, and only Google-verified addresses accepted. You create the OAuth client yourself in Google
Cloud Console; HRVO never asks for, stores or logs a Google password.

## Where the values live (and where they never go)

The three settings `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` belong in
`.env` only (git-ignored, mode 600). Never put real values in `.env.example` (placeholders only),
in a commit, in a chat, in a ticket or in a log. The API reads them from the environment at start;
`npm run google:check` reports whether each is present without showing it, and CI runs gitleaks
over the whole history on every push. If a value was ever exposed, create a new client secret in
Google Cloud Console (Credentials → the client → **Add secret**), put it in `.env`, restart the
API and delete the old secret there.

## What to register (exact values)

| | Local development | Production (pattern) |
| --- | --- | --- |
| Authorised redirect URI | `http://localhost:3001/auth/google/callback` | `https://<api-host>/auth/google/callback` |
| Authorised JavaScript origin | `http://localhost:3000` | `https://<web-host>` |
| Calendar sync (ADR 023), if used | `http://localhost:3001/calendar/oauth/callback` | `https://<api-host>/calendar/oauth/callback` |

The redirect URI must equal `GOOGLE_REDIRECT_URI` in `.env` character for character (scheme,
host, port, path, no trailing slash). Google allows plain `http://` only for `localhost`; a LAN
address (docs/runbooks/lan-https.md) needs `https://192.168.x.x:3444/auth/google/callback`, and
Google refuses raw IP addresses in redirect URIs, so use a name (e.g. `hrvo.local`) or a tunnel.

`npm run google:check` prints these values for your `.env`, says whether the three settings are
present (never their values), and fetches Google's discovery document.

## Google Cloud Console, click by click

1. Open https://console.cloud.google.com/ and choose or create a project (top bar → project picker → **New project**).
2. **APIs & Services → OAuth consent screen** (in newer consoles: **Google Auth Platform → Branding**).
   - User type: **External** (anyone with a Google account) or **Internal** (your Google Workspace only).
   - App name `HRVO`, user support e-mail, developer contact e-mail → **Save and continue**.
   - Scopes: add `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` → **Save and continue**.
   - Test users: while the app's publishing status is **Testing**, only the addresses listed here
     can sign in; everyone else sees *Access blocked* and HRVO shows the "cancelled or Testing mode"
     message. Add your own address and your testers'. **Publish app** (Google Auth Platform →
     Audience → **Publish**) when you want everyone in.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   - Application type **Web application**, name `HRVO web`.
   - **Authorised JavaScript origins**: add the web address (`http://localhost:3000`).
   - **Authorised redirect URIs**: add `http://localhost:3001/auth/google/callback` (and the
     calendar one if you use calendar sync).
   - **Create**. Copy the **Client ID** and the **Client secret** (the secret is shown once; you
     can create another later).
4. In the HRVO folder, edit `.env` (not committed):

   ```
   GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-…
   GOOGLE_REDIRECT_URI=http://localhost:3001/auth/google/callback
   APP_WEB_URL=http://localhost:3000
   ```

5. `npm run google:check` → every line `OK`. Restart the API (`npm run api`).

## Who can sign in with Google

- **Existing account:** a Google account with the same address as the HRVO account, which must be
  verified on both sides. The first time, HRVO links the accounts (audit `GOOGLE_IDENTITY_LINKED`);
  afterwards Google's stable subject id is used.
- **Invited person:** on the invitation page, *Continue with Google instead*. The Google address
  must equal the invited address; the role comes from the invitation, never from the browser.
- **New visitor:** on the signup page, *Continue with Google* stays disabled until the workspace
  name is entered; it then creates the workspace and makes them its owner (2FA set-up follows for
  owners). No password and no verification e-mail are needed on this path.
- **Joining by domain** is off unless the owner switches it on under Workspace settings → Sign-in
  settings ("Let Google accounts on this domain join by themselves"); such people join as Member.
- **2FA:** owners, admins and HR still enter their code after Google unless the owner switched
  "Roles that need 2FA also need it after a Google sign-in" off.
- **Profile → Sign-in methods** shows Password and Google; Google can be linked or removed there,
  but never as the last remaining method.

Every Google login, link and refusal is in the audit log (`LOGIN_SUCCESS_GOOGLE`,
`GOOGLE_IDENTITY_LINKED`, `GOOGLE_IDENTITY_UNLINKED`, `GOOGLE_LOGIN_FAILED` with the reason).

## When something does not work

| What you see | Cause and fix |
| --- | --- |
| Google page: *Error 400: redirect_uri_mismatch* | The redirect URI in the console differs from `GOOGLE_REDIRECT_URI`. Copy the value `npm run google:check` prints into the console (exactly). |
| Google page: *Access blocked: HRVO has not completed the Google verification process* | The app is in Testing mode and your address is not a test user. Add it under OAuth consent screen → Test users, or publish the app. |
| HRVO: *Google did not sign you in: you cancelled, or the app is still in Testing mode…* | You pressed Cancel at Google, or the Testing-mode case above. |
| HRVO: *Google has not verified that e-mail address* | The Google account's address is unverified at Google. |
| HRVO: *uses a different e-mail address than the invitation* | Sign in with the Google account of the invited address, or ask for a new invitation. |
| HRVO: *No HRVO account uses that Google address* | Nobody with that address exists in a workspace; ask for an invitation or create a workspace. |
| HRVO: *Google's answer could not be verified* | ID token failed verification (signature, issuer, audience, expiry or nonce). Check the client id and the server clock. |
| HRVO: *Sign in with Google is not set up on this server* | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` missing; run `npm run google:check`. |

## Tests

`apps/api/test/google-signin-e2e.test.ts` and Playwright `32-google-signin.spec.ts` run against
a local fake provider (`apps/api/test/support/fake-google.ts`): success, wrong state, wrong nonce,
bad signature, expired token, wrong audience, unverified address, invitation mismatch, a role sent
by the client, replayed code, linking and unlinking, 2FA after Google, join-by-domain, tenant
isolation (the owner of one workspace cannot list or open people of another). CI never contacts
Google. Locally:

```
npm run verify -- --only=api          # all API suites, or:
npm test -- dist/apps/api/test/google-signin-e2e.test.js
npm run e2e -w @hrvo/web -- 31-workspace-signup.spec.ts 32-google-signin.spec.ts
npm run google:check                  # presence of the settings + Google's discovery document
podman run --rm -v "$PWD:/repo:ro,Z" ghcr.io/gitleaks/gitleaks:latest git /repo --redact   # or docker
```
