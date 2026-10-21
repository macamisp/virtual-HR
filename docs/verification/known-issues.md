# Known problems and limits

Written in plain words, as of 19 October 2026, from the code and the tests. Nothing here is hidden elsewhere: if you find a problem that is not on this list, it is new, and it belongs here. The acceptance steps that touch these points are in [uat.md](../runbooks/uat.md); what has no automatic test is in [untested-and-skipped.md](untested-and-skipped.md).

## A. Things that do not behave exactly as the requirement says

1. **A refused look at a document is written down, but only for HTTP routes.** Opening a document you may not see still answers with a plain "not found" (or "no permission"), exactly as if it did not exist. Since 21 October 2026 the attempt is also added to the document access log as `ACCESS_DENIED`, with who, from where and which id was asked for (AC-11). Refusals on the public share-link route are not logged this way; wrong share-link passwords and the other events listed in the log are unchanged.
2. **A short internet outage is not written down as its own entry.** When the connection drops for a minute, tracking carries on correctly: the same session continues, no second clock-in appears, nothing is double counted. But there is no entry that says "gap from 10:14:30 to 10:15:30". You can only see it as missing heartbeat times in the list on **What we collect**. The requirement (AC-03) says "gap logged".
3. **The bar at the top says "Idle" when you are paused.** After 5 minutes without input you are Idle, after 15 minutes Paused. The top bar shows "Idle" for both; the word "Paused" ("Idle (paused)") appears only on **My attendance → Today**.
4. **Times are shown to the minute almost everywhere.** Only the list on **What we collect**, and the tooltips on the **In** and **Out** cells of **My attendance**, show seconds. That is enough to check the accuracy targets, but nobody sees seconds on the live board or in reports.
5. **A contract cannot carry its own rate** (rates belong to the person). Contract reminders now come at 30, 14 and 7 days and on the last day, as FR-ORG-003 says.
6. **The export of all attendance (CSV and Excel) has no button.** The function exists and is tested, but nothing in the web app calls it. Reports and the audit log do have export buttons.
7. **A few labels are raw codes.** For example, a day worked on two devices at once shows the flag `MULTI_DEVICE` instead of a sentence.
8. **Browsers see only their own page.** If a person works in another program (a code editor, a design tool) with the HR page open in the background, the browser sees no input and the time counts as idle. The optional **desktop agent** solves this; it has to be installed by each person, and its installers have never been tried on the real systems by an automatic test.

## B. Not built yet (named in the requirements)

People and organisation
- Sign in with Google or Microsoft (single sign-on).
- A setting for how long an unused sign-in lasts before it signs out by itself. Today a sign-in simply lasts 7 days from the last renewal, for everybody; the requirement asks for 8 hours of inactivity by default, set per organisation.
- A screen where a person sees their own signed-in devices and signs one out. Administrators can sign a session out through the system's interface, but there is no screen for it.
- Importing people, teams and projects from a CSV file.
- The onboarding checklist for new people (upload ID, accept policies, set up two-factor sign-in, complete profile), and the matching off-boarding steps (the person is not marked as "left", their open tasks are not handed over).
- A screen for the organisation's own profile (logo, working week, colours), and a company directory with profile cards.
- Branding with custom domain; switches for turning features on per organisation; API keys for other systems.

Time, tasks and documents
- A second approval step for timesheets; an invoice or PDF for approved time. The "billable" choice on time entries is always "yes".
- Recurring tasks, tasks that depend on other tasks, importing and exporting tasks as CSV, and a daily stand-up summary posted to a chat channel.
- A weekly hours limit per project (the limit per person works).
- Telling people who has read and acknowledged a policy, with reminders.
- Downloading many documents at once as a ZIP.
- Full-text search inside documents (search covers titles and tags).
- Preview of Word and Excel files as PDF.

