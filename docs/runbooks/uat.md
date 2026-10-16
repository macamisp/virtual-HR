# Pilot UAT runbook — HR Virtual Office, Phase 1

For the client's five pilot users and the HR owner running the acceptance. Each script says who signs in, what to do, and what you should see. Tick the box when it matches; write down anything that does not, with the time, so it can be found in the audit log.

## 1. Before the pilot

| Step | Who | What |
| --- | --- | --- |
| 1 | Engineering | Deploy the release, run `npm run db:migrate` and `npm run db:provision-roles`, then seed the pilot organisation (`seed-web-demo.ts`, then `seed-demo-data.ts` for history) or create it by invitation. |
| 2 | Engineering | Confirm the service checks: `GET /users/me` answers 401 without a token; the web app loads; ClamAV reports "clamd started"; the object store answers. |
| 3 | HR owner | Hand each pilot user their account and the authenticator-app instruction (admins and HR must set up 2FA on first sign-in). |

Pilot accounts (demo organisation "Acme Demo", password `DemoPassword123!` unless invitations were used):

| Person | Account | Role | Needs 2FA |
| --- | --- | --- | --- |
| Ada Admin | `admin@acme.demo` | Admin | yes |
| Hana HR | `hr@acme.demo` | HR | yes |
| Leo Lead | `lead@acme.demo` | Team lead (Support) | no |
| Wendy Worker | `worker@acme.demo` | Employee | no |
| Sam Subcontractor | `sam@acme.demo` | Subcontractor | no |

The seeded history gives Wendy and Sam four weeks of attendance, Sam three timesheets (one paid, one approved, one in progress) and a contract that ends in 25 days, and the Support team a project with eight tasks.

## 2. Day 1 — sign-in, notice, automatic attendance (HR requirements 1 and 7)

**UAT-01 First sign-in and 2FA (Ada, Hana).** Sign in → the app asks you to scan a QR code with an authenticator app and enter a code → the app opens. Sign out and in again → a code is required. *Expect:* no way past the code screen; a wrong code is refused.

**UAT-02 Monitoring notice (Wendy).** Sign in → a notice explains what is collected (timestamps, activity counters, IP; no screenshots or keystrokes) and how long it is kept → accept. *Expect:* the app opens only after acceptance; **What we collect** in the menu shows the same text and your raw events.

**UAT-03 Automatic clock-in (Wendy).** Move the mouse or type. *Expect:* within a few seconds the badge in the header shows **Tracking: Active since HH:MM** and **My attendance → Today** shows the clock-in time. No button was pressed. (AC-01)

**UAT-04 Idle and pause (Wendy).** Leave the computer alone for 6 minutes → the badge shows **Idle**; after 16 minutes **Paused**. Touch the mouse → **Active** again. *Expect:* Today's totals grow only while active; idle time is listed separately. (AC-05)

**UAT-05 Break (Wendy).** Click **Start break**, wait a minute, **End break**. *Expect:* the break shows in Today's totals; the live board (Leo) shows "On break" meanwhile. 

**UAT-06 Connection loss (Wendy).** Turn Wi-Fi off for one minute, then on. *Expect:* the badge shows **Reconnecting**, then **Active**; Today still shows one session, no new clock-in. (AC-03) Then turn Wi-Fi off for 10 minutes. *Expect:* when back, Today shows the session ended at the last heartbeat and a yellow notice offers **request a correction**; a new session starts on the next activity. (AC-04)

