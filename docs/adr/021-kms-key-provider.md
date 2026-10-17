# ADR 021: AWS KMS key provider for documents

**Status:** Accepted
**Date:** 17 October 2026
**Requirements:** SRS 10.1 steps 2 and 5 (KMS wrapping with encryption context; recovery under a separate key), FR-DOC-007; ADR 009, 010, 020.

## Decisions

| Topic | Decision |
| --- | --- |
| Client | `@aws-sdk/client-kms` **3.1144.0**: same AWS SDK family and version as the existing `client-s3`, exact pin, approved. |
| Local testing | **moto server** (`motoserver/moto:5.2.3`, Apache-2.0, no account), not LocalStack: current LocalStack images refuse to start without an account token. Confirmed with the owner. moto enforces the encryption context and key ids like AWS KMS (verified before writing the tests). |

## Design

- **`KmsKeyProvider`:**
  - **Wrapping:** keys are wrapped with `Encrypt` under `DOCUMENT_KMS_KEY_ID` (data, metadata and password-mode keys), and recovery escrow under the **separate** `DOCUMENT_KMS_RECOVERY_KEY_ID`.
  - **Encryption context:** always `{org_id, document_id[, purpose]}`, with the same fields as the local provider's authenticated data.
  - **Unwrapping:** `Decrypt` pins `KeyId`, so a blob from another key is refused by KMS. The provider also refuses unknown key ids and a purpose/key mismatch before calling KMS.
  - **Key policy:** both keys accept use only from the API task role, and only with the context present (Terraform, ADR 020).
  - **Where keys live:** plaintext keys stay in memory; only the wrapped form and the key ARN are stored.
- **Selection (`keyProviderFromEnv`):**
  - `DOCUMENT_KMS_PROVIDER=aws` uses KMS. Both key ids are required and must differ.
  - In production, a custom endpoint (an emulator) and local keys are refused, and so is the local provider itself (as before).
- **Migration:**
  - Outside production, local keys next to `aws` give a **`CompositeKeyProvider`**: new wraps go to KMS and old local wraps still open.
  - **`rewrapDocumentKeys`** (CLI `rewrap-cli.js --operator "<name>"`) moves every wrapped key of a version (data, password, recovery escrow) in **one transaction**, and each document's metadata key, to KMS. It is idempotent and audited per organisation as `DOCUMENT_KEYS_REWRAPPED`, marked `system: true` with the operator's name. The actor is the organisation's most senior active administrator, because the audit log requires a user. The data keys themselves never change, so stored content needs no re-encryption.

## Tests

- **`kms-key-provider.test.ts`** (moto): round trip; no opening for another organisation, document or purpose; recovery vs data keys are not interchangeable; unknown key ids; the migration provider; environment rules (production refusals, both ids, different ids).
- **`rewrap-keys.test.ts`** (moto + Postgres): all four wrapped keys move and still open to the same keys; audited; a second run moves nothing.
- **The full document and vault suites (67 tests) also pass with `DOCUMENT_KMS_PROVIDER=aws` against moto.** One assertion was made provider-aware (the stored key id is the KMS key ARN).

## Operations

Staging and production run `DOCUMENT_KMS_PROVIDER=aws` (set by Terraform). Neither ever ran on local keys, so there is nothing to re-wrap there; the re-wrap is for development and demo data. The API image's production guard against the local provider (found in ADR 020) is now satisfied by configuration.
