# ADR 014: Data-Subject Export and Anonymisation

**Status:** Accepted
**Date:** 16 October 2026
**Requirements:** SRS 5.12 FR-AUD-002 (export as JSON/ZIP), FR-AUD-003 (deletion or anonymisation subject to legal retention, documented workflow); 6.7 guardrails; 10.3 (subjects can request access, correction and deletion).

## 1. Decision agreed with the product owner

| Topic | Decision |
| --- | --- |
| ZIP | **Hand-written on `node:zlib`** (`privacy/zip.ts`: deflate, CRC-32, local headers, central directory; no ZIP64, no encryption) instead of a new archive package. Unit-tested with a reader that checks CRCs. |

## 2. Export (FR-AUD-002)

- `GET /privacy/subjects/:userId/export?format=zip|json` for `privacy.manage` (HR manager, admin, super admin); `GET /me/export` for everyone, because access to one's own data is the data subject's right.
- **Sections** (one JSON file each in the ZIP, plus `README.txt` and `manifest.json` with SHA-256 per file): profile (with contracts, rate profile, schedules), consents, attendance (sessions, daily summaries, corrections, raw presence events), timesheets and entries, tasks (assigned, reported, comments, plans), documents (owned and linked metadata, own access history), notifications and preferences, sign-in sessions, and the person's own audit trail.
- **Not included:** document *content*. Confidential and password-protected files have their own access path (re-authentication, document password), and an export must never bypass them. Titles of CONFIDENTIAL/RESTRICTED documents appear as "(confidential)".
- Every export is audited (`DATA_SUBJECT_EXPORTED`, with `self`) and recorded as a COMPLETED `privacy_requests` row, so HR can show when and by whom data was handed out. At most 20 000 rows per section.

## 3. Anonymisation workflow (FR-AUD-003)

1. **Check** (`GET /privacy/subjects/:id/anonymisation-check`): blockers, what is retained on a legal basis, and what will be removed. Never yourself, never a super admin, never twice.
2. **Request** (`POST /privacy/requests`, reason ≥ 5 chars, audited): stored as PENDING or BLOCKED with the blockers of that moment. One open request per person (partial unique index).
3. **Execute** (`POST /privacy/requests/:id/execute`) re-runs the check, requires the person's email as confirmation, and refuses (409, request → BLOCKED) while anything blocks. Or **cancel**.

**Blockers** — obligations that must be settled first, because anonymising would break them: an open attendance session, pending correction requests, SUBMITTED timesheets, APPROVED/LOCKED timesheets with an amount not yet marked PAID, an ACTIVE contract (no end date or one in the future), and documents of the person under legal hold.

**Retained under the pseudonymous id** (shown to HR, not blockers): documents filed by someone else and linked to the person, and own documents still inside their category's minimum retention (ADR 010 rules); the hash-chained audit log (append-only; actor id, action, IP); consent records (evidence of the lawful basis for monitoring, including the IP they were given from); approved pay records (timesheets, amounts, rate profile).

**Removed or replaced**, in one transaction:
- `users`: email → `anonymised-<8 hex>@anonymised.invalid`, name → "Anonymised user", no password, no 2FA, status `ANONYMISED`, no team/manager/custom role/timezone, `anonymised_at` set. The row stays so foreign keys, audit and financial records keep their integrity; login and the permission resolver both refuse non-ACTIVE users, and all sessions are revoked (`ANONYMISED`) with IP and user agent cleared.
- Subordinates, led teams and managed projects are unlinked.
- Attendance sessions keep times and totals; IPs and device id are replaced. Correction reasons and review notes, time-entry notes and manual reasons, timesheet notes and the person's task comments are replaced by `[removed…]` markers.
- Deleted: daily and weekly plans, saved views, personal schedules, notification preferences, document grants to the person, device/nonce state, unaccepted invitations; **raw presence events and notifications are deleted by the retention role** (the app role has no DELETE on them), after the transaction commits.
- Own documents not under retention or hold are **crypto-shredded** (ADR 010 `shred`, reason `ANONYMISATION`) after commit.
- The lock guard on `time_entries` (FR-TS-006) gets a narrow bypass: inside a transaction that sets `app.anonymising`, an UPDATE may change only `note`/`manual_reason`. Minutes, dates, project and billing stay locked.
- Result counts are stored on the request and audited as `USER_ANONYMISED` (ids and counts only, never the removed values).

## 4. Data model

- `privacy_requests` (type EXPORT/ANONYMISE, status PENDING/BLOCKED/COMPLETED/CANCELLED, reason, blockers, result, timestamps), RLS forced, no DELETE for the app: the workflow record itself is evidence.
- `users.anonymised_at`.

## 5. Tests

- `zip.test.ts`: round trip of text, compressible and incompressible entries, CRCs, duplicate names, path traversal, empty archive.
- `privacy-e2e.test.ts` (6 tests): permission matrix and self-export ZIP with manifest hashes; HR JSON export, confidential titles hidden, cross-org 404s; the check with four blockers, retained counts and shred count; BLOCKED request, refused execution, duplicate 409, RLS on the list; cancel and reopen; execution after settling the obligations — pseudonymised user, dead token and login, raw events and notifications gone, IPs and free text replaced, team unlinked, sessions revoked, two documents shredded and the HR-filed one kept, pay record kept, audit chain still valid, a second check refused, and a re-export free of the personal values.
- Playwright `15-privacy.spec.ts`: self-service ZIP download; HR check, request and cancel without touching the person.

## 6. Known gaps and open points

- Free text written *about* the person by others (task descriptions, timesheet rejection reasons, contract titles such as "Eva contract") is not rewritten. Reviewing it is part of HR's manual checklist.
- Audit rows and consent records keep the IP addresses they were written with; they are append-only by design (ADR 001/FR-AUD-001). If a regulator requires otherwise, the only honest option is a documented exception, not an in-place edit of a hash-chained log.
- Exports do not include document content; a separate "download all my documents" is possible later through the vault's access path.
- There is no self-service deletion request button; the subject asks HR, as the SRS describes.
