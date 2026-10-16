# ADR 019: Anti-spoofing, network policy, review flags, attendance alerts, presence challenge

**Status:** Accepted
**Date:** 17 October 2026
**Requirements:** SRS 5.5 FR-ATT-017, FR-ATT-018, FR-ATT-021, FR-ATT-023 (also FR-ATT-009, 010, 012); 10.2 heartbeat forgery; 11 proportionate monitoring.

## 1. Decisions

The product owner was offered these options and replied "continue", so the recommended defaults were taken. Each can be changed later.

| Topic | Decision |
| --- | --- |
| Country data | **Cloudflare's `CF-IPCountry`** (with `CF-Connecting-IP`), trusted only with `TRUST_PROXY_HEADERS=cloudflare`. No new package. Impossible travel works at **country level**. |
| Reviewers | **Manager + HR.** Reviewers hold `attendance.corrections.review`, the same people who approve corrections. Managers and team leads see their direct reports and team; HR and admins (`attendance.read.all`) see everyone; auditors can view but not resolve. Resolving needs a note. People see their own flags and can add an explanation. Nobody resolves a flag about themselves (API rule and database CHECK). |
| Scope | FR-ATT-021 alerts and FR-ATT-023 presence challenge are **included**. |
| Never penalise | A flag never changes recorded time, never blocks a heartbeat or a login, and is worded as information. Network lists flag; they do not block. |

## 2. Signals already in place (FR-ATT-017)

Signed heartbeats (HMAC with the per-session secret), a nonce and a per-device sequence number, rate limiting, and concurrent-device detection (`MULTI_DEVICE`, ADR 002/018) were already enforced. This slice adds review flags on top of them.

| Flag | Raised when | Dedupe |
| --- | --- | --- |
| `INVALID_HEARTBEATS` | 5 rejected heartbeats (signature, replay, order, unknown session) within 10 minutes | person per day |
| `HEARTBEAT_FLOOD` | 3 rate-limit refusals within 10 minutes | person per day |
| `MULTI_DEVICE` | the state machine first marks a session multi-device | session |
| `IMPOSSIBLE_TRAVEL` | consecutive countries further apart than 500 km after subtracting both countries' radii (√(area/π)), at more than 1,000 km/h | session and country pair |
| `UNBROKEN_FULL_ACTIVITY` | ≥ 360 consecutive 30-second intervals (3 h) with input in every second | session |
| `PERIODIC_ACTIVITY` | ≥ 12 identical short bursts at exactly the same spacing, nothing in between (a mouse jiggler) | session |
| `ACTIVITY_WITHOUT_FOCUS` | ≥ 10 browser intervals reporting input while neither visible nor focused (the browser cannot see that) | session |
| `IP_NOT_ALLOWED`, `COUNTRY_NOT_ALLOWED` | outside the organisation's lists (FR-ATT-018) | session and kind |
| `ANONYMIZER` | Cloudflare country `T1` (Tor) | session |
| `OFFLINE_SYNCED` | time synced from the desktop agent's offline buffer (ADR 018) | session |
| `MAX_LENGTH` | the maximum session length closed the session (FR-ATT-009) | session |

The mechanical-input heuristics run every 5 minutes over each open session's last 3.5 hours of raw events. They use only the counters; there is no input content to inspect. The country reference table (`country-reference.ts`) is approximate on purpose: an unknown country skips the check, and an unknown or missing country is never a violation.

## 3. Network policy (FR-ATT-018)

- **Settings:** `PUT /admin/attendance-guards` (`org.manage`, audited) holds the allowed CIDR ranges (IPv4/IPv6; every range is re-validated on the server) and the allowed countries (ISO codes). Empty lists switch the policy off.
- **What is logged:** each session records `ip_in` and the new `country_in` and `country_out`. The person's last country (`users.last_country`) feeds the travel check.
- **Proxy headers:** `CF-Connecting-IP` and `CF-IPCountry` are trusted only when `TRUST_PROXY_HEADERS=cloudflare`. Production must then accept traffic only from Cloudflare (the ALB security group in the Terraform slice); otherwise the headers could be forged. Without the setting, the socket address is used and the country is unknown (tested).

## 4. Review flags

