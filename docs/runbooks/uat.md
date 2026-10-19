# Acceptance runbook for the product owner

Check every client requirement (SRS 2.7) and every acceptance criterion AC-01 to AC-16 (SRS 14.2) yourself, with exact clicks, the account to use, the result you should see, and how to measure times against a phone clock.

**Status words** (decided from the code and the tests on 19 October 2026, not from the documentation):

- **BUILT**: the feature exists and works as the requirement says.
- **PARTIAL**: it exists, but one part of the requirement is missing or not shown. The missing part is named in the item.
- **NOT BUILT**: it does not exist.

How long: the quick items take a minute each; the items that need real waiting (idle, outage, midnight) take 5 to 30 minutes, and section 1 shows how to shorten the waits. Allow about two hours for everything except the overnight checks (AC-08, AC-14).

## 0. Summary

| # | Client requirement (SRS 2.7) | Status | Where in this runbook |
| --- | --- | --- | --- |
| 1 | Automatic detection of in and out times | **BUILT** | R1, AC-01 to AC-08 |
| 2 | Documentation handling and storage | **PARTIAL**: no policy acknowledgement tracking, no Word/Excel preview, no ZIP bulk download, search covers titles and tags only | R2, AC-11 to AC-13 |
| 3 | Timesheets and task management for each subcontractor | **PARTIAL**: no multi-level approval, no invoice, no recurring tasks, task dependencies or CSV task import, no per-project weekly cap | R3, AC-09, AC-10 |
| 4 | Meetings and connecting | **PARTIAL**: no map editor screen, no guest links, no background blur, no automatic meeting summary, calls cannot start from a chat | R4, AC-06, AC-15 |
| 5 | Daily and weekly task lists | **BUILT** | R5, AC-14 |
| 6 | Password-protected documents (contracts etc.) | **BUILT** | R6, AC-12, AC-13 |
| 7 | Accurate detection of in and out times | **BUILT** (browser-only limit in R7) | R7, AC-01 to AC-08 |

| AC | Scenario in short | Status |
| --- | --- | --- |
| AC-01 | Sign in, move the mouse: clock-in within 5 s | **BUILT** |
| AC-02 | Close the tab: clock-out at the last heartbeat | **BUILT** |
| AC-03 | Internet cut for 60 s | **PARTIAL**: session stays open and no new session starts, but the gap is not logged as its own entry (it shows only as missing heartbeat times) |
| AC-04 | Internet cut for 10 minutes | **BUILT** |
| AC-05 | 6 minutes without input is Idle, 16 minutes is Paused | **BUILT** (the top bar says "Idle" for both; "Idle (paused)" is shown on My attendance) |
| AC-06 | 30-minute meeting without touching the mouse | **BUILT** |
| AC-07 | Laptop and phone at the same time | **BUILT** |
| AC-08 | Session open across midnight | **BUILT** |
| AC-09 | Timesheet with 42 attendance hours and 30 logged | **BUILT** |
| AC-10 | Approved timesheet cannot be edited | **BUILT** |
| AC-11 | Another subcontractor's contract by URL | **PARTIAL**: access is refused and nothing leaks, but the refused attempt is **not** recorded in the document access log |
| AC-12 | Confidential contract after 15 minutes | **BUILT** |
| AC-13 | Storage and database dump are unreadable | **BUILT** |
| AC-14 | Unfinished tasks carried to the next day | **BUILT** |
| AC-15 | Two people enter a meeting room | **PARTIAL**: audio and video connect and both are recorded as present, but the 3-second target is not measured and the attendance credit is not tested in a browser |
| AC-16 | Contract expiring in 30 days | **BUILT** |

The automated evidence for all of this: `npm run verify` (see [web-local.md](web-local.md), section 6). It also prints the measured clock-in and clock-out delays. Tests that do not exist or are skipped: [untested-and-skipped.md](../verification/untested-and-skipped.md). Known problems: [known-issues.md](../verification/known-issues.md).

## 1. Before you start

### 1.1 Prepare the demo company

```bash
npm run seed:demo        # resets the demo company "Acme Demo" and creates the people below
node --experimental-strip-types apps/api/test/seed-demo-data.ts   # four weeks of history: attendance, tasks, timesheets, a contract
npm run api              # terminal 1
npm run web              # terminal 2: open http://localhost:3000
```

Always run the first line first: the history script only works on a freshly reset company. All passwords: `DemoPassword123!`. A mail catcher shows every email at http://localhost:8025.

