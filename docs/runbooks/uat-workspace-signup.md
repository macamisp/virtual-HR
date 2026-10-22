# Click-through: workspace signup, owner, invitations and roles (ADR 037)

What to click, as whom, and what you should see. Fifteen minutes with two browsers (or one
normal and one private window). Requirement ids: FR-AUTH-001, 005, 006, 009; FR-ORG-001, 009.

## Before you start

```bash
docker compose up -d            # or podman compose up -d
npm run api                     # terminal 1
npm run web                     # terminal 2 (http://localhost:3000)
```

Set `MAIL_TRANSPORT=smtp` in `.env` so e-mails land in Mailhog (http://localhost:8025, started by
compose); the in-memory transport keeps them inside the API process. The steps below read the
verification and invitation links from Mailhog.

Google sign-in needs `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` (docs/runbooks/google-signin.md); skip
the Google steps otherwise.

## 1. Create a workspace (browser A)

1. Open http://localhost:3000/login → **New here? Create a workspace**.
2. Workspace name `Blue Harbour`, your name, an e-mail you can read in Mailhog, a 12+ character
   password. **Create workspace** → "Check your e-mail".
3. Try to sign in now: the error says *Verify your e-mail address first* with a **Send it again** link.
4. Open Mailhog → "Verify your e-mail for Blue Harbour on HRVO" → click the link → "E-mail verified" → **Sign in**.
5. Sign in. Owners need 2FA: scan the QR code, enter the code, **Verify and enable**, tick the recovery-codes box, **Continue**.
6. Accept the monitoring notice. You land on **Set up your workspace** (step 1 of 3).
7. Company name, time zone (e.g. Europe/Berlin), untick Saturday/Sunday → **Save and continue**.
8. Step 2: invite `member@example.com` as **Member** → the green confirmation → **Finish setup** → **Open HRVO**.
9. The left navigation shows, under Administration: **Users, Invitations, Workspace settings, Roles and permissions, Audit log** and more.

Expected in the audit log (Administration → Audit log): `WORKSPACE_CREATED`, `EMAIL_VERIFIED`,
`2FA_ENABLED`, `ORG_PROFILE_UPDATED`, `INVITATION_CREATED`.

## 2. Invitations

1. Administration → **Invitations**: the pending invitation for member@example.com, invited by you, expiry in 7 days.
2. **Resend** → a second e-mail in Mailhog; the first link now says *invalid*.
3. **Revoke** → status *revoked*; the link says *revoked*. Invite the address again (a fresh e-mail).

## 3. Accept as the member (browser B, private window)

1. Open the link from the newest e-mail → name, password → **Create account** → **Sign in**.
2. Sign in, accept the notice. Navigation shows My attendance, Tasks, Timesheets, Documents, Meetings, Chat; **no** Live board and **no** Administration section.
3. Type http://localhost:3000/admin/users by hand → "not available" page; the API answers 403 (Network tab).
4. **My profile** (left navigation): job title `Developer` → Save. Nothing else changes.

## 4. Role change takes effect at once (browser A)

1. Administration → **Users**: the member row shows *Member*, job title *Developer*, status *active*.
2. **Roles and permissions** → People → "Role for <member>" → **Team lead** → **Apply**.
3. Browser B: click anything → you are back at the sign-in page (session ended). Sign in again:
   **Live board** is now in the navigation; Administration still is not.
4. Browser A → Users → **Effective access** on the member: "✓ Live board (team or everyone)",
   "✗ Administration: roles and permissions", and every permission with a one-line description.

## 5. Custom role with a removed permission (browser A)

1. Roles and permissions → **New custom role**: name `Lead without documents`, based on *Team lead*, untick **Use documents**. The preview shows "✗ Documents". **Create role**.
2. Assign it to the member (People → Change to → the custom role → Apply).
3. Browser B (no re-login needed): open **Documents** → "permission" error; the link disappears from the navigation on the next load.

## 6. Escalation attempts fail (browser A, as the owner; optionally a second admin)

1. Roles → New custom role based on *Admin*, tick **Workspace ownership** → the API refuses: *Workspace ownership cannot be granted through a role*.
2. People → your own row: "You cannot change your own role".
3. Users → your own row: "You cannot change your own status".
4. Make someone an **Admin**, sign in as them: on the Users page the owner's row says "Only an owner can change an owner"; the Roles page refuses *Owner* for anyone (403 from the API).

## 7. Suspend, reactivate, offboard (browser A)

1. Users → member → **Suspend** → confirm. Browser B is signed out at once and cannot sign in ("Account is not active").
2. **Reactivate** → browser B can sign in again.
3. **Offboard…** → choose who takes over the tasks → **Confirm offboarding**. Status *offboarded*, final (no Reactivate). Audit: `USER_OFFBOARDED`.

## 8. Ownership (browser A and a second owner candidate)

1. Users → **Ownership** card: you are listed; "Transfer ownership to" an active person, confirm with your password → "The new owner has been e-mailed. Nothing changes until they accept."
2. Sign in as that person → Users page shows the yellow offer → **Accept ownership**. Both of you are signed out (sessions refreshed).
3. Sign in again: the new owner is *Owner*; the previous owner is *Admin* (unless "Keep my ownership too" was ticked).
4. As the only owner, try **Remove ownership…** on yourself: refused, *The last owner cannot be removed or demoted*.

## 9. One address, two workspaces

1. Create a second workspace with the **same** e-mail address (browser B, signed out).
2. Sign in with that address: after the password, a **Workspace** drop-down appears; pick one → **Open workspace**.

## 10. Google

Create the OAuth client first: docs/runbooks/google-signin.md has the exact Google Cloud Console
clicks (consent screen, test users, Web application client, redirect URI
`http://localhost:3001/auth/google/callback`, JavaScript origin `http://localhost:3000`). Put the
id, secret and redirect URI in `.env`, run `npm run google:check` (all `OK`), restart the API.

1. Sign-in page → **Continue with Google** with the owner's Google account (same address as the HRVO account) → Google's account chooser → back at HRVO: 2FA code → signed in. Audit: `GOOGLE_IDENTITY_LINKED`, `LOGIN_SUCCESS_GOOGLE`.
2. **My profile → Sign-in methods** shows *Password: set* and *Google: linked (address)*. **Remove Google** works (a password remains); **Link Google** adds it back.
3. Invitation page → **Continue with Google instead** with a different Google address → *uses a different e-mail address than the invitation*. The invitation stays pending.
4. Signup page → workspace name → **Continue with Google** → a workspace is created at once (no verification e-mail), 2FA setup follows. On that owner's profile, **Remove Google** is refused: *Google is your only way to sign in*.
5. Workspace settings (owner) → "Let Google accounts on this domain join by themselves" = your domain → a colleague on that domain signs in with Google without an invitation and becomes a Member. Switch it off again.
6. Press **Cancel** on Google's page → HRVO explains: cancelled, or the app is in Testing mode and your address is not a test user.
7. Audit log: every attempt above is there, failures as `GOOGLE_LOGIN_FAILED` with the reason.
