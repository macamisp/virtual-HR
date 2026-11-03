# Version 2: persistent calls and office presence — release notes and rollback plan

Status: **local verification in progress; not deployed.** Version 1 (release/staging-2026-10-30)
stays on the AWS host until the owner approves this release.

Candidate: branch `feat/screen-share-viewer` (PR #4), head `d98f482` (see the release-readiness report).
Design: ADR 048 (persistent call), ADR 046/047 (staging host, unchanged).

## What changes for people

- A proximity or room call in the office keeps going when you open Tasks, Attendance, Dashboard or
  any other page. A small call window (participants, mic/camera state, mute, camera, share screen,
  raise hand, leave, **Return to office** / **Return to meeting**) follows you; it can be dragged
  with the mouse or the arrow keys, remembers its place and stays on screen on a phone.
- Your avatar stays where it was while you are on another page; colleagues see it faded with a
  dashed ring and "away from the office view". A reload brings you back to the same spot and call.
- Only one browser tab can hold the call; a second tab offers **Take over**.
- "In meeting" is now shown (badge, live board, office ring) during any call, and the time counts
  as meeting time in My attendance (SRS 6.2 rows 6–7 from the heartbeat).
- New per-user setting: "Mute my microphone when I leave the office page" (off by default).
- Fixed: the avatar no longer freezes after a quiet period (the office connection was dropped at
  the access token's expiry and never came back; ADR 048 §8). No page reload is needed.
- Fixed: a network drop in the middle of a walk no longer blocks later movement.
- Mail: the staging host's authenticated SMTP rules and the Resend transport are one set;
  `RESEND_FROM` is accepted as an alias of `MAIL_FROM`.

## Database

One additive migration, `20261106000000_office_call_preferences`: `users.vo_mute_on_leave boolean
not null default false`. Version 1 ignores the column, so a rollback of the application does not
need a database restore.

## Configuration

- New optional `OFFICE_LEAVE_GRACE_MS` (default 8000): how long a dropped office connection keeps
  the avatar in place for a reload of the same login session.
- New optional `ACCESS_TOKEN_TTL_SECONDS` (default 900, minimum 60): only for tests of the expiry
  paths; leave unset in staging and production.
- No new secrets. The Google OAuth client secret was rotated by the owner on 2026-11-03.

## Release gates (ADR 048, V2 QA brief)

| Gate | Evidence |
| --- | --- |
| Avatar idle-freeze regression passes repeatedly | Playwright 37, repeated runs (see report) |
| Persistent call navigation | Playwright 36; live two-browser walkthrough script |
| Multi-tab takeover reliable | Playwright 36 step 7, repeated |
| Media cleanup | Playwright 36 (no live local tracks after Leave and after sign-out) |
| Attendance integration | attendance-state-machine (5 cases), agent-companion, Playwright 36 (`presence_events` in-call heartbeats, Meeting total grows, Active after Leave) |
| No open P0/P1 regressions | release-readiness report |
| CI green | PR #4 check runs on the candidate head |
| Local two-user manual acceptance | docs/runbooks/uat.md AC-15b |
| Release notes and rollback plan | this file |

## Deploy (when approved; docs/runbooks/staging-ec2.md §5)

```bash
cd /opt/virtual-hr/app
C="docker compose -f docker-compose.staging.yml --env-file .env.staging --env-file .env.staging.db"   # add -f docker-compose.staging.ssh.yml in SSH mode
$C exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc hrvo_staging' > /opt/virtual-hr/backups/hrvo-$(date -u +%F)-pre-v2.dump
git fetch origin && git checkout --detach <candidate commit>
$C config -q && $C build
$C run --rm migrate          # adds users.vo_mute_on_leave
$C up -d && $C ps
curl -fsS http://127.0.0.1:3001/health
```

Then the live two-user check (scratch script `live-check.mjs`, or AC-15b by hand) with two
synthetic accounts.

## Rollback

1. `git checkout --detach <previous commit>` (the Version 1 release head), `$C build && $C up -d`.
2. The migration is additive and Version 1 ignores the column: **no database restore is needed**
   for an application rollback. Restore the pre-release dump only if the data itself must go back.
3. Nothing changes in Cloudflare, KMS, IAM, Redis or SeaweedFS for this release.

## Known limitations

- `inCall` is sent by the heartbeat leader tab; when another tab of the same browser owns the call
  the flag is not sent (independent elections). Normal single-tab use is unaffected.
- A LiveKit full reconnect after a very long call re-uses the original room token; see the
  release-readiness report for the token lifetime and whether this needs a refresh path.
- Meeting time is credited from the in-call flag; the meeting id is still not linked to the
  attendance segment (FR-MEET-009 partial).
- Google *linking* from the profile still uses a fetch and can fail with third-party cookies
  blocked (ADR 042).
