# Traceability: Documents (SRS 5.8)

| Requirement | Implementation | Tests |
| --- | --- | --- |
| FR-DOC-001 upload, 100 MB, resumable multipart, allowed types | `documents.service.ts` start/parts/state/complete, `object-store.ts`, `sniff.ts`, web `uploader.ts` | document-rules "Content sniffing", documents-e2e upload tests, Playwright 10 |
| FR-DOC-002 folders and fixed categories | `folders.service.ts`, `document_folders`, categories in shared types | documents-e2e "folder grants are inherited…" |
| FR-DOC-003 metadata and links (user, contract, project) | `checkMeta`, `update`, contracts link | documents-e2e "only HR links…", contracts |
| FR-DOC-004 versions with restore | `restore`, scanner "newest clean becomes current" | documents-e2e versions, Playwright 10 |
| FR-DOC-007 encryption at rest | `crypto.ts`, scanner encrypt step, `open` | document-rules "Envelope encryption", documents-e2e ciphertext at rest |
| FR-DOC-009 ACL users/roles/teams, folders, expiry; subcontractor default | `fn_acl_level`, `document-policy.ts`, grant/revoke | document-rules permissions, documents-e2e "Access control", Playwright 10 sharing |
| FR-DOC-012 access logging, immutable, exportable | `logAccess`, grants (INSERT/SELECT only), `accessLog` + CSV | documents-e2e "Access log" |
| FR-DOC-013 ClamAV before availability, quarantine, notify | `clamav.ts`, `document-scanner.service.ts` | document-rules clamd protocol, documents-e2e EICAR, Playwright 10 |
| FR-DOC-015 expiry reminders 60/30/7 | `document-maintenance.service.ts` | documents-e2e "60/30/7 days…" |
| FR-DOC-019 preview PDFs and images | `open(…, 'preview')`, web `Preview` | documents-e2e preview, Playwright 10 |
| SRS 7.4 contracts | `contracts.service.ts`, `contracts` table | documents-e2e "Contracts" |

Decisions and known gaps: ADR 009.
