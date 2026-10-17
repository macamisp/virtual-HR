# ADR 024: Meeting recording with consent

**Status:** Accepted
**Date:** 17 October 2026
**Requirements:**
- SRS 5.4 FR-MEET-007: encrypted recordings, a visible banner, a recorded-consent log, retention and ACL.
- FR-AUD-004: consent records.
- FR-ADM-004: retention per data type.
- SRS 13, "recording optional, off by default".
- SRS 10: encryption and least privilege.

## Decision

The owner chose **LiveKit Egress, off by default**.
- **Production:** LiveKit Cloud Egress, the same provider as the calls.
- **Local:** the `livekit/egress:v1.10.0` container, behind the compose profile `recording`.

Egress makes one composite (grid) MP4 of a meeting. No new npm package is used: Egress is called over Twirp with `fetch`, like the RoomService (ADR 016).

## Consent first

- **Off by default.** Recording is off until an admin enables it (`organizations.recording_enabled`, set under Admin → Data retention, `PUT /admin/recording`, audited). Office-room meetings cannot be recorded.
- **Request.** A host or co-host who is in the call asks (`POST /meetings/:id/recordings`). Asking counts as their own yes.
  - Everyone else in the call is asked over the socket (`meeting:recording-consent`).
  - The banner shows who is still being waited for.
- **Start.** Recording starts only when **every person in the call** has answered yes, within **2 minutes**.
  - One "no" cancels the request, and so does silence (the 5-minute maintenance job tidies up).
  - People who are in the call but missing from the list (a token issued earlier) are added and asked before anything starts.
- **Late joiners.** `POST /meetings/:id/join` returns `CONSENT_REQUIRED` while a recording is asked for or running, so nobody gets a token without answering.
  - Someone who connects with an old token anyway is removed from the LiveKit room at once (`participant_joined` webhook).
- **Withdrawal.** A recorded person who withdraws consent while it runs stops the recording. What was recorded with consent up to then is kept.
- **Consent log.** Every answer is a row in `recording_consents` (user, yes/no, notice version from `CONSENT_NOTICES.RECORDING`, server time, IP, browser). The app role may only insert and read it.
- **Banner.** A banner is shown to everyone while a recording is asked for, running or being saved.

## Storage and encryption

- **Upload.** Egress uploads the plaintext MP4 to `_recordings_staging/<org>/<id>.mp4`. This is a top-level prefix, so least privilege and lifecycle rules can target it.
- **Encryption.** On `egress_ended` (`EGRESS_COMPLETE`), a job (BullMQ, or in the background without Redis) encrypts the file:
  - streams it through AES-256-GCM with a **fresh data key**;
  - wraps the key with the KeyProvider (KMS in AWS; purpose `recording`, context = organisation + recording);
  - computes its SHA-256;
  - stores it at `<org>/_recordings/<id>`;
  - deletes the staging copy.
- **Retention.** Recordings are kept for the organisation's **recording retention** (default 90 days, 7–3650 days, Admin → Data retention), counted from the end of the recording. Then they are **crypto-shredded**: the object is removed, the wrapped key is nulled and the status becomes DELETED. The row and the consent log stay as history. Hosts can delete earlier.
- **Watching.** Only the host, co-hosts and the people who were recorded (they consented) can watch.
  - `GET /recordings/:id/content` decrypts and streams the file (`no-store`, sandboxed).
  - Every opening is audited (`RECORDING_VIEWED`).
  - Other invitees do not even see that a recording exists.
- **Errors.** Egress error texts (which can name storage settings) are not stored. The detail is a fixed sentence, and the audit log keeps only the Egress status.

## Production (Terraform)

`recording_enabled = true` in the environment's tfvars creates three things:
- an **upload-only IAM user** (`s3:PutObject` on `_recordings_staging/*` and nothing else, plus KMS through S3 only);
- two Secrets Manager slots, `recording-s3-access-key` and `recording-s3-secret-key`, injected as `RECORDING_S3_*`;
- `RECORDING_S3_BUCKET` and `RECORDING_S3_REGION` on the API tasks.

An operator creates the access key in IAM and pastes it into the secrets, so it never passes through Terraform state (runbook `docs/runbooks/meeting-recording.md`). LiveKit Cloud Egress receives that key with each start request, over TLS, and never the API's own role.

A lifecycle rule expires leftovers under `_recordings_staging/` after 2 days and their old versions after 1 day. The bucket is versioned, so without this rule a deleted plaintext copy would stay for 90 days as a noncurrent version.

## Status values

- `CONSENT`: asked, waiting for answers.
- `RECORDING`: Egress is running.
- `PROCESSING`: stopped; encrypting.
- `READY`: encrypted and watchable.
- `FAILED`: Egress could not start, or stopped with an error.
- `CANCELLED`: refused, expired or cancelled.
- `DELETED`: shredded.

A partial unique index allows one recording in progress per meeting. CHECKs make READY imply complete encryption metadata and an expiry, and DELETED imply that no key or object is left.

## Known limits

- **Seeking:** playback downloads the whole file (no HTTP range on decrypted streams). Fine for meeting lengths; very long recordings would want chunked encryption.
- **Layout:** a grid only; no per-speaker layouts or transcripts.
- **Local LiveKit and Redis:** LiveKit needs Redis for Egress, so `infra/livekit/livekit.dev.yaml` now points at the compose Redis (database 5).