| Person | Account | Role | Notes |
| --- | --- | --- | --- |
| Ada Admin | `admin@acme.demo` | Admin | must set up two-factor sign-in at the first sign-in (authenticator app) |
| Hana HR | `hr@acme.demo` | HR | same |
| Leo Lead | `lead@acme.demo` | Team lead of Support | approves timesheets and corrections, sees the Support team's live board |
| Wendy Worker | `worker@acme.demo` | Employee | |
| Sam Subcontractor | `sam@acme.demo` | Subcontractor | has rates, a timesheet history and a contract that ends in about 25 days |

At the first sign-in everybody sees the **attendance monitoring notice**: click **I have read and accept this notice**. Nothing is tracked before that.

Use one normal window and one private window to be two people at once. For two devices (AC-07), use a phone as the second one: it needs an address that starts with `https://` or is `localhost`, so for the phone follow [demo-internet.md](demo-internet.md); the camera and microphone do not work on a plain `http://` address.

### 1.2 Reading times against a phone clock

The 5-second and 30-second targets can only be checked if you can read **seconds**:

1. Set the phone and the computer to **automatic time** (network time). Then they differ by less than a second. Open a clock app with seconds on the phone and keep it next to the screen (or film both with the phone camera).
2. Where the app shows seconds:
   - **What we collect** (sidebar): the **Server time** column of the event list shows `HH:MM:SS`. The oldest `HEARTBEAT` row of today is the moment you were clocked in; the newest one is the last heartbeat.
   - **My attendance**: hover over the **In** or **Out** cell of a day to see `Clock-in HH:MM:SS` / `Clock-out HH:MM:SS`.
   - The **Tracking** badge in the top bar: hover to see `Last heartbeat HH:MM:SS`.
3. In this local setup the server runs on your computer, so server time equals the computer's time. If the server runs elsewhere, compare it once: the page shows the server's time, so read both clocks at one moment and write down the difference.
4. The numbers you should see (measured by the automated tests): clock-in **0.2 to 0.9 seconds** after the first activity; clock-out time **4 to 5 seconds** before the last activity (the heartbeat comes every 30 seconds, so up to 30 is allowed). `npm run verify` prints the current measured values.

### 1.3 Shorter waits (optional)

Sign in as Ada, open **Policy settings**, and change these (the form refuses values outside the limits): **Idle after** 2 minutes (the smallest), **Pause after** 5 minutes (smallest), **Reconnect grace** 30 seconds (smallest), **Vault re-authentication** 1 minute (smallest). Save. The server takes up to 30 seconds to notice. The rest of this runbook gives the real defaults first (idle 5 minutes, pause 15, grace 120 seconds, vault 15 minutes); put the values back when you finish.

## 2. The seven client requirements

### R1. Automatic detection of in and out times: BUILT

(Two small related gaps: a manager cannot mark idle time as payable (FR-ATT-005) and breaks are not suggested automatically (FR-ATT-007).)

**Account:** Wendy. **Steps:** sign in, accept the notice, move the mouse. **Expect:** the top bar changes to **Tracking: Active since HH:MM** within seconds; **My attendance → Today** shows Active time growing and the day in the weekly table as **In progress**. Close the tab; in 2 to 3 minutes Leo's **Live board** shows Wendy as offline, and Wendy's day shows an **Out** time equal to the last heartbeat. Details and timing: AC-01, AC-02. The optional desktop agent (Electron app, installers built by the CI) adds detection of work in other programs; see [apps/agent/README.md](../../apps/agent/README.md).

### R2. Documentation handling and storage: PARTIAL

**Missing:** tracking who has read and acknowledged a policy (FR-DOC-018), previewing Word and Excel files as PDF (FR-DOC-019), downloading many documents as a ZIP (FR-DOC-020); search finds titles and tags, not text inside files (FR-DOC-016).

**Account:** Wendy, then Hana. **Steps:** **Documents** → **Upload**: choose a PDF, set **Title**, **Category**, **Tags**, click **Upload**. **Expect:** the document shows "Scanning for viruses", then ready (a minute, longer on the first start of ClamAV). Open it: preview, **Download**, **New version** (the old version stays in the history; **Restore** brings it back), **Share** with another person at View or Edit, an expiry date, search by title or tag, folders on the left. Delete moves it to **Trash** (30 days) where it can be restored. The test virus file (EICAR) is refused as infected. Deeper checks: AC-11, AC-12, AC-13. Not covered by a browser test: see [untested-and-skipped.md](../verification/untested-and-skipped.md).

### R3. Timesheets and tasks for each subcontractor: PARTIAL

**What exists:** tasks (create, assign, accept or decline, comment with @mentions, checklist, board), per-subcontractor rates and a weekly cap with warnings at 80 % and 100 %, a timer and manual time, weekly timesheets with variance alerts, approval by the manager with comments, reports with CSV, XLSX and PDF export. **Missing:** a second approval level, an invoice, recurring tasks, task dependencies, CSV import of tasks, a weekly cap per project.

