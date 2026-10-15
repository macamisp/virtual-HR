# ADR 010: Confidential Vault

**Status:** Accepted
**Date:** 15 October 2026
**Requirements:** SRS 5.8 FR-DOC-005, 006, 007, 008 (in part), 010, 011, 017; 10.1 encryption design; 7.4 documents, document_versions, share links. Builds on ADR 009.

## 1. Decisions agreed with the product owner (15 Oct 2026)

| Topic | Decision |
| --- | --- |
| Watermarking | `pdf-lib` **1.17.1**, exact-pinned. It is pure JS with no native code; its last release was in 2021, so it is stable but no longer actively maintained. PDFs are stamped on every page. PNG and JPEG are placed on a one-page PDF and stamped. GIF and WEBP have no view-only mode. Anything that cannot be stamped (a broken or encrypted PDF) is refused, never served unmarked. |
| Delete | **Trash for 30 days, then crypto-shred.** Owners, managers and HR can restore from the trash during that time. A daily job then destroys the keys and the objects. Legal hold blocks both steps. |
| Retention | Per category: **keep at least N years** (deletion refused before that) and optionally **destroy after M years**, where M ≥ N. No rules by default; HR managers and admins set them. Legal hold overrides everything. |
| Titles | **Titles of CONFIDENTIAL and RESTRICTED documents are encrypted** (SRS 7.4 `title_enc`). They are sealed with a per-document metadata key that the KMS wraps, and decrypted only for people who can see the document. Title search skips them. |

## 2. Keys (SRS 10.1)