**UAT-07 Clock-out (Wendy).** Close the browser tab at the end of the day. *Expect (next morning, or from Leo's live board within three minutes):* the session is closed with the time of the last heartbeat. (AC-02)

**UAT-08 Two devices (Sam).** Sign in on a laptop and a phone at the same time and work on both for ten minutes. *Expect:* Today shows **one** session; the total is the elapsed time, not double; the session is marked as multi-device. (AC-07)

**UAT-09 Live board and scope (Leo, Hana, Wendy).** Leo opens **Live board** → sees only the Support team, live. Hana → sees everyone. Wendy → has no Live board entry and `/live` says access is not available. (FR-ATT-016, AC-11 style)

**UAT-10 Correction (Wendy, Leo).** Wendy: **My attendance → Request a correction** for yesterday with a reason. Leo: **Corrections** → approve with a note. *Expect:* Wendy's day total changes; the original session is kept as "adjusted"; Hana finds `CORRECTION_APPROVED` in the audit log. (FR-ATT-013)

## 3. Day 2 — tasks and planning (HR requirements 3 and 5)

**UAT-11 Assign a task (Leo, Sam).** Leo: **Tasks → New** for Sam, with a due date and an estimate. Sam: the bell shows a new notification and an email arrives asking to **accept**. Sam accepts. *Expect:* Sam cannot start a timer on the task before accepting; the reporter sees "accepted".

**UAT-12 Daily plan and end-of-day (Wendy).** **Tasks → Today**: add five tasks to today's plan and confirm it. At the end of the day write the end-of-day report with two tasks unfinished. *Expect:* next morning the two tasks are in Today as "carried over" and appear on the weekly planner. (AC-14)

**UAT-13 Weekly planner and workload (Leo).** Drag a task to Thursday; open **Team workload**. *Expect:* capacity comes from the schedule (8 h/day); Sam's load index on **Reports → Tasks and workload** is above 1 (he has the most remaining estimate).

**UAT-14 Visibility (Wendy).** Open a task URL that belongs to Sam and is not in your project. *Expect:* "not found", no title shown. (AC-11)

## 4. Day 3 — timesheets (HR requirement 3)

**UAT-15 Timer and manual time (Sam).** Start the timer on an accepted task, stop it after a while; add 30 minutes of manual time with a reason; try to add 3 hours → it is flagged as above the daily limit. *Expect:* **My timesheet** lists the week with timer and manual entries marked differently.

**UAT-16 Variance and approval (Sam, Leo).** Sam submits last week (seeded: attendance 42 h, logged 30 h). *Expect:* Sam and Leo both see a variance alert; Leo opens **Review timesheets**, returns it with a comment; Sam sees the comment, resubmits; Leo approves. The approved amount shows with its currency. (AC-09)

**UAT-17 Locked after approval (Sam, Hana).** Sam tries to edit the approved week. *Expect:* every edit is refused. Hana (with the reopen permission) reopens it with a reason; the audit log shows `TIMESHEET_REOPENED`. (AC-10)

**UAT-18 Reports and export (Leo, Hana).** **Reports → Hours and cost** by person and by project → CSV, XLSX and PDF download. Leo sees the Support team only; Hana sees all. (FR-REP-003, 006, 008)

## 5. Day 4 — documents and the vault (HR requirements 2 and 6)

**UAT-19 Upload, scan, versions (Wendy).** **Documents → Upload** a PDF in category Identity. *Expect:* "Scanning…" then "Ready"; preview and download work; uploading again adds a version; restoring the old version adds another.

**UAT-20 Sharing (Wendy, Sam).** Share the document with Sam at **View**. *Expect:* Sam sees it with a watermark (his name, time, IP) and no download button; Wendy's **Access log** lists Sam's view with time and IP.

**UAT-21 Confidential contract (Hana, Sam).** Hana uploads Sam's contract as **Confidential**, linked to Sam, and sets a document password. Wait 15 minutes. Sam opens it. *Expect:* Sam must confirm his account password first (re-authentication), then enter the document password; a wrong document password is refused and logged as `PASSWORD_FAIL`; the third wrong one locks for 15 minutes and notifies HR; the right one opens the file. (AC-12)

**UAT-22 Other people's contracts (Sam).** Paste the URL of Wendy's identity document. *Expect:* "not found"; nothing about the document is shown; the attempt is in the access log. (AC-11)

**UAT-23 Share link (Hana).** Create a share link for a normal document with a 7-day expiry and a password; open it in a private window. *Expect:* the page asks for the password, then shows View and Download; after revoking, the link says it is not valid.

**UAT-24 Contract expiring (Hana, Leo).** Sam's seeded contract ends in 25 days. *Expect:* Hana and Leo have a **Contract ends in 25 days** notification and email; the **Dashboard** lists it under "Expiring within 30 days". (AC-16)

**UAT-25 Trash and retention (Hana).** Delete a document → it is in **Trash** for 30 days and can be restored. **Retention** sets "keep at least 7 years" for Contracts → deleting a contract document is now refused with the date it becomes possible.

## 6. Day 5 — administration, notifications, privacy

**UAT-26 Policy (Ada).** **Policy settings** → set "Idle after" to 4 minutes, save. Wendy: idle shows after 4 minutes. Set it to 20 with pause at 10 → the form refuses.

**UAT-27 Custom role (Ada, Wendy).** **Roles and permissions** → new role "Employee without documents" based on Employee with **Use documents** removed; assign it to Wendy. *Expect:* within seconds Wendy's Documents menu entry disappears and `/documents` refuses. Put her back on Employee.

**UAT-28 Audit log (Ada).** **Audit log** → filter `USER_ROLE_CHANGED`, open an entry's before/after, **Verify chain** → "intact", **Export CSV**.

**UAT-29 Notification settings (Sam).** Switch off emails for "Task status changed", set quiet hours 22:00–07:00 in your timezone. *Expect:* a status change creates an in-app notification only; a task assigned during quiet hours arrives by email after 07:00. The unsubscribe link in any non-security email switches that type off in one click.

**UAT-30 Compliance (Hana).** **Reports → Compliance** → Sam is missing NDA and Tax (required for subcontractors). Upload them linked to Sam → he becomes compliant.

**UAT-31 My data and anonymisation (Wendy, Hana).** Wendy: **My data → Download ZIP** → the archive has one JSON per data set and a manifest. Hana: **Privacy requests** → pick a leaver test account → the check lists blockers (open timesheet, active contract) → settle them → open a request with a reason → confirm with the email → the account can no longer sign in; its audit trail is still there under a pseudonym. Do **not** run this on a pilot user you still need.

## 7. Things the pilot should not expect yet

- Virtual office, meetings, chat and audio/video (Phase 2; HR requirement 4, AC-15).
- A desktop agent: attendance is detected while the web app is open in a browser tab.
- Onboarding checklists (the compliance report says "not available").
- Scheduled e-mailed reports, SSO, web push.

## 8. Recording results

Use `docs/acceptance/phase1-acceptance.md` as the checklist; for each UAT item note PASS, FAIL or a comment, who ran it and when. Failures should quote what the screen showed; HR can find the server-side record in **Audit log** by time.