**Account:** Sam, then Leo. **Steps:** Leo: **Tasks → New task** for Sam (Title, Estimate, due date) → Create. Sam: open the bell → the new task → **Accept**; **Start timer**, wait a minute, **Stop timer**; **My timesheet** → **Add time** (Day, Hours, Minutes, **Reason (required)**) → **Submit for approval**. Leo: **Review timesheets** → open Sam's → **Approve** (or **Reject** with a **Comment to the submitter**). **Expect:** Sam sees the status change and the comment; the approved week is locked (AC-10). Weekly cap: Sam's seeded cap is 40 hours; when this week's logged time passes 32 hours (80 %) and 40 hours (100 %) Sam, Leo and Hana each get one notification and Sam sees a banner on **My timesheet**.

### R4. Meetings and connecting: PARTIAL

**What exists:** the virtual office (map, walking, rooms, proximity audio and video, knock and password rooms, desks, status), instant and scheduled meetings with a lobby, in-call controls (microphone, camera, screen share, raise hand, host mute-all and remove), the meeting chat with mentions, calling a person from the people list or an avatar with ring, accept, decline and missed-call notice, recording with consent. **Missing or limited:** no screen to edit the office map (FR-VO-006), no guest links (FR-VO-011), no emoji reactions (FR-VO-014), no background blur (FR-MEET-010), no automatic meeting summary (FR-MEET-014), no starting a call from a chat message (FR-MEET-001); recording needs the optional Egress service; from the people list you call one person at a time; the connection time target (AC-15) is not measured.

**Accounts:** Wendy and Leo in two windows. **Steps:** Wendy: **Office** → in **People**, click **Call** next to Leo. Leo: the alert "Wendy Worker is calling you" → **Accept** → **Join** the pre-join screen (the camera preview and the microphone level move). **Expect:** both see each other; **Chat** in the call controls opens the meeting chat. With the keyboard: Tab to **Avatar actions for Leo Lead** on the map, press Shift+F10, choose **Call**.

### R5. Daily and weekly task lists: BUILT

**Account:** Wendy. **Steps:** **Tasks → Today**: add tasks to **Goals for today** → **Confirm my plan**. In the evening: **Done today**, **Tomorrow** → **Submit report**. **Tasks → Week**: weekly goals (**New weekly goal** → **Add**), drag tasks between days; **Workload** for the team lead. **Expect:** AC-14.

### R6. Password-protected documents: BUILT

**Account:** Hana, then Sam. See AC-12 for the steps. Also: **Share link** with expiry, password and a limit on openings, and **Revoke**; a "view only" mode with a watermark that shows the viewer's name, time and address.

### R7. Accurate detection of in and out times: BUILT

