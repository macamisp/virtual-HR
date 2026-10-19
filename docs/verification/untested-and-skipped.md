# What is not tested automatically, and what is skipped

As of 19 October 2026 (API tests: 759; browser tests: 71 run plus 2 skipped). This list was made by checking the code, not from memory: every page of the web app was matched against the browser tests that visit it, and every claim below was searched for in the test files. "Browser test" means a Playwright test that drives the real web app. "API test" means a test that calls the API and the database directly.

## 1. Skipped tests

| Test | Skipped when | Why | Does CI run it? |
| --- | --- | --- | --- |
| Browser: `22-recording` (2 tests: record a meeting with consent, then watch it) | `LIVEKIT_EGRESS` is not `1` | Recording needs LiveKit's Egress service, a container of about 1.3 GB with a headless Chrome inside. The compose file starts it only with `docker compose --profile recording up -d`. | **No.** Recording is checked in CI only through the API test (consent rules, encryption, access), never end to end in a browser. It was run end to end on the development machine on 17 October with the Egress container and passed. |

That is the only test skipped on purpose. `npm run verify` allows exactly this skip and fails on any other.

## 2. Tests that skip themselves when a service is missing

These suites decide at start-up to skip everything inside them when the document storage or the virus scanner is not configured. Skipped looks like passed in a normal test summary, so a computer without those services appears to pass while testing no documents at all.

| Suite | Skips when | What it covers |
| --- | --- | --- |
| API `documents-e2e` | `S3_ENDPOINT` or `CLAMAV_HOST` unset | upload, scan, versions, sharing, quarantine |
| API `vault-e2e` | same | confidential documents, passwords, share links, encryption at rest |
| API `esign-e2e` | same | electronic signatures |
| API `recordings-e2e` | `S3_ENDPOINT` unset | recording consent, encryption, access |
| Browser `10-documents`, `11-vault`, `21-esign` | `S3_ENDPOINT` or `CLAMAV_HOST` unset | the same, in the browser |

CI sets those variables, so the suites run there (759 API tests and 71 browser tests ran, none of these skipped). `npm run verify` checks the services first and refuses to run without them, so this cannot pass by accident. Running a single `npm test` by hand without them can.

## 3. Pages of the web app with no browser test

Each of these is a screen a person can open. The API behind it has tests (named below); the screen itself, its buttons and its messages have not been driven by a browser test.

| Page | What a person does there | Covered by |
| --- | --- | --- |
| Accept invitation (`/accept-invitation`) | set a name and password from an invitation link | API `auth-hardening-e2e`, `app-shell-e2e` |
| Forgot password, Reset password | ask for a link, choose a new password | API `auth-hardening-e2e`; `attendance-logout-e2e` (a reset closes the open session) |
| Calendar sync (`/account/calendar`) | connect Google or Outlook, see busy times | API `calendar-sync-e2e` with fake calendar providers; **no real Google or Microsoft account is ever used** |
| Contracts (`/documents/contracts`) | list contracts, add one with end date and notice period | API `documents-e2e` (contract reminders) |
| Document access log (`/documents/access-log`) | read and export who opened which document | API `documents-e2e` |
| Document retention rules (`/documents/retention`) | set "keep at least N years" per category | API `vault-e2e` |
| Projects (`/projects`) | create projects, add members, set a project rate | API `tasks-e2e`, `timesheets-e2e` |
| Rates (`/timesheets/rates`) | HR sets a subcontractor's rate, overtime and weekly cap | API `timesheets-e2e` (the browser spec 09 says so in a comment) |

## 4. Actions on pages that a browser test visits, but never uses

| Action | Where | Covered by |
| --- | --- | --- |
| Edit or delete your own chat message; the emoji picker | Chat | API `chat-e2e` (edit and delete); emoji: nothing |
| Room password dialog | Office | API `office-e2e` |
| Host mutes everyone or removes a person | a meeting | API `meetings-e2e` |
| Cancel your own leave request | Leave | API `leave-e2e` |
| Keyboard use of the people list and the Call button | Office | the avatar menu has a browser test (Shift+F10, arrow keys); the list does not |

## 5. Whole areas with no automated test

- **Real outside systems.** Only emulators are used: a KMS look-alike, an S3 look-alike, a mail catcher, fake calendar providers. Real AWS KMS, real S3, real email delivery, real Google and Microsoft calendars and LiveKit Cloud have never been exercised by a test. The cloud setup (Terraform) is only checked for syntax in CI; it has never been applied.
- **Other browsers and phones.** Browser tests run in Chromium only. Firefox, Safari, and small phone screens are not tested.
- **Accessibility.** There is no automated accessibility scan. Keyboard use is tested only where named in section 4 and in a few specs (labels, focus).
- **Load and speed.** Load scripts exist in `load/` (heartbeats, the office) and were run by hand; they are not part of CI or `npm run verify`.
- **The desktop agent.** Its logic has unit tests (10, in CI). The installers for Windows, macOS and Linux are built by CI but never installed or started on those systems by a test.
- **Real elapsed time.** Everything that needs a night (midnight split, overnight carry-over, the nightly check) is proved with clocks set by the test, not by waiting. UAT items AC-08 and AC-14 are the only way to see it for real.
- **Screens in this list that are not on any page.** The raw attendance export (CSV and XLSX of all attendance) exists as an API route and has a test, but **no button anywhere in the web app** uses it; see known issue 6.
