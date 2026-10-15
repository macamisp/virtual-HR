# ADR 009: Documents and Secure Storage

**Status:** Accepted (slice 1: everything except the vault features)
**Date:** 15 October 2026
**Requirements:** SRS 5.8 FR-DOC-001..004, 007, 009, 012, 013, 015, 019; 3.3B; 7.4 documents, document_versions, document_acl, document_access_logs, contracts; §10.

## 1. Decisions agreed with the product owner (15 Oct 2026)

| Topic | Decision |
| --- | --- |
| S3 client | `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` **3.1144.0** (exact-pinned, released 30 Sep). ClamAV (clamd INSTREAM over TCP) and content sniffing are hand-written on Node built-ins. |
| Encryption at rest (FR-DOC-007) | **Now.** A per-version AES-256-GCM data key (DEK) is wrapped by a KMS key with the encryption context `{org_id, document_id}`. KMS is an interface: `LocalKms` (a 32-byte key from `.env`, refused in production) today, AWS KMS later. The vault extras (re-authentication, per-document password, recovery: FR-DOC-005, 006) stay for the vault slice; the `dek_wrapped_pw` columns are already there. |
| Contracts | A **minimal `contracts` table now**: SRS 7.4 columns, RLS, HR create and edit, people see their own. Documents and contracts link both ways. Renewal alerts (FR-ORG-003) come with the People & Org slice. |
| Default visibility | **The owner and the linked person see a document; HR and admins see everything; nobody else** without an explicit grant. Managers get no implicit access. Subcontractors only receive grants made to them by name or to the SUBCONTRACTOR role, never team grants. So by default they see only documents linked to them (FR-DOC-009). |

## 2. Upload pipeline (FR-DOC-001, 007, 013)

1. **Start** (`POST /documents/uploads`): the extension must be on the allow-list (`DOCUMENT_ALLOWED_TYPES`) and the size at most 100 MB.
   - The API creates the document (or a new version of one) and generates the version's DEK.
   - It stores only the KMS-wrapped DEK and the file name encrypted under that DEK.
   - It starts an S3 multipart upload under `{org}/_staging/{doc}/{version}` and returns 5-minute presigned UploadPart URLs (8 MiB parts).
2. **The browser PUTs the parts directly to storage.** Expired URLs are refreshed (`/parts`), and uploads resume (`GET /documents/uploads/:id` lists the parts already stored). A failed or cancelled upload is aborted.
3. **Complete:** the API finishes the multipart upload and checks the real size against the limit and the announced size, then marks the version PENDING and logs UPLOAD. The scanner is dispatched as a BullMQ job (`document-scan`, 6 attempts with backoff), or inline when `JOBS_ENABLED=false`.
4. **Scanner** (`DocumentScannerService`), one per version via an advisory lock:
   - **Sniff:** the first 4 KB, and for ZIPs the central directory read with two range requests, decide the type. The extension must match the content, and the browser's MIME type is never used. Refused: executables, HTML/SVG/XML, legacy OLE (.doc/.xls), macro-enabled Office (`vbaProject.bin`), and anything not on the list → **REJECTED**, staging deleted, uploader notified.
   - **ClamAV** (`zINSTREAM`): FOUND → **INFECTED**. The file is moved to `{org}/_quarantine/…` (never served, not even to HR), an access-log QUARANTINE entry and a hash-chained audit entry are written, and the uploader is notified in-app and by email. A clamd error is never treated as clean: the version stays PENDING and is retried by the job and the hourly maintenance.
   - **Clean:** the plaintext is streamed through a SHA-256 tap and AES-256-GCM into `{org}/{doc}/{version}`. The IV, auth tag and hash are stored and the staging copy deleted. The newest clean version becomes current.
5. **Nothing is downloadable or previewable until the version is CLEAN.**
   - Downloads and previews stream from storage through the API, which unwraps the DEK in memory and decrypts.
   - Responses carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, a `sandbox` CSP and an RFC 6266/5987 filename.
   - A tampered object fails the GCM tag check and aborts the stream.

The presigning clients set `requestChecksumCalculation: WHEN_REQUIRED`. Otherwise the current SDK signs a checksum of an empty body into the URL and every part fails (found in testing). Integrity comes from the part ETags at completion and the SHA-256 at encryption.

## 3. Data model (`20261018000000_documents`)

- `document_folders` (tree, names unique per parent case-insensitively, at most 8 levels).
- `documents`: SRS columns plus `version` for optimistic concurrency, and soft delete; `legal_hold` blocks deletion.
- `document_versions`: SRS columns plus `staging_key`, `upload_id`, `declared_size`, `auth_tag`, `restored_from_id`, `scan_detail`. Status values: UPLOADING, PENDING, CLEAN, INFECTED, REJECTED. A CHECK makes CLEAN impossible without the key material and hash.
- `document_acl` (document **or** folder; USER/TEAM id or ROLE name; VIEW/DOWNLOAD/EDIT/MANAGE; optional expiry; unique per grant).
- `document_access_logs`: bigint identity with no FKs to documents or users, so rows never change.
- `contracts` (§1).
- RLS is forced on all tables. `hrvo_app` cannot delete documents, versions or contracts.
- **FR-DOC-012:** the app role has only `INSERT` and `SELECT` on `document_access_logs`; UPDATE, DELETE and TRUNCATE are revoked (tested).
- `fn_acl_level(document, folder, user, role, team)` is a SQL function returning the strongest unexpired grant, inherited through ancestor folders. It is used both for single checks and for list filtering, so the list and the detail can never disagree.

## 4. Behaviour