Times come from the **server clock** only (the browser's time is ignored); a signed heartbeat every 30 seconds; idle, pause, break and meeting are tracked; a lost connection is bridged for 2 minutes. **Limit:** a browser can only see activity in its own page. Work in other programs is invisible unless the desktop agent is installed, so a person who works elsewhere shows as idle. Targets and how they are proved: AC-01 to AC-08 and `npm run verify`.

## 3. The acceptance criteria

### AC-01. Automatic clock-in within 5 seconds: BUILT
- **Account:** Wendy, a private window. **Setup:** phone clock in view.
- **Steps:** Sign in as `worker@acme.demo`. On the notice, read the phone seconds **T0** and click **I have read and accept this notice** (if you were already accepted, T0 is the moment of the sign-in click).
- **Expect:** the badge shows **Tracking: Active since HH:MM**; no button was pressed. **What we collect** → oldest `HEARTBEAT` of today at server time **T1**; **T1 − T0 is at most 5 seconds** (typically under 1).

### AC-02. Closing the tab: clock-out at the last heartbeat: BUILT
- **Account:** Wendy; Leo for the live board. **Setup:** Wendy has been active for at least a minute.
- **Steps:** read the phone seconds **T2** and close Wendy's tab. Leo: **Live board**; watch Wendy.
- **Expect:** within about 2 to 3 minutes (the 2-minute grace plus the check interval) Wendy is **offline** on Leo's board. Wendy signs in again: **My attendance**, today's **Out** cell (hover) shows `Clock-out HH:MM:SS` = the last heartbeat **T3**; **T2 − T3 is between 0 and 30 seconds**. The out time is the last heartbeat, not the time the grace ended.
- **Explicit logout:** instead of closing the tab, click **Sign out**: the session closes **at once** (within a second), same out time rule.

### AC-03. Internet cut for 60 seconds: PARTIAL
- **Account:** Wendy. **Steps:** active and tracking. In the browser's developer tools, Network tab, choose **Offline** (or turn Wi-Fi off). After 60 seconds switch back.
- **Expect (works):** the badge turns amber, **Reconnecting… tracking paused**, then returns to **Active**; **My attendance** still shows **one** session for today (no new "In"); the total does not double.
- **Not as written:** the gap is not logged as a separate entry. It is visible only as a hole in the heartbeat times of **What we collect**.

### AC-04. Internet cut for 10 minutes: BUILT
- **Account:** Wendy. **Steps:** go offline for 10 minutes (or set **Reconnect grace** to 30 seconds and wait 2 minutes), then come back.
- **Expect:** on **My attendance** a yellow notice: *"Your earlier session ended at HH:MM because the connection dropped. N minutes are not counted. If you were working, request a correction below."* The earlier session's **Out** is the last heartbeat before the cut. Use **Request a correction** (Day, times, reason) → Leo: **Corrections** → **Approve** with a note.

### AC-05. 6 minutes without input is Idle, 16 minutes Paused: BUILT
- **Account:** Wendy, window in front. **Steps:** touch nothing for 6 minutes (or 2 minutes after step 1.3), then up to 16 minutes (or 5).
- **Expect:** the badge shows **Tracking: Idle · since HH:MM** within a heartbeat (30 seconds) after the threshold; **My attendance → Today** shows the state as **Idle**, then **Idle (paused)**. Move the mouse: **Active** again. Idle time is shown separately and does not count in **Net**.

### AC-06. A 30-minute meeting without touching the mouse: BUILT
- **Accounts:** Wendy and Leo. **Steps:** start and join a call as in R4. Wendy leaves the mouse alone for 30 minutes (or 10 minutes: the rule is "in a call counts as active").
- **Expect:** the badge shows **Tracking: In meeting · since HH:MM**; after leaving, **My attendance → Today → Meeting** grows by about the call length and Idle does not.

### AC-07. Laptop and phone at the same time: BUILT
- **Account:** Sam. **Steps:** sign in on the computer and on the phone (see 1.1 for the phone address); work on both for 10 minutes.
- **Expect:** **My attendance** shows **one** session for the day; **Net** is about the elapsed 10 minutes, **not 20**; the day carries a flag badge that reads `MULTI_DEVICE` (the raw code, not friendly wording; see known issue 7). (Measured by the test: 62 seconds of net time over 62 seconds of wall clock, while the two devices' own counters add up to 122.)

### AC-08. A session across midnight: BUILT
- **Account:** Wendy; the organisation's time zone is Asia/Colombo (Admin → Policy). **Steps:** stay signed in and active across midnight local time. Next morning: **My attendance**.
- **Expect:** two days: yesterday's session ends at 00:00 and today's starts at 00:00, each day total correct. This needs a night; the automated proof is `attendance-postgres-edge-cases › Row 15 & FR-ATT-008` and `attendance-raw-replay › midnight`.

### AC-09. 42 attendance hours, 30 logged: BUILT
- **Accounts:** Sam, Leo. **Steps:** Sam: **My timesheet** → the draft week with days marked **Variance** (the history seed creates some) → **Submit for approval**. Leo: bell and mail show the variance; **Review timesheets** → open Sam's.
- **Expect:** Sam and Leo both get a variance alert (when logged and attendance time differ by more than 15 %, set in Policy); Leo can **Approve** with a comment or **Reject** with a **Comment to the submitter**; Sam sees the comment and can resubmit. The exact 42 h versus 30 h is not seeded; the tests use 8 h versus 1 h and 480 versus 420 minutes (same rule).

### AC-10. An approved timesheet cannot be edited: BUILT
- **Accounts:** Sam, Hana. **Steps:** Sam opens the approved week (history seed: two weeks ago) and tries to change or add time. Hana: opens it and uses **Reopen**, entering a reason.
- **Expect:** every edit by Sam is refused with a message; only Hana's reopening works, and **Audit log** (Ada) shows `TIMESHEET_REOPENED` with the reason.

### AC-11. Another subcontractor's contract by URL: PARTIAL
- **Accounts:** Hana (uploads), Sam (tries). **Steps:** Hana uploads a contract document for Wendy (**Documents → Upload**, Category Contract), copies its address. Sam pastes the address.
- **Expect (works):** Sam gets "not found", the same answer as for a document that does not exist; no title, file name or size appears. **Contracts** (Hana) lists contracts; Sam cannot open others.
- **Not as written:** the refused attempt is **not** written to the document access log or the audit log. Only successful use, failed passwords and re-authentication prompts are logged. See known issue 1.

### AC-12. Confidential contract after 15 minutes: BUILT
- **Accounts:** Hana (uploads and protects), Sam (opens). **Steps:** Hana: **Documents → Upload**, choose a PDF, **Confidentiality** = Confidential, **Upload**. Open it (preview): the first time she is asked to confirm it is her: **Your account password** → **Confirm**. On the document page: **Document password** form → **Password (10+ characters)** → **Set password**. **Share** it with Sam (Person, Permission View → **Share**). Wait 15 minutes (or 1 minute after step 1.3). Sam: **Documents**, open the document.
- **Expect:** Sam is asked for **Your account password** → **Confirm** (re-authentication; the 15 minutes are counted since his last confirmation). Then **Document password** → **Unlock**: a wrong password shows "Wrong document password" and is logged as `PASSWORD_FAIL` (Hana: the document's **Access log**); the right one opens the file as a watermarked view.

### AC-13. The storage and the database dump are unreadable: BUILT
- **Account:** Hana to upload; an engineer to inspect. **Steps:** upload a PDF named `TOP-SECRET-TEST.pdf` containing the words "UNIQUE-PHRASE-4711", Confidential. Dump the database: `docker compose exec postgres pg_dump -U postgres hrvo_dev | grep -c -e UNIQUE-PHRASE-4711 -e TOP-SECRET-TEST`. List the storage objects with the AWS command line and the keys from `.env`: `AWS_ACCESS_KEY_ID=<S3_ACCESS_KEY> AWS_SECRET_ACCESS_KEY=<S3_SECRET_KEY> aws --endpoint-url http://localhost:9000 s3 ls s3://hrvo-documents --recursive` (object names are only identifiers), then `aws … s3 cp` one object to a file and run `grep -c UNIQUE-PHRASE-4711` on it.
- **Expect:** the database dump prints `0` (titles and file names are stored encrypted); the stored object does not contain the phrase (it is encrypted with a key that exists only in the key service). Automated proof: `vault-e2e` (a database dump plus a bucket dump reveal no content, file name or confidential title).

### AC-14. Unfinished tasks are carried to the next day: BUILT
- **Account:** Wendy. **Steps:** Monday: **Tasks → Today**, put 5 tasks in the plan, **Confirm my plan**, finish 3, **Submit report** with the other 2 in **Tomorrow**. Next morning (after the nightly job): **Tasks → Today** and **Tasks → Week**.
- **Expect:** the 2 open tasks are in today's list with the badge **Carried over**, and visible in the weekly planner (**Tasks → Week**). Shortcut: the browser test `07-planning` ("Carried to next work day") and `notifications-e2e › automatic carry-over`.

### AC-15. Two people in the same meeting room: PARTIAL
- **Accounts:** Wendy, Leo. **Steps:** in the **Office**, both: **Turn on audio and video** (allow camera and microphone, **Turn on**), then **Go to Meeting room A** (Rooms list). Start a phone stopwatch when the second person's room button is clicked.
- **Expect (works):** audio and video connect; each sees the other's video; both are recorded as present in the meeting. **Measure:** stopwatch until the other person's video appears (target 3 seconds).
- **Not measured:** the 3-second target and the meeting minutes in **My attendance → Today** are not checked by any browser test; the rule that "in a call" counts as meeting time is tested at the unit level.

### AC-16. Contract expiring in 30 days: BUILT
- **Accounts:** Hana, Leo (Sam's manager). **Steps:** Hana: **Documents → Contracts → New contract** (Person Sam, Title, Start, **End** = 30 days from today, Status Active, Signed document) → create. The reminder job runs every few minutes (or at once with background jobs on; see [web-local.md](web-local.md)).
- **Expect:** Hana and Leo each get a notification "Contract ends in 30 days: Sam Subcontractor" and an email (Mailhog, http://localhost:8025). Reminders come at 60, 30 and 7 days and on the last day (the SRS lists 30, 14 and 7; see known issue 5). The seeded contract (about 25 days left) shows the same notice.

## 4. Record the result

For each item write PASS, FAIL or a comment, who ran it, the date and the time you measured. On a FAIL, note what the screen said and the exact time; Ada's **Audit log** and the files in `verify-logs/` hold the server side. Compare with `npm run verify` on the same day.

| Item | Result | Measured | By | Date |
| --- | --- | --- | --- | --- |
| R1 to R7 | | | | |
| AC-01 | | clock-in delay: s | | |
| AC-02 | | clock-out gap: s | | |
| AC-03 to AC-16 | | | | |
