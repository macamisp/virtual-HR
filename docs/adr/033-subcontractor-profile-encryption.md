# ADR 033: Subcontractor profile with application-layer encryption of tax and bank details

**Status:** Accepted
**Date:** 19 October 2026
**Requirements:** FR-ORG-002 (legal name, company, country, contact details, tax ID (encrypted), bank details (encrypted), rate type, rate, currency, overtime multiplier, emergency contact). SRS 7.4 `subcontractor_profiles`, 10.1 (envelope encryption), 10.3.

## Problem

`subcontractor_profiles` held rates only. There was no legal name, company, country, contact or emergency contact, and no tax ID or bank details.

## Decision

**Table.** A new table `subcontractor_details` (one row per subcontractor, RLS forced, `org_id` policy). Rates stay in `subcontractor_profiles`, whose NOT NULL rate columns payable computation relies on (FR-TS-009); an HR record created before rates exist could not live there. This deviates from SRS 7.4, which puts `tax_id_enc` and `bank_details_enc` on `subcontractor_profiles`; the meaning is the same.

**Encryption** (`apps/api/src/org/profile-crypto.ts`, tests written first):
- Each profile has its own 256-bit data key, wrapped by the existing `KeyProvider` (local key in development, AWS KMS in staging and production; ADR 021) with the context `{org_id, document_id = user id, purpose = profile}`. Only the wrapped key is stored (`dek_wrapped`, `dek_key_id`).
- Tax ID and bank details (JSON) are sealed with AES-256-GCM: `version | iv(12) | tag(16) | ciphertext`, random IV per write, with `{org_id, user_id, field}` as authenticated data. A ciphertext copied to another field, person or tenant does not open (tested at the API by copying one person's tax ID into another's row).
- No partial values are stored in clear (no "last 4" column). Masked views decrypt in memory and show the last four characters.
- CHECKs: ciphertext never exists without a wrapped key; the key and its id come together.

**Field-level permissions** (owner's choice, 19 October 2026):

| Who | Identity, contact, emergency contact | Tax ID and bank details | Rates |
| --- | --- | --- | --- |
| The subcontractor (own profile) | read; edit contact and emergency contact (identity is HR's) | read masked, reveal, replace | read |
| `subcontractors.read` (HR, HR manager, admin, super admin) | read | masked | if they can see rates (`rates.manage` or `timesheets.read.all`) |
| `subcontractors.manage` (same roles) | edit everything | replace (write only for plain HR) | — |
| `subcontractors.sensitive.read` (HR manager, admin, super admin; requires 2FA) | — | reveal | — |
| Anyone else, including other subcontractors | 403 | 403 | 403 |

Routes: `/me/subcontractor-profile` (GET, PUT, POST `/reveal`) acts only on the caller; `/subcontractors` (GET), `/subcontractors/:id/profile` (GET, PUT) and `/subcontractors/:id/profile/reveal` (POST) carry their permission. Clear values come only from the `reveal` POST, never from a GET, so nothing is prefetched or cached; responses are `Cache-Control: no-store`. In the browser, the reveal is a mutation with no cache (`gcTime: 0`), held in component state and hidden after 60 seconds.

**Every read is audited:** `SUBCONTRACTOR_LIST_READ`, `SUBCONTRACTOR_PROFILE_READ` (masked), `SUBCONTRACTOR_SENSITIVE_READ` (which fields were revealed), `SUBCONTRACTOR_PROFILE_UPDATED` (changed field names). Audit entries name fields, never values.

**Never logged in plain text:** no request-body logging exists; a decryption failure logs only the profile id. A test captures everything the process writes during the suite and checks no secret appears, with a control that proves the capture works.

**Privacy:** the personal data export includes the profile with "on file" flags for tax and bank (the person reveals them in the app); anonymisation deletes the row.

## Proof

`subcontractor-profile-e2e`: a subcontractor (and an employee and a lead) gets 403 on another person's profile, reveal, edit and the list. The **database dump test** renders every row of every table as text (the form `pg_dump` writes, bytea as hex) and finds neither tax ID, account number nor SWIFT code, in plain, hex or base64 form. A positive control (the plain-text company name) proves the scan reads the profile rows.

## Consequences

- Each masked profile view costs one key unwrap (one KMS Decrypt call in production). Lists show only "on file" and decrypt nothing.
- Rotating the KMS key needs no data change. Rotating a profile's data key means re-sealing two fields; not implemented.
- Not done: a notification to the person when their bank details change (an anti-fraud control worth adding next).
