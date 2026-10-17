# ADR 022: Simple in-app electronic signatures

**Status:** Accepted
**Date:** 17 October 2026
**Requirements:** SRS 5.8 FR-DOC-014; FR-DOC-005 (re-authentication), FR-DOC-007 (encryption), FR-DOC-012 (access log), FR-DOC-013 (scanning).

## Decision

The owner chose a **simple in-app signature** rather than DocuSign. Signers draw or type their signature. The server stamps all signatures and an **audit certificate** into the PDF with pdf-lib, which the project already uses. No new package is added.

This is a *simple electronic signature* (eIDAS SES, ESIGN/UETA style). It is **not** a qualified or advanced signature: the PDF has no cryptographic signature. Where a contract legally needs more, use the optional DocuSign integration from SRS 13. The certificate page says this in plain words.

## Flow

1. **Request.** A user with MANAGE on a document asks 1–10 colleagues to sign (`POST /documents/:id/signature-requests`).
   - The current version must be a CLEAN PDF without a document password.
   - Only one request can be OPEN per document.
   - The server records that version's SHA-256 as the fingerprint. Signers get VIEW on the document and a notification.
2. **Sign** (`POST /signature-requests/:id/sign`). Signing is refused unless all of these hold:
   - The signer is a pending party, and the request is OPEN.
   - The document's current version is still the fingerprinted one.
   - The login has a fresh **re-authentication** (password or TOTP, the vault window from ADR 010). The web form always asks for it just before signing.
   - The **consent text version** sent matches the current `ESIGN_CONSENT`.
   - A drawn signature is a real PNG of at most 150 KB with plausible dimensions.

   The server records the method, the time (**server clock**), the IP address, the browser and the re-authentication time. Drawn images are **sealed** with a per-request data key wrapped by the KeyProvider (KMS in AWS; purpose `signature`, context = organisation + request). The access log records `SIGN` and the audit chain records `DOCUMENT_SIGNED`.
3. **Complete.** When the last signer signs, the server:
   - decrypts the source and **re-checks its SHA-256** (if it differs, nothing is produced);
   - appends a signature page (images or typed names, identity, time in UTC and the organisation's zone, IP) and an audit certificate (request, document, original fingerprint, events, consent text);
   - writes `hrvo-esign-request:<id>` and `hrvo-esign-source-sha256:<hash>` into the PDF keywords;
   - stores the result as a **new version** through the normal path: staging, ClamAV, encryption, then current.

   The signed file's SHA-256 is stored on the request and in the audit log. If stamping fails after the last signature, the request stays OPEN and the requester can retry with `POST /signature-requests/:id/finalize`.
4. **Verify** (`GET /signature-requests/:id/verify`). This compares the stored version hashes with the fingerprints recorded at request and completion time, and lists the events.

Signers can **decline** with a reason, which ends the request and notifies the requester. The requester or a document manager can **cancel** an OPEN request.

## Data and safeguards

- **Tables:** `signature_requests` and `signature_signers`. Both have `org_id` and forced RLS.
- **No deletes:** the app role has no DELETE or TRUNCATE on these tables, so evidence is never deleted by the app.
- **Final signatures:** a trigger makes a SIGNED signer row final.
- **CHECK constraints:**
  - a signed row must carry complete evidence (method, time, re-authentication, consent, IP, and the image or typed name);
  - COMPLETED requires the signed version and its hash;
  - hashes must be 64 lowercase hex characters.
- **Never logged:** signature images and document content.

## Known limits

- **Signing order:** signers may sign in any order; sequential signing isn't implemented.
- **Fonts:** the standard PDF fonts cover Latin-1 only. Other characters in names show as "?" on the certificate; the database keeps the exact text.
- **Who can sign:** only people with an account in the organisation. External signers would need DocuSign or a later share-link flow.