Office and meetings
- A screen to edit the office map (it can be replaced only through the system's interface).
- Guest links into a room; emoji reactions above avatars; background blur; automatic meeting summary.
- Starting a call from a chat message. From the people list you can call one person at a time.

Messages and reports
- Browser push notifications, Slack or Teams alerts, and daily or weekly digests.
- Reports sent by email on a schedule.
- A rule for how long chat messages are kept.
- A single privacy dashboard.

## C. Limits you should know

9. **The system cannot send real email once it runs in production mode.** Today it has two ways to send mail: "memory" (the mail is thrown away) and a plain development connection to the mail catcher (refused in production on purpose). There is no connection to a real mail service yet. Until one is added, invitations, password-reset links and reminders by email cannot reach people outside a development computer. In the demo on your own computer all mail goes to the catcher at http://localhost:8025. The invitation link is also shown by the system, not only emailed.
10. **It has never run in the cloud.** The cloud setup (Terraform) is checked for syntax only and has never been applied. Everything was tested on a development computer and in GitHub's test machines, with look-alikes for the key service (KMS), storage (S3), mail and calendars.
11. **Recording needs an extra service.** Recording a meeting needs LiveKit's Egress container (large, off by default). Without it recording is not available. It works on a development computer with it switched on, but CI never runs that test.
12. **The two-factor code tolerates one 30-second step of clock drift, not more.** The previous, current and next code are accepted, so a phone clock up to about 30 seconds off works. Each code works once: the newest time step a person has used is stored, and that step or an earlier one is refused. The side effect: signing in and then confirming with the vault re-authentication inside the same 30 seconds needs the next code.
13. **The first start of the virus scanner takes minutes.** Uploads wait in "Scanning for viruses" until it has loaded its signatures. If you restart your computer the containers stop; `docker compose up -d` brings them back.
14. **Moving a person to another team or changing their role reaches the API within 30 seconds, not 15 minutes.** Every request re-reads role, team, permissions and status from the database (cached for 30 seconds per API process; a deactivated person is refused at once after that). The sign-in token still carries the old team and role until it is renewed every 15 minutes, but the API no longer trusts those claims.
15. **The 6- and 16-minute idle and pause targets are really 5 and 15 minutes plus up to 30 seconds** (the check happens at each 30-second heartbeat). The organisation can change them (smallest: 2 and 5 minutes).
16. **Only Chromium is tested.** Other browsers and small phone screens are not covered by tests. The camera and microphone work only on `https://` addresses or `localhost`.

## D. About the tests themselves

17. **A few timing tests can fail on a busy computer.** About five browser and API tests depend on exact timing (the "Are you still working?" question, chat in a call, 2-factor codes at the edge of a 30-second step). Each has been made more robust and passes when run alone, but under heavy load (many programs open) one of them can fail once and pass on the next run. One seen in practice: the download from a share link (browser test `11-vault`) occasionally saves the file under a random name instead of the document's name when the computer is busy; it passed alone straight afterwards. If `npm run verify` shows one failure, run it again before worrying; if the same test fails twice, it is a real problem.
18. **The history sample data can only be loaded once on a fresh demo company.** Load it right after `npm run seed:demo`; loading it twice fails with "timesheet is PAID, its time entries are locked".
19. **A fresh clone needs about 6 GB of disk space** for the container images, and the first `docker compose up -d` can take several minutes.

18. **Time logged by timer is counted a little low, and a running timer is not part of the 24-hour check (backlog, low priority).** Each stored piece of a timer is rounded down to whole minutes (a timer under one minute stores 0), and a timer that is still running does not count towards the 24-hour limit for the day when someone adds manual time. Adding or changing manual time is now serialised per person, so simultaneous requests can no longer push a day past 24 hours.
19. **Running the API tests by hand needs the test settings.** Run `npm run verify`, or set `JOBS_ENABLED=false` (scans then run in the request instead of a Redis queue that nothing is consuming), `AUTH_MFA_ENFORCEMENT=` (empty) and `RATE_LIMIT_VAULT=500 RATE_LIMIT_SHARE=500`. With the demo `.env` alone, uploads stay at "Scanning for viruses" in the tests.
