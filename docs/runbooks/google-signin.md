# Sign in with Google: creating the OAuth client

HRVO signs people in with Google through OpenID Connect (ADR 037). One Google OAuth client serves
both sign-in and calendar sync. Nothing works until its id and secret are in the environment.

## 1. Create the client (once per environment)

1. Open [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
   and pick (or create) a project.
2. If asked, configure the **OAuth consent screen**: user type *External* (or *Internal* for a
   Google Workspace organisation), app name "HRVO", support and developer e-mail addresses.
   Scopes: `openid`, `email`, `profile` (sign-in). Calendar sync additionally needs
   `calendar.events` and `calendar.freebusy` (ADR 023). While the app is in *Testing*, only the
   listed test users can sign in; publish it for everyone else.
3. **Create credentials → OAuth client ID → Web application.**
   - Authorised JavaScript origins: the web app's address, e.g. `http://localhost:3000`,
     `https://192.168.1.20:3443` (LAN HTTPS) or `https://app.example.com`.
   - Authorised redirect URIs: the API's callback, e.g. `http://localhost:3001/auth/google/callback`,
     and for calendar sync `http://localhost:3001/calendar/oauth/callback`. Use the exact scheme,
     host and port that `GOOGLE_SIGNIN_REDIRECT_URL` and `CALENDAR_OAUTH_REDIRECT_URL` carry.
4. Copy the **Client ID** and **Client secret**.

## 2. Configure HRVO

In `.env` (never in code):

```
GOOGLE_OAUTH_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-...
GOOGLE_SIGNIN_REDIRECT_URL=http://localhost:3001/auth/google/callback
APP_WEB_URL=http://localhost:3000
```

Restart the API. The sign-in, signup and invitation pages show "Continue with Google"; without
the id and secret the button explains that Google sign-in is not set up.

## 3. Who can sign in with Google

- Someone whose HRVO account has the same **verified** e-mail address as the Google account. The
  first Google sign-in links the account; later ones use Google's stable subject.
- Someone accepting an **invitation**: the Google address must equal the invited address.
- Someone creating a **workspace**: they become its owner, no e-mail verification needed.
- Anyone on a domain the owner allowed under Workspace settings → "Let Google accounts on this
  domain join by themselves" (they join as Member). Off by default.

Owners, admins and HR still enter their 2FA code after Google unless the owner switched
"Roles that need 2FA also need it after a Google sign-in" off.

## 4. Checks

- `apps/api/test/google-signin-e2e.test.ts` exercises the whole flow against a fake Google.
- Google's error pages mean a mismatch between the redirect URI in the console and
  `GOOGLE_SIGNIN_REDIRECT_URL`; HRVO's own outcomes come back as `?sso=error&code=…` on the sign-in
  page with a readable message.