- **`KeyProvider`** (renamed from `KmsProvider`): `wrap` and `unwrap` with the encryption context `{org_id, document_id, purpose}`.
  - Purposes: `data` (the version's DEK), `metadata` (the title key), `password` (the outer layer in password mode) and `recovery` (the escrow).
  - `data` keeps the original two-field context, so keys wrapped before this ADR still open.
  - `LocalKeyProvider` has **two keys**: `DOCUMENT_KMS_LOCAL_KEY` for data, metadata and password, and `DOCUMENT_KMS_RECOVERY_KEY` for the escrow only. They must differ, and the local provider is refused in production. An AWS KMS adapter means two KMS keys with separate IAM policies.
- **Normal mode:** `dek_wrapped_kms = KMS(DEK)`.
- **Password mode (FR-DOC-006):**
  - `dek_wrapped_pw = KMS_password(AES-GCM_{Argon2id(password, pw_salt)}(DEK))`. Opening needs **both** the KMS and the password; KMS access alone yields only the password-wrapped key (unit-tested).
  - Argon2id runs at 64 MiB, 3 passes, parallelism 1, with a random 16-byte salt per version. The parameters are stored in `pw_kdf_params`.
  - `dek_wrapped_recovery = KMS_recovery(DEK)` is the escrow for `vault.recover`.
  - `dek_wrapped_kms` is NULL. While a new protected version waits for its virus scan, a KMS-only wrap exists for the scanner and is destroyed when the scan finishes (tested).
- **No plaintext keys are kept or logged.** DEKs, title keys and password keys are zero-filled after use. The document password is never stored, and audit entries carry no password.
- **What a dump contains:** a DB dump plus a bucket dump holds only ciphertext, wrapped keys, sealed file names, sealed confidential titles, and the SHA-256 of each plaintext (kept as integrity and e-signature evidence; it does not reveal content). Proven by the e2e test that dumps every table and every object and searches for the content, file name and title, as text and as hex.

## 3. Behaviour

- **Re-authentication (FR-DOC-005):** `POST /vault/reauth` takes the account password, or a TOTP code when 2FA is on. It is recorded per login (session family) in `vault_reauth`, because access tokens rotate.
  - Content of CONFIDENTIAL and RESTRICTED documents (download, preview, view-only) needs a re-authentication within `organizations.vault_reauth_minutes` (default 10, range 1–60). Details and listings do not.
  - When the window has lapsed the API returns 403 with `code: REAUTH_REQUIRED` and writes an access-log entry. Successful and failed re-authentications go to the hash-chained audit log.
- **Document password (FR-DOC-006):**
  - Set, change or remove: the owner or HR, with MANAGE. Changing or removing needs the current password. Setting a password revokes all share links.
  - Content of protected documents goes through `POST /documents/:id/content`, so the password is never in a URL. A new version needs the password too.
  - A wrong password returns 403 `WRONG_DOCUMENT_PASSWORD` and logs `PASSWORD_FAIL`. The 3rd failure locks that user out of that document for 15 minutes (423 `LOCKED`, even with the right password) and notifies HR.
  - The failure is recorded in its own transaction with `lock_timeout`.
  - **Bug found by the tests and fixed:** a cross-connection deadlock. The document is now locked `FOR NO KEY UPDATE`, which no longer blocks the foreign-key check of the attempts row.
- **Recovery:** only `vault.recover` (HR manager, super admin). Every version is re-wrapped from the escrow with a new password and the lockouts are cleared. The action is logged as `RECOVER` with a reason, audited as `VAULT_RECOVER`, and the owner is notified by email.
- **View-only (FR-DOC-011):** VIEW level is enough. The server decrypts, stamps "viewer · time UTC · IP · view only" diagonally across every page plus a footer line, and serves `inline` with `X-View-Only: 1` and no download in the UI.
  - **The original file now needs DOWNLOAD:** a VIEW-only user who asks for a preview gets the watermarked rendering.
  - Abilities gained `canViewOnly`, and `canPreview` now means "the original, inline".
- **Share links (FR-DOC-010):**
  - Created by MANAGE. The token is 256 random bits and only its SHA-256 is stored; the link URL is shown once.
  - Expiry is mandatory, at most 90 days. Optional: a maximum number of openings, an Argon2id link password, view-only mode.
  - RESTRICTED and password-protected documents cannot be shared. CONFIDENTIAL ones need a link password.
  - The public routes (`GET /share/:token`, `POST /share/:token/open`) are unauthenticated and rate-limited.
    - A SECURITY DEFINER function maps the token hash to the link and org; everything else runs under RLS.
    - Every unusable link (unknown, expired, revoked, exhausted, or its document deleted, protected or restricted since) gives the same 404.
    - Every opening counts against the limit atomically and is logged with `user_id` NULL, the link id, IP and user agent.
    - Five wrong link passwords revoke the link and notify its creator.
    - A link opens only its own document; request parameters are ignored (tested).
- **Trash, shredding, legal hold, retention (FR-DOC-017):**
  - `DELETE` moves a document to the trash (`deleted_at`, `deleted_by`). It is refused under legal hold or within the minimum retention.
  - Trash entries are restorable for 30 days by people with MANAGE.
  - **Daily maintenance shreds** trash older than 30 days and documents past their auto-shred age. Shredding:
    - destroys every wrapped key (data, password, escrow), the sealed file names and the title key;
    - empties the title and tags, revokes the links and removes the ACL;
    - deletes the objects;
    - keeps the row as a tombstone and writes `SHRED` to the access log and `DOCUMENT_SHREDDED` to the audit log.
  - Legal hold: `documents.legal_hold` (HR manager, admin), with a mandatory reason, audited.
  - Retention rules: `documents.retention` to change, everyone to read.
- **No information leak:**
  - Without access, every document route answers 404 with the same message as a missing document, and the body names nothing.
  - Too low a level is 403 with a generic message.
  - Confidential titles are kept out of notifications, emails and logs ("a confidential document", "(confidential)").
  - The maintenance job seals any confidential title still stored in clear. The new `documents_confidential_title_check` is `NOT VALID` until that has run on existing data.
- **FR-DOC-008 (in transit):** unchanged and out of this code's scope. TLS 1.2+ and HSTS are deployment settings: Cloudflare or the load balancer, plus `Strict-Transport-Security` from the API's Helmet configuration.

## 4. Data model (`20261019000000_vault`)

- **Changed tables:**
  - `organizations.vault_reauth_minutes`.
  - `documents`: `title` becomes nullable; adds `title_enc`, `meta_key_wrapped`, `meta_key_id`, the legal-hold reason, by and at, `deleted_by`, `shredded_at`.
  - `document_versions`: `file_name_enc` and `dek_wrapped_kms` become nullable (password mode, shredding); adds `dek_wrapped_recovery`, `recovery_key_id`.
- **New tables:** `vault_reauth`, `document_password_attempts`, `document_share_links`, `document_retention_rules`, all with RLS forced. The app cannot delete re-auth records, attempts or links.
- **New access-log actions:** SHRED, TRASH_RESTORE, LEGAL_HOLD, PASSWORD_SET, PASSWORD_REMOVED, REAUTH_REQUIRED.
- **Permissions:** `vault.recover` (HR manager, super admin); `documents.legal_hold` and `documents.retention` (HR manager, admin, super admin).
- **Rate limits:** `RATE_LIMIT_VAULT` (default 20/min) for re-authentication, password and upload start; `RATE_LIMIT_SHARE` (default 30/min) for the public link routes.

## 5. Tests

- **`vault-rules.test.ts`** (written first):
  - key purposes and the separate recovery key;
  - the production guard;
  - Argon2id parameters, determinism and salt;
  - the password wrap: wrong password, tampering, and both layers needed;
  - share tokens;
  - the re-auth window boundaries, the lockout, retention and trash rules;
  - watermarking: every page, images, refusal of broken PDFs.
- **`vault-e2e.test.ts`** (21 tests, real SeaweedFS and clamd):
  - **Re-auth:** required, wrong password, expiry, TOTP.
  - **Dumps:** DB and bucket dumps reveal nothing; confidential titles are not searchable.
  - **Tampering:** a tampered ciphertext is aborted; a tampered wrapped key fails without revealing anything.
  - **Password:** set (the KMS-only wrap is gone, parameters stored, never logged); wrong passwords and the lockout with HR notified; a new version needs the password; recovery (permission, audit, owner told); removal.
  - **No-access matrix:** 404 on every route with identical messages; 403 for a lower level; VIEW gets the watermark with the viewer's name.
  - **Share links:** token hashing, limits, revocation, expiry, uniform 404s, a link never reaching another document, sharing rules, a view-only link with a password, and lockout after five failures.
  - **Trash, shred, hold, retention:** restore; shred destroys keys and objects; legal hold; minimum retention and auto-shred.
- **`documents-e2e.test.ts`** is updated for view-only, and its fixture is now a real PDF.
- **Playwright `11-vault.spec.ts`:**
  - the re-auth dialog (wrong, then right password) before a confidential preview;
  - setting a document password, then the unlock dialog (wrong, then right);
  - a public share link with View and Download, a bad-token message, and revocation;
  - a colleague with View access sees the watermark note and no Download;
  - trash and restore.

## 6. Known gaps

- Share links have no per-link ACL beyond the token and password, by design. There is no link analytics page beyond the list and the access log.
- No AWS KMS adapter yet; LocalKeyProvider only, refused in production.
- Re-authentication accepts TOTP codes without replay tracking within their 30-second step, as login does.
- The SHA-256 of each plaintext stays in the database (integrity and e-signature evidence).
- View-only rendering buffers the whole file in memory (at most 100 MB).
- Shredding deletes objects best-effort after the keys are gone. A failed delete leaves ciphertext that can no longer be decrypted.
