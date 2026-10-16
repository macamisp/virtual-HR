# ADR 018: Desktop agent and offline buffering

**Status:** Accepted
**Date:** 16 October 2026
**Requirements:** SRS 5.5 FR-ATT-011, FR-ATT-012 (also FR-ATT-006, 010, 020); 10.2 heartbeat forgery; 11 proportionate monitoring.

## 1. Decisions agreed with the product owner

| Topic | Decision |
| --- | --- |
| Framework | **Electron 43.7.7** with **electron-builder 26.17.0**, exact-pinned devDependencies of `apps/agent` only (43.8.0 was under two weeks old). Runtime libraries are ones the repo already uses (`socket.io-client`, `zod`). |
| Sign-in | **Pairing code.** The signed-in web user creates a one-time code (8 characters from an unambiguous alphabet, shown `XXXX-XXXX`, ~39 bits, 5 minutes, one use; only its SHA-256 is stored). The agent redeems it and gets its **own auth session family**; it never sees a password. 8 characters rather than 6 digits: a redeemed code is a full login. |
| Offline | **Accept, flag, cap 12 h.** Buffered time counts at once, is flagged `OFFLINE_SYNCED` for review and fills only gaps the server did not see. |
| Platforms | Windows (NSIS), macOS (DMG), Linux (AppImage, deb). Built and tested end to end on Linux here; Windows and macOS installers are built by CI on their runners, unsigned. |
| Clock rule | **Server-anchored offline time** — the agreed exception to AGENTS.md "server clock only" (section 4). |

## 2. What the agent reads (proportionate monitoring)

Only `powerMonitor.getSystemIdleTime()` (seconds since the last keyboard/mouse input anywhere on the computer) and the lock state. Per 30-second interval: `active = 30 − min(30, idle)`, locked = all idle. Never keystrokes, screens, window titles, URLs, files or application names. Heartbeats carry the same counters as the browser's (FR-ATT-004).

- **Explicit consent** (FR-ATT-011): before pairing, the agent shows the server's `DESKTOP_AGENT` notice (what is and is not read, the tray icon, offline handling) with an unchecked "I agree" box; "Decline and quit" is offered. The accepted version is sent with the pairing and recorded in `monitoring_consents` (type `DESKTOP_AGENT`, audited). A changed notice version is refused (409). Withdrawing the consent on *My consents* revokes every agent of that user; it cannot be granted from the web.
- **Tray icon at all times**: created before anything else; if the desktop cannot show it, the agent shows an error and exits, so it never tracks invisibly. Closing the window hides it to the tray; *Quit (stops tracking)* is always in the tray menu. Colour and tooltip show the state (tracking active/idle, offline with the buffered count, not connected, stopped).
- The window is sandboxed (context isolation, no Node, strict CSP, no navigation); only the main process talks to the API.

## 3. Agent sessions on the server

- `agent_devices` (name, platform, version, `family_id`, last seen, revoked) — RLS, no DELETE grant. Pairing creates the device and its auth session through `AuthService.issueAgentSession` (same audit as a login). `POST /agent/token {deviceId, refreshToken}` rotates through the normal refresh logic (reuse detection included) and is refused (and the new family revoked) unless the family belongs to that unrevoked device — a browser refresh token cannot be used there.
- The gateway decides **server-side** whether a socket is an agent (its session family is a paired device) and forces the heartbeat's `deviceId` to the paired device; a heartbeat signed for another device id fails the HMAC check.
- **Agent next to a browser** (state machine, tests first): the agent's OS-level counters lead while it reported within the heartbeat timeout (90 s); browser heartbeats then only keep the session alive and pass on `inCall`, so a call in the browser keeps agent-reported idle time ACTIVE (FR-ATT-006). Agent + browser is one person at one computer and is **not** `MULTI_DEVICE`; two agents, or two browsers without an agent, still are (FR-ATT-010). New session columns: `agent_device_id`, `agent_last_seen_at`, `web_in_call_at`. A session started by the agent has `clock_in_source = AGENT`; the raw events show `source` (FR-ATT-020).
- Revoking a device (owner, or `org.manage` for anyone) revokes its session family: sockets drop at once via `hrvo_auth_events`, and token refresh fails.