- **Effective level** (pure, unit-tested): HR or owner = MANAGE; linked person = DOWNLOAD; otherwise the ACL. VIEW = details and preview; DOWNLOAD = files; EDIT = metadata and new versions; MANAGE = sharing, access log and deletion.
  - Folders are created top-level by HR, sub-folders by folder managers; uploading into a folder needs EDIT on it.
  - Only HR links a document to someone else (others may only link themselves); a subcontractor's upload is linked to them automatically.
  - Only contract managers link contracts.
  - An invisible document and a missing one both return 404.
- **Versions (FR-DOC-004):** every upload is a new version. A restore creates another version that reuses the old ciphertext and key, so nothing is ever overwritten. Only one upload per document can be in flight at a time.
- **Access log (FR-DOC-012):** VIEW (details and preview), DOWNLOAD, UPLOAD, UPDATE, RESTORE, ACL_CHANGE (grant and revoke, with principal, permission and expiry) and DELETE are logged; QUARANTINE has no user. Each entry records user, IP and user agent.
  - Document managers see their document's log.
  - Audit readers (`audit.read`, which includes the Finance/Auditor role) see the organisation-wide log, filterable and exportable as formula-safe CSV.
- **Preview (FR-DOC-019):** PDFs and images only. The web app fetches with the access token and shows a `blob:` URL, so the web CSP gains `img-src blob:` and `frame-src blob:`. Office conversion is not built.
- **Expiry reminders (FR-DOC-015):** the hourly `document-maintenance` job sends 60, 30 and 7 days before `expires_at`, to the owner and HR, in-app and by email.
  - Only the tightest stage reached is sent, so a document added with 5 days left gets only the 7-day reminder.
  - Reminders are deduplicated per document, expiry date and stage, so re-runs and several instances never send twice.
  - The same job aborts multipart uploads abandoned for more than 24 h, and re-dispatches scans stuck PENDING for more than 10 min.
- **Share targets:** `GET /documents/share-targets` feeds the sharing form. Subcontractors only get HR, their manager and their team's leads, not the staff directory.
- **Contracts:** HR records a contract and links the signed document; the link is set on both sides and the document gets the contract's person as its linked user. One document belongs to at most one contract. Creates and updates are audited.

## 5. Operations

- **New settings:** `DOCUMENT_KMS_PROVIDER`, `DOCUMENT_KMS_LOCAL_KEY`, `DOCUMENT_KMS_LOCAL_KEY_ID`, `DOCUMENT_ALLOWED_TYPES`, `CLAMAV_HOST`, `CLAMAV_PORT`, `CLAMAV_TIMEOUT_MS`, `S3_PUBLIC_ENDPOINT`, `S3_CREATE_BUCKET` (dev), and `NEXT_PUBLIC_STORAGE_URL` (web CSP `connect-src` for the browser's direct uploads).
- **The API refuses to start without `DOCUMENT_KMS_LOCAL_KEY`.** CI generates one per run; nothing is committed.
- **Production S3** needs a bucket CORS rule allowing `PUT` from the web origin and exposing `ETag`. Keep the bucket private.
- **clamd** must accept streams of 100 MB (`StreamMaxLength` of at least 100M, the default).
- **Tests and CI:** run against **SeaweedFS 4.48** (S3 mode) and **ClamAV 1.4**, started as CI steps.
  - The MinIO image pinned in `docker-compose.yml` (`minio/minio:RELEASE.2024-01-18…`) can no longer be pulled: MinIO stopped publishing community images, and both Docker Hub and quay.io deny it.
  - `clamav/clamav:1.3` does not exist either.
  - Fixing local Compose needs a decision (see the report).
- **Test concurrency:** API tests now run with `--test-concurrency=4`. With one more app-per-file e2e suite, running every file at once exhausted Postgres's 100 connections ("remaining connection slots are reserved"), and the planning tests failed intermittently.

## 6. Tests

- `document-rules.test.ts` (written first):
  - KMS wrap/unwrap bound to the context; tampering, wrong key and wrong key id are refused;
  - streaming GCM round-trip and tamper detection; the production guard;
  - sniffing of every allowed type, ZIP central-directory parsing, the refused types and the extension/content matrix;
  - the clamd protocol against a fake server (OK, FOUND, ERROR, unreachable);
  - the permission levels.
- `documents-e2e.test.ts` (19 tests, real SeaweedFS and clamd):
  - **Upload, sniffing, scanning:** presigned upload, byte-identical download, ciphertext at rest, staging removed, file name encrypted; multipart upload with resume; allow-list and size limit; sniffing refusals; EICAR quarantine with notification, log and audit.
  - **Versions:** versions and restore.
  - **Access:** default visibility; links only by HR; team grants exclude subcontractors; user and role grants with expiry, and the level of each action; folder inheritance; preview limits.
  - **Contracts:** linked both ways, own-only for the person.
  - **Access log:** contents, immutability and scopes, with CSV.
  - **Jobs:** expiry stages (only the tightest, once); abandoned uploads.
  - **RLS** on all six tables.
- Playwright `10-documents.spec.ts`: upload from the browser straight to storage, preview, download, new version and restore; sharing with View only (preview, no download, no sharing panel); a subcontractor's empty list; an EICAR upload quarantined, with the bell notice.

## 7. Known gaps

- Vault features (FR-DOC-005 re-authentication, FR-DOC-006 document passwords and recovery), share links (010), view-only watermarking (011), e-signature (014), search inside files (016), retention and crypto-shredding (017), policy acknowledgement (018), Office preview (019, second half) and bulk ZIP download (020).
- Titles of confidential documents are not encrypted yet (FR-DOC-007 asks for file names, which are). Planned with the vault.
- Re-scanning stored files when ClamAV signatures update is not done.
- Contract renewal alerts and the rest of the contracts screens come with the People & Org slice.