- **Storage:** `attendance_flags` holds kind, category, details (the evidence), status OPEN/RESOLVED, outcome `NO_ACTION`/`FOLLOW_UP`, note, resolver and the person's comment. It has `org_id`, forced RLS and no DELETE grant.
- **Database rules:** CHECKs for state consistency, a minimum note length and not-self; a trigger requires the flag's session to belong to the same person and organisation.
- **API:** `GET /attendance/flags?scope=mine|review&status=`, `POST /attendance/flags/:id/resolve`, `POST /attendance/flags/:id/comment`.
- **Web:** **Attendance review** for reviewers. On **My attendance**, an "Items under review" section shows each flag in plain words, with "Nothing was changed or deducted" and the evidence. The daily table shows readable labels instead of codes.

## 5. Alerts (FR-ATT-021)

New notification types in a new **Attendance** group, subject to each person's preferences and quiet hours:
- `ATTENDANCE_NO_CLOCK_IN`: the person has not clocked in by schedule start + grace. Due for two hours, on working days only; not on holidays, approved leave or flexible schedules. Once per day. On by default.
- `ATTENDANCE_AUTO_CLOCK_OUT`: the server closed the session (no activity, connection lost, maximum length). It gives the reason in plain words and invites a correction.
- `ATTENDANCE_LONG_IDLE`: to the reviewer when a session has been paused for N minutes. **Off by default** (N = 0), for proportionality.
- `ATTENDANCE_FLAGS_TO_REVIEW`: to the reviewer when a person has at least N open items in 7 days (default 3). Once per ISO week.

The reviewer is the person's manager, else the team's leads and managers, else HR (the existing `approversFor` rule). These run in a new `attendance-alerts` job every 5 minutes, plus a hook on the reconciler's auto-close list.

## 6. Presence challenge (FR-ATT-023; state machine, tests first)

The option is off by default. When it is on and idle time reaches the pause threshold:
1. The session stays IDLE and gets a challenge id. Every socket of the person receives `attendance:challenge {id, expiresAt}`.
2. The web app shows an accessible "Are you still working?" dialog (focus on the answer). The desktop agent shows its window and a native notification.
3. A reply within **60 seconds (server clock)** (`POST /attendance/challenge`, or the socket event `attendance:challenge-response` from the agent) resumes ACTIVE without a long-idle flag. Real input in the window counts as a reply.
4. Without a reply, the next heartbeat, or the reconciler even without heartbeats, pauses the session **from the moment it was asked**. The question therefore never adds time: idle time stays idle and is not paid either way.
5. Late or wrong replies get 409.

The midnight split carries an open challenge into the new day's session, and also the agent's lead and the country. A test caught this when the suite ran across midnight.

## 7. Tests

- **Unit:**
  - `anti-spoofing.test.ts`: CIDR v4/v6, network policy, country distances, impossible travel, the three patterns.
  - `presence-challenge.test.ts`: off by default; issue, wait, reply, expiry by heartbeat and by the reconciler, late and wrong replies, input as a reply, midnight carry-over.
  - `agent-companion.test.ts`: agent lead and country across midnight.
- **API e2e `attendance-guards-e2e.test.ts`** (real sockets with Cloudflare headers):
  - settings validation and audit;
  - network flags, recorded once, with time unchanged;
  - impossible travel and multi-device;
  - forged headers ignored without trust;
  - rejected-signal flag;
  - reviewer scope (manager, HR, other employee 403, own only), comment, note required, self-resolve refused (API and DB);
  - no-clock-in reminder, long-idle alert, periodic pattern flag, weekly items alert, auto clock-out notice;
  - challenge via the socket event and reply, and expiry by the reconciler;
  - RLS and no DELETE.
- **Playwright `20-attendance-review.spec.ts`:** the person explains, the manager resolves with a note, employees have no review page, and the challenge dialog appears and resumes tracking.

## 8. Limitations

- Impossible travel works only at country level. A VPN exit looks like travel; that is why it only flags.
- Rejection and flood counters are kept in memory per API instance; Redis-backed counters come with the multi-instance work (ADR 005, Terraform slice).
- Changing the safeguard settings directly in the database takes up to 30 s to apply (the policy cache); the admin API clears the cache at once.