## 4. Offline buffering without trusting the device clock (FR-ATT-012)

1. Every agent heartbeat acknowledgement carries an **anchor**: the server time and an HMAC-SHA256 over org, user, device and that time (key derived from the JWT secret with HKDF, `hrvo-agent-anchor-v1`).
2. Offline, the agent records each 30-second interval as `{offsetMs, active, idle}`, where `offsetMs` is the start of the interval on a **monotonic** clock relative to the anchor. No wall-clock time is stored or sent; changing the PC clock has no effect. A monotonic clock restarts with the process, so after a restart the old anchor cannot be extended (its batches are still uploaded; later offline time is not recorded and the agent says so).
3. The buffer is encrypted at rest with Electron `safeStorage` (OS keychain); at most 1440 intervals (12 h) per anchor.
4. On reconnect the agent uploads each batch with a stable `batchId` to `POST /agent/offline-sync` (agent sessions only). The server verifies the anchor, rebuilds each interval as *anchor + offset*, and keeps only intervals that are complete before the server's "now", within 12 h of the anchor, at most 30 s of counters, in order, and **not overlapping any time the server already accounts for** (its own sessions). It runs under the same per-user lock as heartbeats. Accepted time becomes CLOSED sessions (`clock_in_source = OFFLINE_SYNC`, ACTIVE/IDLE segments, a new session after a 90 s gap, split at midnight in the org time zone), flagged `OFFLINE_SYNCED` on the session and segments; the daily summary is recomputed; a raw `OFFLINE_SYNC` event and an audit entry are written. `offline_sync_batches` (append-only) records each batch's outcome; a repeated `batchId` is a no-op.

**Residual risk, accepted:** counters in the buffer are asserted by the user's own computer (the user can read their keychain). The controls are the 30 s/interval and 12 h caps, gap-only acceptance, the time anchor the user cannot forge, and the `OFFLINE_SYNCED` review flag. Nothing is ever penalised automatically.

## 5. Tests

- Unit (written first): `agent-companion.test.ts` (state machine: no double count, no MULTI_DEVICE for agent + browser, two agents flagged, calls keep ACTIVE, agent idle → IDLE), `offline-sync.test.ts` (anchor signatures; rebuild from anchor; overlap, future, stale, malformed, 12 h cap, sessions, segments, midnight split), `apps/agent/test/tracker.test.ts` (idle measurement, buffer offsets, batches, restart, corrupt data).
- API e2e `agent-e2e.test.ts`: pairing (consent version, single use, expiry, strict schema), token rotation and reuse, wrong device, agent heartbeats with verifiable anchors, spoofed device id, browser next to agent, offline sync (403 for browsers, tampered anchor, applied, idempotent, overlap, future, stale), devices, revoke (socket dropped), admin revoke, consent withdrawal, RLS and no-DELETE grants.
- Playwright `19-desktop-agent.spec.ts` runs the **real Electron app**: consent screen (agree disabled until ticked), pairing with a code from the web page, tray present with state tooltip, agent heartbeats leading the session, offline buffering then sync flagged `OFFLINE_SYNCED`, and disconnecting from the web app stops the agent.

## 6. Not done / limitations

- Installers are **unsigned**: Windows SmartScreen and macOS Gatekeeper will warn. Signing needs a code-signing certificate and an Apple Developer account (secrets; a release step). macOS notarisation and auto-update are not set up.
- The agent does not open the web app or show meetings; it reports attendance only.
- On Linux without a keyring, Electron falls back to a fixed-key `basic_text` store; the agent says so on its status screen.
- Access tokens are refreshed every 12 minutes; an agent unused for more than 7 days (refresh lifetime) must be paired again.
