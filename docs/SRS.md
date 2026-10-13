**SOFTWARE REQUIREMENTS SPECIFICATION**

**HR Virtual Office Platform**

A virtual-office workspace with built-in HR: automatic attendance, timesheets, task management, meetings and a secure document vault

**Version 1.0 (Draft for approval)**

13 October 2026


| Item | Detail |
| --- | --- |
| Document type | Software Requirements Specification (IEEE 29148 structure) |
| Reference product | Spot Virtual (spotvirtual.com): concept reference only, original design and code |
| Technology | Next.js, NestJS, PostgreSQL, Redis, LiveKit, AWS S3/KMS (TypeScript end to end) |
| Development model | AI coding agent under product-owner direction with technical review |
| Status | Draft: pending product-owner approval of Section 16 decisions |
| Confidentiality | Confidential: internal and approved partners only |


**Revision history**


| Version | Date | Author | Description |
| --- | --- | --- | --- |
| 0.1 | 13 Oct 2026 | Product owner / AI assistant | Initial complete draft |
| 1.0 | 13 Oct 2026 | Product owner / AI assistant | Full SRS for approval |


**Table of Contents**


# 1. Introduction


## 1.1 Purpose

**This Software Requirements Specification (SRS) defines the complete functional, non-functional, architectural, data and security requirements for the ****HR Virtual Office Platform**** (working name: HRVO). The platform is a browser-based 'digital headquarters' in the style of Spot Virtual, in which employees and subcontractors appear on a shared 2D office map, talk and meet in real time, and at the same time are managed through built-in HR capabilities: automatic in/out time detection, timesheets, task management and a password-protected document vault.**

**The document is written so that it can be handed directly to an AI coding agent (for example Claude Code) module by module, and to a human reviewer for approval. Every requirement has a unique ID so it can be traced to code, tests and acceptance criteria.**


## 1.2 Product Vision

**One place where a distributed team 'goes to work'. A person opens the site, appears in the virtual office, and the system automatically knows when they started and stopped working, what they worked on, whom they met, and which contract documents belong to them, without manual punching or spreadsheets.**


## 1.3 Scope


### In scope

- **Multi-tenant web application (desktop and mobile browsers) with role-based access.**
- **Virtual office: 2D map, avatars, rooms, presence, proximity and room-based audio/video, screen sharing, chat.**
- **Meetings: instant, scheduled and room-based; recording (with consent); meeting attendance capture.**
- **Automatic attendance (in/out) detection with idle, break and meeting awareness; correction workflow.**
- **Timesheets and task time tracking per employee and per subcontractor, with approval workflow and pay calculation.**
- **Daily and weekly task management lists, Kanban board, planner and end-of-day reports.**
- **Document management with versioning, access control, encryption, password-protected confidential vault, access logging and expiry reminders.**
- **Notifications, reports, administration, audit logging and data-privacy tooling.**
- **Optional lightweight desktop agent (Phase 3) for OS-level idle detection and offline buffering.**

### Out of scope (initial release)

- **Payroll processing, tax filing and bank payments (the system produces approved hours and invoice-ready exports only).**
- **Recruitment / applicant tracking and performance-review modules.**
- **Biometric (face / fingerprint) attendance and continuous screen capture or keystroke logging. These are intentionally excluded for privacy and legal reasons.**
- **Native iOS/Android apps (a responsive Progressive Web App is provided instead).**

## 1.4 Reference Product Analysis


| Note on method: spotvirtual.com is a JavaScript single-page application and its internal screens are only visible after sign-in. The comparison below is based on the publicly known concept of virtual-office products (persistent office, rooms, presence, spatial communication). Exact feature parity should be validated by a hands-on walkthrough of a Spot trial account before Phase 2 starts. HRVO must use its own original name, branding, artwork and code; nothing may be copied from the original product. |
| --- |



| Virtual-office concept | HRVO implementation | HR extension (added value) |
| --- | --- | --- |
| Persistent shared office with rooms | 2D tile map (floors, open space, meeting rooms, lounge, reception) | Office presence automatically drives attendance |
| Avatars and live presence | Real-time avatar positions and status colours | Status = attendance state (active, idle, break, in meeting) |
| Walk up and talk | Proximity audio/video via WebRTC SFU | Call duration counted as active meeting time |
| Meeting rooms | Room-based and scheduled meetings, screen share, chat | Meeting minutes create tasks; attendance logged |
| Team status / who is around | Live board of who is in or out | Manager attendance dashboard, late and absent flags |
| Guest access | Guest links with restricted rights | Optional client or candidate visits |



## 1.5 Definitions, Acronyms and Abbreviations


| Term | Definition |
| --- | --- |
| Subcontractor | External contractor engaged under a contract; paid by hours or fixed fee; has restricted access. |
| Employee | Internal staff member. |
| Attendance session | A continuous period between automatic clock-in and clock-out. |
| Heartbeat | Small signed message sent by the client every 30 seconds proving the user is connected and whether they were active. |
| Idle | No keyboard, mouse, touch or call activity for the configured threshold. |
| SFU | Selective Forwarding Unit: media server that routes WebRTC audio/video between participants. |
| RBAC | Role-Based Access Control. |
| DEK / KEK | Data Encryption Key (encrypts a file) / Key Encryption Key (wraps the DEK). |
| KMS | Key Management Service (for example AWS KMS). |
| RLS | PostgreSQL Row-Level Security, used for tenant isolation. |
| PWA | Progressive Web App. |
| MoSCoW | Prioritisation: Must / Should / Could. |
| RPO / RTO | Recovery Point Objective / Recovery Time Objective. |



## 1.6 References

- **IEEE 29148:2018 Systems and software engineering: Requirements engineering (structure basis).**
- **OWASP Application Security Verification Standard (ASVS) 4.0 and OWASP Top 10.**
- **Sri Lanka Personal Data Protection Act No. 9 of 2022; EU GDPR (for any EU subcontractors or clients).**
- **WebRTC (W3C/IETF); LiveKit open-source SFU documentation.**
- **WCAG 2.1 Level AA accessibility guidelines.**

## 1.7 Document Conventions

- **Requirement IDs: ****FR-<MODULE>-<number>**** for functional, ****NFR-<area>-<number>**** for non-functional.**
- **Priority: ****Must**** = required for the phase to be accepted; ****Should**** = important, schedule permitting; ****Could**** = nice to have.**
- **Phase: ****P1**** Core HR MVP, ****P2**** Virtual office and meetings, ****P3**** Hardening, desktop agent and advanced features.**
- **'The system shall' denotes a binding requirement.**

# 2. Overall Description


## 2.1 Product Perspective

**HRVO is a new, self-contained SaaS-style platform. It integrates with external services only for email, calendar, single sign-on, object storage, key management and real-time media. It replaces the combination of a virtual-office tool, an attendance tracker, a timesheet tool, a task board and a shared drive that a distributed company would otherwise stitch together.**


## 2.2 Product Functions (Module Summary)


| Code | Module | Summary |
| --- | --- | --- |
| AUTH | Authentication and authorisation | Invite-only accounts, strong passwords, 2FA, SSO, RBAC, sessions |
| ORG | Organisation and people | Employees, subcontractors, contracts, teams, schedules, leave, onboarding |
| VO | Virtual office | 2D map, avatars, rooms, presence, proximity communication, map editor |
| MEET | Meetings and chat | Instant, room and scheduled meetings, recording, notes, channels, DMs |
| ATT | Attendance | Automatic in/out detection, idle/break, corrections, live board, anti-spoofing |
| TS | Timesheets | Daily/periodic timesheets, task timers, approvals, rates and payable amounts |
| TASK | Task management | Daily list, weekly planner, Kanban, comments, end-of-day reports |
| DOC | Document management | Versioned storage, password-protected vault, ACL, secure sharing, logs |
| NOTIF | Notifications | In-app, email, web push, chat-tool webhooks |
| REP | Reports and analytics | Attendance, hours, tasks, compliance dashboards and exports |
| ADM | Administration | Policies, branding, retention, feature flags, settings |
| AUD | Audit and privacy | Immutable audit log, data-subject export and deletion |



## 2.3 User Classes and Characteristics


| Role | Description | Key permissions |
| --- | --- | --- |
| Super Admin | Owner of the organisation account | Everything including policies, roles, retention, billing, audit log |
| HR Manager | Runs people operations | Manage users, contracts, schedules, corrections, all HR documents, reports |
| Team Lead / Project Manager | Leads a team or project | Assign tasks, approve timesheets and corrections for own team, view team attendance |
| Subcontractor | External contractor | Own attendance, tasks, timesheets, own documents only, meetings and chat |
| Employee | Internal staff | Same as subcontractor plus internal channels and company-wide documents |
| Finance / Auditor | Read-only finance or compliance user | View approved timesheets, export invoices, read audit log; no edit rights |
| Guest | Temporary visitor | Join a specific room or meeting through a link; no HR data |



## 2.4 Operating Environment

- **Browsers: latest two versions of Chrome, Edge, Firefox and Safari (WebRTC and WebSocket support required).**
- **Mobile: responsive PWA on iOS 16+ and Android 10+ (list view and chat/meeting; map viewing supported).**
- **Desktop agent (Phase 3): Windows 10+, macOS 12+, Ubuntu 22.04+.**
- **Server: Linux containers on a major cloud (AWS recommended; Singapore ap-southeast-1 or Mumbai ap-south-1 for Sri Lanka latency).**

## 2.5 Design and Implementation Constraints

- **Source code is generated and maintained primarily by an AI coding agent; therefore the stack must be mainstream, strongly typed and well documented (TypeScript end to end).**
- **All timestamps are stored in UTC; the organisation timezone (default Asia/Colombo, UTC+05:30) is applied only for display and for day-boundary logic.**
- **Employee monitoring must be transparent, proportionate and consented. No screenshots, keystroke content or webcam capture are collected.**
- **Confidential documents must be encrypted so that a database or storage-bucket leak alone does not expose their content.**
- **Real-time media must use an SFU rather than peer-to-peer mesh to support more than four participants per room.**

## 2.6 Assumptions and Dependencies

- **Users have a stable internet connection of at least 2 Mbps for audio and 4 Mbps for video.**
- **Users accept an attendance and privacy notice at onboarding (legal prerequisite).**
- **Third-party services remain available: LiveKit (or self-hosted equivalent), AWS S3/KMS, an email provider (SES/Resend), Google/Microsoft OIDC.**
- **The client will supply branding, policy documents and holiday calendar before UAT.**

## 2.7 HR Requirement Compliance Matrix

**The seven mandatory HR platform requirements stated by the client are traced below to the modules and requirement IDs that satisfy them. This table is the primary acceptance checklist.**


| # | Client HR requirement | Delivered by | Requirement IDs |
| --- | --- | --- | --- |
| 1 | Auto detection of In/Out times | Attendance engine (heartbeat, idle and disconnect logic), virtual-office presence, desktop agent | FR-ATT-001 to 012, 015, 017; Section 6 |
| 2 | Documentation handling and storage | Document management module with folders, versions, ACL, expiry reminders, search | FR-DOC-001 to 004, 009, 012 to 020 |
| 3 | Timesheet and task management for each subcontractor | Timesheet and task modules with per-subcontractor rates, projects and approvals | FR-TS-001 to 013, FR-TASK-001 to 016, FR-ORG-002 to 005 |
| 4 | Ability to have meetings and connect | Virtual office, proximity A/V, meetings, chat | FR-VO-001 to 014, FR-MEET-001 to 014 |
| 5 | Daily and weekly task management lists | Daily plan / Today list, weekly planner, end-of-day report | FR-TASK-003, 004, 005, 016 |
| 6 | Password-protected documentation for contracts etc. | Confidential vault: re-authentication, per-document password, envelope encryption, share links | FR-DOC-005 to 008, 010, 011 |
| 7 | Accurate detection of in and out times | Server-authoritative timestamps, 30-second heartbeat, 120-second grace, accuracy targets and tests | FR-ATT-003, 004, 017; NFR-ACC-001 to 004; Section 6 |



# 3. System Architecture


## 3.1 Architectural Style

**HRVO uses a ****modular monolith**** for business logic (one NestJS codebase divided into strictly separated modules), plus two specialised real-time services: a WebSocket presence gateway and a LiveKit media server (SFU). This gives the delivery speed and simplicity needed when an AI agent writes the code, while keeping clear module boundaries so that any module can later be extracted into a separate service.**


## 3.2 Logical Layers


| Layer | Components | Responsibility |
| --- | --- | --- |
| Client | Next.js web app, PixiJS office canvas, LiveKit client SDK, PWA service worker, Electron/Tauri desktop agent (P3) | UI, map rendering, media capture, activity sensing, heartbeat sender |
| Edge | Cloudflare CDN/WAF, AWS ALB, TLS termination | Caching, DDoS and bot protection, HTTPS, routing |
| Application | NestJS REST API (modules AUTH, ORG, ATT, TS, TASK, DOC, MEET, NOTIF, REP, ADM, AUD) | Business rules, validation, authorisation, orchestration |
| Real-time | NestJS WebSocket gateway (Socket.IO + Redis adapter), LiveKit SFU | Presence, avatar movement, chat, signalling, audio/video routing |
| Jobs | BullMQ workers on Redis | Attendance reconciliation, reminders, emails, report generation, virus scan, video post-processing |
| Data | PostgreSQL 16 (+TimescaleDB), Redis 7, S3-compatible object storage, AWS KMS | System of record, ephemeral presence state, encrypted files, key custody |
| Observability | Sentry, Prometheus, Grafana, Loki, OpenTelemetry | Errors, metrics, logs, traces, alerts |



## 3.3 Key Data Flows


### A. Automatic clock-in and clock-out

- **User signs in; web client opens a WebSocket authenticated with the access token.**
- **Client sends a signed heartbeat every 30 s containing activity counters (never content).**
- **Presence gateway writes the heartbeat to Redis and publishes the state to the office.**
- **On the first ACTIVE heartbeat of the day (or a new session after a long gap) the Attendance service inserts an attendance session with server time as clock-in.**
- **On logout, socket disconnect beyond the grace window, or heartbeat timeout, the session is closed at the last valid heartbeat time.**
- **A reconciliation job every minute repairs orphaned sessions and splits sessions at midnight.**

### B. Confidential document upload and download

- **Client requests an upload ticket; API validates permission and returns a pre-signed URL.**
- **File is encrypted server-side with a random DEK (AES-256-GCM); the DEK is wrapped by the KMS KEK and, if a document password is set, additionally by a key derived with Argon2id from that password.**
- **ClamAV scans the file; only clean files become available.**
- **On download the user re-authenticates (password or TOTP, valid for 10 minutes) and, if required, enters the document password; the API unwraps the DEK in memory, streams the decrypted file and writes an access-log entry.**

### C. Joining a meeting by walking into a room

- **Avatar moves into room bounds; client sends office:move events (throttled to 10 per second).**
- **Server validates the move, updates Redis and broadcasts positions to the floor.**
- **On entering a room the API issues a short-lived LiveKit token scoped to that room; the client connects to the SFU and publishes audio/video.**
- **Join and leave times are stored in meeting_participants and credited to the user's meeting time in attendance.**

## 3.4 Multi-Tenancy and Data Isolation

- **Shared database, shared schema; every business table has an org_id column.**
- **PostgreSQL Row-Level Security policies enforce org_id = current_setting('app.org_id') so a coding mistake cannot leak data between organisations.**
- **Object storage keys are prefixed by org_id; KMS encryption context includes org_id.**
- **Redis keys are namespaced org:{orgId}:*.**

# 4. Technology Stack

**The stack is chosen for three reasons: (1) one language (TypeScript) across web, API and desktop agent, which AI agents handle best; (2) proven open-source components with large communities; (3) low cost at the start with a clear path to scale.**


## 4.1 Recommended Stack


| Area | Technology | Why |
| --- | --- | --- |
| Frontend framework | Next.js 14+ (React 18, TypeScript, App Router) | Fast to build, SSR for login/marketing pages, huge ecosystem |
| UI components | Tailwind CSS + shadcn/ui + Radix | Accessible, consistent, AI-friendly |
| State and data fetching | Zustand + TanStack Query + Zod | Simple client state, cached server state, runtime validation |
| Virtual office canvas | PixiJS 8 (WebGL 2D) with Tiled map JSON | High-performance 2D rendering; map editor outputs standard JSON |
| Real-time messaging | Socket.IO 4 with Redis adapter | Reliable WebSocket with fallback, rooms, horizontal scaling |
| Audio / video / screen share | LiveKit (open-source SFU; LiveKit Cloud first, self-host later) | Production-grade WebRTC, simulcast, recording (Egress), SDKs for web |
| Backend framework | NestJS 10 (Node.js 20 LTS, TypeScript) | Modular structure that matches this SRS; DI, guards, validation |
| ORM and migrations | Prisma (with raw SQL for RLS and partitions) | Typed schema, safe migrations, readable by AI agents |
| Primary database | PostgreSQL 16 + TimescaleDB extension | Relational integrity, JSONB, RLS, time-series partitioning for presence events |
| Cache / presence / queues | Redis 7 + BullMQ | Ephemeral presence, rate limits, pub/sub, background jobs |
| File storage | AWS S3 (or Cloudflare R2 / MinIO) + AWS KMS | Durable encrypted storage with key custody |
| Search | PostgreSQL full-text search (OpenSearch later if needed) | No extra infrastructure at MVP |
| Authentication | Argon2id, JWT (access) + rotating refresh tokens, otplib (TOTP), OIDC for Google and Microsoft | Modern, standards-based |
| Email / push | AWS SES or Resend; Web Push (VAPID) | Transactional email and browser notifications |
| Virus scanning | ClamAV container | Scan every upload |
| PDF / export | Puppeteer or pdf-lib; ExcelJS | Timesheet, invoice and report exports |
| Desktop agent (P3) | Tauri (Rust shell) or Electron | OS idle time API, offline queue, tray status |
| Testing | Vitest/Jest, Playwright, k6, OWASP ZAP | Unit, end-to-end, load and security tests |
| DevOps | Docker, GitHub Actions, Terraform, AWS ECS Fargate (or a single EC2 with Docker Compose for MVP) | Repeatable deployments, low initial cost |
| Monitoring | Sentry, Grafana, Prometheus, Loki, UptimeRobot | Errors, performance, uptime alerts |
| Edge | Cloudflare (DNS, CDN, WAF) | Security and performance |



## 4.2 Alternatives Considered


| Decision | Chosen | Alternative | Reason for choice |
| --- | --- | --- | --- |
| Backend | NestJS | Django, Laravel, Go | TypeScript sharing with frontend and agent; modular fit |
| Media | LiveKit | Jitsi, Agora, Twilio, mediasoup | Open source, no per-minute lock-in when self-hosted, excellent SDKs |
| Realtime state | Socket.IO + Redis | Colyseus, PartyKit | Mature, simpler to operate with the existing Redis |
| Database | PostgreSQL | MongoDB, MySQL | Strong relational model for HR/finance data and RLS tenant isolation |
| Map renderer | PixiJS | Phaser, Konva | Lightweight, rendering-focused, easy for custom map layers |
| Mobile | PWA | React Native / Flutter | Fastest delivery; native apps can follow after validation |



## 4.3 Repository Structure (Monorepo)

- **apps/web****: Next.js frontend including the office canvas.**
- **apps/api****: NestJS application (REST + WebSocket gateway + workers).**
- **apps/agent****: desktop agent (Phase 3).**
- **packages/shared****: shared TypeScript types, Zod schemas, constants (attendance states, permissions).**
- **packages/ui****: shared UI components.**
- **infra/****: Terraform, Docker Compose, CI/CD workflows.**
- **docs/****: this SRS (split into markdown files per module), ADRs, API reference, runbooks.**

# 5. Functional Requirements

**Requirements are grouped by module. Each module lists its purpose and a numbered requirement table. Priority and delivery phase are shown for planning.**


## 5.1 Authentication and Authorisation (AUTH)

**Purpose: secure, invitation-based access with strong identity controls and fine-grained permissions.**


| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-AUTH-001 | Accounts shall be created by invitation only. An HR Manager or Admin sends an email invite whose single-use token expires after 7 days. | Must | P1 |
| FR-AUTH-002 | Passwords shall be hashed with Argon2id; minimum 12 characters; the system shall reject passwords found in known breach lists (k-anonymity check). | Must | P1 |
| FR-AUTH-003 | Authentication shall use short-lived JWT access tokens (15 min) and rotating refresh tokens (7 days) in httpOnly, Secure, SameSite cookies, with refresh-token reuse detection that revokes the whole token family. | Must | P1 |
| FR-AUTH-004 | The system shall support TOTP two-factor authentication (authenticator apps) with recovery codes; 2FA shall be mandatory for Super Admin and HR Manager roles. | Must | P1 |
| FR-AUTH-005 | The system shall support single sign-on with Google and Microsoft (OIDC), configurable per organisation. | Should | P2 |
| FR-AUTH-006 | Authorisation shall be role-based (RBAC) with permissions such as attendance.read.team, document.confidential.view, timesheet.approve. System roles are fixed; custom roles may be created by Super Admin. | Must | P1 |
| FR-AUTH-007 | After 5 failed logins the account shall be locked for 15 minutes and a CAPTCHA required; the user is notified by email. | Must | P1 |
| FR-AUTH-008 | Password reset shall use a single-use email link valid for 30 minutes and shall revoke all active sessions. | Must | P1 |
| FR-AUTH-009 | Users shall see their active sessions and devices and be able to revoke any of them; admins can revoke sessions for a user. | Should | P2 |
| FR-AUTH-010 | Tenant isolation shall be enforced at the database layer with Row-Level Security in addition to application checks. | Must | P1 |
| FR-AUTH-011 | All login, logout, failure, 2FA and role-change events shall be written to the audit log. | Must | P1 |
| FR-AUTH-012 | Idle session timeout (default 8 hours of inactivity) shall be configurable per organisation. | Should | P2 |



## 5.2 Organisation and People Management (ORG)

**Purpose: maintain accurate records of employees, subcontractors, contracts, teams and schedules.**


| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-ORG-001 | The system shall store organisation profile: name, logo, timezone (default Asia/Colombo), working week, default currency and branding colours. | Must | P1 |
| FR-ORG-002 | The system shall maintain a subcontractor profile: legal name, company, country, contact details, tax ID (encrypted), bank details (encrypted), rate type (hourly, daily, fixed), rate, currency, overtime multiplier and emergency contact. | Must | P1 |
| FR-ORG-003 | The system shall record contracts per subcontractor: title, scope, start and end date, rate, status, linked contract document, and renewal notice period. Alerts shall be sent 30, 14 and 7 days before expiry to HR and the manager. | Must | P1 |
| FR-ORG-004 | Subcontractors shall be assigned to projects, optionally with a project-specific rate override and a weekly hours cap with warnings at 80% and 100%. | Must | P1 |
| FR-ORG-005 | Each user shall have a work schedule: fixed or flexible hours, working days, expected daily hours, break allowance and grace minutes for late arrival and early leave. | Must | P1 |
| FR-ORG-006 | The system shall support teams/departments and a manager hierarchy used for approvals and visibility scopes. | Must | P1 |
| FR-ORG-007 | HR shall be able to bulk-import users, teams and projects from CSV with validation report. | Should | P2 |
| FR-ORG-008 | Onboarding checklist per new user: upload ID and signed contract, accept privacy and attendance notice, accept NDA/policies, set up 2FA, complete profile. Progress is visible to HR. | Must | P1 |
| FR-ORG-009 | Offboarding shall deactivate the account, revoke sessions and tokens, reassign open tasks, lock timesheets for final approval and apply data-retention rules. | Must | P1 |
| FR-ORG-010 | Employees shall be able to request leave (annual, sick, unpaid, other); managers approve or reject; approved leave updates attendance expectations. | Should | P2 |
| FR-ORG-011 | The system shall hold a public holiday calendar (default Sri Lanka) editable by HR; holidays are excluded from expected working time. | Should | P2 |
| FR-ORG-012 | A searchable company directory with profile cards (role, team, timezone, local time, current status) shall be provided. | Should | P2 |



## 5.3 Virtual Office (VO)

**Purpose: provide the persistent shared 2D workspace where people see each other, move between rooms and start conversations naturally.**


| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-VO-001 | The system shall render a 2D office with one or more floors containing open areas, desks, meeting rooms, private rooms, a lounge and a reception, loaded from a map definition (Tiled JSON format). | Must | P2 |
| FR-VO-002 | Each user shall have an avatar (name, photo or character, status ring) that moves by click-to-move or keyboard (WASD/arrow keys). Position updates shall reach other users within 200 ms at the 95th percentile within the same region. | Must | P2 |
| FR-VO-003 | Presence status shall be shown on every avatar and the people list: Active, Idle, In meeting, On break, Away, Do not disturb, Offline. The attendance engine is the source of truth for Active, Idle, Break and Offline. Users may add a status message. | Must | P2 |
| FR-VO-004 | Rooms shall have type (open, meeting, private, broadcast), capacity, and access mode: open, knock-to-enter, invite-only or password-protected. | Must | P2 |
| FR-VO-005 | Proximity communication: users within a configurable radius automatically hear and see each other, with volume falling off with distance; users may disable proximity and use room-only mode. | Must | P2 |
| FR-VO-006 | Admins shall have a map editor to create and edit floors, walls, rooms and desks from templates, with drag-and-drop placement and live preview. | Should | P2 |
| FR-VO-007 | Each user may be assigned a personal desk; a 'go to my desk' shortcut and teleport to a colleague or room shall be available. | Should | P2 |
| FR-VO-008 | Users shall be able to search for a colleague, see where they are and 'knock' or call them with a ring-and-accept flow. | Must | P2 |
| FR-VO-009 | Screen sharing and presentation mode shall be available inside any room. | Must | P2 |
| FR-VO-010 | Admins and managers shall be able to broadcast an announcement that appears to all online users. | Should | P2 |
| FR-VO-011 | Guests shall enter through a time-limited link into designated rooms only, with no access to HR data or other areas. | Should | P3 |
| FR-VO-012 | A list-view alternative (no map) shall be available for low-bandwidth devices and for accessibility (screen readers, keyboard navigation). | Must | P2 |
| FR-VO-013 | Capacity: one office supports at least 200 concurrent avatars in P2 and 1,000 in P3 using spatial interest management (users only receive updates from their neighbourhood). | Must | P2 |
| FR-VO-014 | Emoji reactions and simple emotes above avatars. | Could | P3 |



## 5.4 Meetings and Communication (MEET)

**Purpose: enable instant, scheduled and spontaneous conversations, with a durable record for HR purposes.**


| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-MEET-001 | Users shall start an instant 1:1 or group call from an avatar, the people list or a chat. | Must | P2 |
| FR-MEET-002 | Room-based meetings: walking into a room joins its audio/video session automatically; leaving the room leaves the session. | Must | P2 |
| FR-MEET-003 | Scheduled meetings with title, agenda, participants, time, recurrence, join link and .ics calendar invite sent by email. | Must | P2 |
| FR-MEET-004 | Audio, video and screen sharing with simulcast and adaptive bitrate; up to 50 active participants per meeting. | Must | P2 |
| FR-MEET-005 | In-meeting controls: mute/unmute, camera, share, chat, raise hand, host mute-all, remove participant, lobby/admit. | Must | P2 |
| FR-MEET-006 | Two-way calendar sync with Google Calendar and Microsoft Outlook. | Should | P3 |
| FR-MEET-007 | Meeting recording to encrypted storage with a visible recording banner and recorded-consent log; recordings follow retention policy and ACL. | Should | P3 |
| FR-MEET-008 | Meeting notes and action items; action items can be converted into tasks assigned to attendees in one click. | Should | P2 |
| FR-MEET-009 | Join and leave times for every participant shall be stored and credited to attendance as meeting time. | Must | P2 |
| FR-MEET-010 | Quality features: noise suppression, echo cancellation, optional blurred background, network-quality indicator and automatic audio-only fallback. | Should | P2 |
| FR-MEET-011 | Pre-join device check (camera, microphone, speaker test) and device selection. | Must | P2 |
| FR-MEET-012 | Text chat: direct messages, group chats and channels with threads, mentions, emoji and message search. | Must | P2 |
| FR-MEET-013 | File sharing inside chat with virus scanning; shared files are stored through the document module. | Should | P2 |
| FR-MEET-014 | AI meeting summary and transcript (opt-in per organisation, consent required). | Could | P3 |



## 5.5 Attendance and Automatic In/Out Detection (ATT)

**Purpose: record when each person starts and stops working automatically, accurately and fairly, without manual punching. The detailed algorithm is specified in Section 6.**


| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-ATT-001 | Auto clock-in: the system shall create an attendance session automatically when the user's first valid ACTIVE heartbeat arrives after login or office entry, with no button press required. | Must | P1 |
| FR-ATT-002 | Auto clock-out: the system shall close the session automatically on explicit logout, on socket disconnect that is not recovered within the 120-second grace window, or when heartbeats stop for more than 90 seconds. | Must | P1 |
| FR-ATT-003 | Accuracy: all times shall be taken from the server clock (NTP-synchronised, UTC). Clock-in shall be stamped within 5 seconds of the first valid activity; clock-out shall equal the timestamp of the last valid heartbeat, so error is no more than 30 seconds. Client clocks are ignored. | Must | P1 |
| FR-ATT-004 | Heartbeat: the client shall send a signed heartbeat every 30 seconds containing counters only: seconds active and idle in the interval, tab visibility, window focus, and in-call flag. No keystroke content, URLs, screenshots or application names are transmitted by the web client. | Must | P1 |
| FR-ATT-005 | Idle detection: no keyboard, mouse or touch input for the idle threshold (default 5 minutes) sets state IDLE; idle for more than the pause threshold (default 15 minutes) pauses the session's active time. Idle time is stored separately and excluded from payable time unless a manager approves it. | Must | P1 |
| FR-ATT-006 | Being in an audio/video call or meeting counts as ACTIVE even without keyboard or mouse input. | Must | P2 |
| FR-ATT-007 | Breaks: users may start and end breaks manually; breaks may also be auto-suggested after a configurable idle period. Break time is recorded and deducted according to policy (paid or unpaid). | Must | P1 |
| FR-ATT-008 | Midnight split: sessions that cross midnight in the organisation timezone shall be split into two records so every work day totals correctly. | Must | P1 |
| FR-ATT-009 | Maximum session length: a session open longer than 14 hours (configurable) shall be closed automatically at the last valid heartbeat and flagged for review. | Must | P1 |
| FR-ATT-010 | Multiple devices: if the same user is active on two devices, the sessions are merged into one record, time is not double-counted, and the event is flagged. | Should | P2 |
| FR-ATT-011 | Desktop agent: an optional installable agent reads OS-level idle time, shows a tray status and detects activity outside the browser. Installation requires explicit consent and a visible tray icon at all times. | Should | P3 |
| FR-ATT-012 | Offline buffering: when connectivity drops, the desktop agent or PWA queues time-stamped events and syncs them on reconnect; synced records are flagged 'offline-synced' and validated against server heartbeat gaps. | Should | P3 |
| FR-ATT-013 | Correction workflow: a user may request a correction (missed or wrong in/out) with reason and optional evidence; the manager approves or rejects; the original record is always preserved and the change is audit-logged. | Must | P1 |
| FR-ATT-014 | Schedule compliance: the system shall calculate late arrival, early leave, absence and overtime against the assigned schedule and grace minutes, and flag exceptions. | Must | P1 |
| FR-ATT-015 | Daily attendance record per user: first in, last out, active time, idle time, break time, meeting time, net work time, and exception flags. | Must | P1 |
| FR-ATT-016 | Live attendance board: managers see in real time who is in, idle, on break, in meeting, on leave or not yet in, filterable by team. | Must | P1 |
| FR-ATT-017 | Anti-spoofing: signed heartbeats with nonce and sequence number, rate limiting, concurrent-session detection, impossible-travel IP detection and mechanical-input pattern heuristics. Suspicious sessions are flagged for human review and are never penalised automatically. | Should | P2 |
| FR-ATT-018 | Network policy: optional allow-lists of IP ranges or countries per organisation; IP and coarse location are logged with each session and violations are flagged. | Should | P2 |
| FR-ATT-019 | Exports: attendance data shall be exportable to CSV, XLSX and PDF for any period, team or user. | Must | P1 |
| FR-ATT-020 | Transparency: each user can view their own raw attendance events and a plain-language description of exactly what is collected; acceptance of the monitoring notice is recorded. | Must | P1 |
| FR-ATT-021 | Notifications: reminder if no clock-in by schedule start plus grace; notice when auto clock-out occurs; alert to manager on long idle or repeated flags (configurable). | Should | P2 |
| FR-ATT-022 | Leave integration: approved leave and public holidays mark the day accordingly and suppress absence alerts. | Should | P2 |
| FR-ATT-023 | Presence challenge: after a long idle period the system may ask 'Are you still working?' with a 60-second response window before pausing the session. | Could | P3 |



## 5.6 Timesheets and Time Tracking (TS)

**Purpose: produce accurate, approved, payable hours per person, project and task, reconciled with attendance.**


| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-TS-001 | A draft timesheet shall be generated automatically each day from attendance and task time entries for every employee and subcontractor. | Must | P1 |
| FR-TS-002 | Each subcontractor shall have a periodic timesheet (weekly, bi-weekly or monthly as configured) with entries by project, task and day, plus notes. | Must | P1 |
| FR-TS-003 | Task timers: users start and stop a timer on a task; only one timer can run at a time; the running timer stops automatically at clock-out. | Must | P1 |
| FR-TS-004 | Manual time entries are allowed with a mandatory reason, are visibly marked as manual and may be limited by policy (for example maximum 2 hours per day). | Must | P1 |
| FR-TS-005 | Reconciliation: the system shall compare net attendance time against logged task time per day and alert when variance exceeds a configurable threshold (default 15%). | Must | P1 |
| FR-TS-006 | Submission and approval: users submit; the manager approves or rejects with comments; rejected timesheets return to the user; approved timesheets are locked. | Must | P1 |
| FR-TS-007 | Optional multi-level approval chains (manager then project owner then finance). | Should | P2 |
| FR-TS-008 | Entries may be marked billable or non-billable per project or task. | Should | P2 |
| FR-TS-009 | Payable amount shall be calculated from approved hours, rate type, rate, project override and overtime multiplier, in the contract currency. | Must | P1 |
| FR-TS-010 | Invoice-ready export (PDF, XLSX, CSV) per subcontractor per period; subcontractors may generate an invoice PDF from approved hours. | Should | P2 |
| FR-TS-011 | After approval only a user with timesheet.reopen permission can reopen a timesheet; reopening is audit-logged with reason. | Must | P1 |
| FR-TS-012 | Reminders to submit before the deadline and to approvers for pending approvals. | Must | P1 |
| FR-TS-013 | Timesheet reports by subcontractor, project, team and period including cost, hours, variance and approval turnaround. | Must | P1 |



## 5.7 Task Management (TASK)

**Purpose: let managers assign work to subcontractors and employees and let each person plan their day and week.**


| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-TASK-001 | Create and edit tasks with title, rich-text description, project, assignee, reporter, priority, due date, planned date, estimate, labels, checklist/subtasks and attachments. | Must | P1 |
| FR-TASK-002 | Configurable status workflow with defaults To Do, In Progress, In Review, Blocked, Done; status changes are logged. | Must | P1 |
| FR-TASK-003 | Daily task list: a 'Today' view auto-populated with tasks due or planned today and carry-overs. At start of day the user confirms a daily plan; at end of day the user submits a short report (done, blocked, tomorrow). | Must | P1 |
| FR-TASK-004 | Weekly task list / planner: week view with drag-and-drop between days, weekly goals, capacity indicator versus scheduled hours, and automatic carry-over of unfinished tasks. | Must | P1 |
| FR-TASK-005 | Views: My Tasks list, Kanban board, calendar and team workload view with filters and saved views. | Must | P1 |
| FR-TASK-006 | Comments with @mentions, file attachments and a complete activity history per task. | Must | P1 |
| FR-TASK-007 | Managers assign tasks to subcontractors; the assignee accepts or declines with a reason; unaccepted tasks are escalated after a configurable time. | Must | P1 |
| FR-TASK-008 | Estimate versus actual: actual time is taken from timers and time entries; overruns are highlighted. | Must | P1 |
| FR-TASK-009 | Recurring tasks (daily, weekly, monthly, custom). | Should | P2 |
| FR-TASK-010 | Reports: completion rate, on-time rate, overdue tasks, workload per person, cycle time. | Must | P2 |
| FR-TASK-011 | Notifications for assignment, mention, due soon (24 h and 1 h) and overdue. | Must | P1 |
| FR-TASK-012 | Auto-generated daily stand-up summary per team posted to a chat channel. | Should | P2 |
| FR-TASK-013 | Create a task directly from a chat message or from meeting action items. | Should | P2 |
| FR-TASK-014 | Task dependencies (blocked by / blocks) with warnings. | Could | P3 |
| FR-TASK-015 | CSV import and export of tasks. | Could | P3 |
| FR-TASK-016 | Weekly summary email to each manager and subcontractor (completed, pending, hours). | Should | P2 |



## 5.8 Document Management and Secure Storage (DOC)

**Purpose: central, searchable, versioned and secure storage for contracts, identity documents, invoices and policies, with a password-protected vault for confidential files.**


| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-DOC-001 | Upload by drag-and-drop or picker, up to 100 MB per file, with resumable multi-part upload. Allowed types are configurable (PDF, DOCX, XLSX, PPTX, images, ZIP, TXT). | Must | P1 |
| FR-DOC-002 | Folder tree and fixed categories: Contracts, NDAs, Identity, Tax forms, Invoices, Policies, Certificates, Other. | Must | P1 |
| FR-DOC-003 | Metadata per document: title, category, owner, linked user, linked contract/project, tags, expiry date and confidentiality level (Normal, Confidential, Restricted). | Must | P1 |
| FR-DOC-004 | Version history with restore; every upload of an existing document creates a new version, and previous versions remain until policy deletion. | Must | P1 |
| FR-DOC-005 | Confidential vault: Confidential and Restricted documents require recent re-authentication (password or TOTP within the last 10 minutes) before view or download. | Must | P1 |
| FR-DOC-006 | Per-document password: an owner or HR may set an additional password on a document. The password is never stored; it derives (Argon2id) a key that wraps the document's data key. A lost password can be recovered only by users holding the 'vault.recover' permission through the KMS-held key, and such recovery is logged. | Must | P1 |
| FR-DOC-007 | Encryption at rest: each file is encrypted with its own AES-256-GCM data key; data keys are wrapped by a KMS-managed key with org_id in the encryption context. File names of confidential documents are also stored encrypted. | Must | P1 |
| FR-DOC-008 | Encryption in transit: TLS 1.2 or higher for all connections (1.3 preferred), HSTS enabled, internal service traffic encrypted. | Must | P1 |
| FR-DOC-009 | Access control: permissions (View, Download, Edit, Manage) assignable to users, roles or teams at folder or document level, with optional expiry. Default: subcontractors can only see documents linked to themselves. | Must | P1 |
| FR-DOC-010 | Secure share links: time-limited links with optional password, download limit and revocation, for sharing with external parties. | Should | P2 |
| FR-DOC-011 | View-only mode: PDFs and images can be shared view-only with a dynamic watermark (viewer name, date, IP) and downloads disabled. | Should | P2 |
| FR-DOC-012 | Access logging: every view, download, upload, share, permission change, failed password attempt and deletion is logged with user, time, IP and user agent. Logs are immutable and exportable. | Must | P1 |
| FR-DOC-013 | Virus scanning: every upload is scanned by ClamAV before it becomes available; infected files are quarantined and the uploader notified. | Must | P1 |
| FR-DOC-014 | E-signature: users can request and apply a signature (draw or type) on a PDF contract with a tamper-evident audit certificate (timestamp, IP, document hash). Third-party integration such as DocuSign is optional. | Should | P3 |
| FR-DOC-015 | Expiry reminders for contracts, visas, certificates and policies at 60, 30 and 7 days to the owner and HR. | Must | P1 |
| FR-DOC-016 | Search by title, tags, category, owner and (for non-confidential files) extracted text. | Should | P2 |
| FR-DOC-017 | Retention and deletion: retention rules per category, legal hold, and secure deletion by destroying the data key (crypto-shredding) so that all copies and backups become unreadable. | Should | P2 |
| FR-DOC-018 | Policy acknowledgement: publish a policy document and track who has read and acknowledged it, with reminders. | Should | P2 |
| FR-DOC-019 | In-browser preview for PDFs and images; Office files converted to PDF for preview through a sandboxed converter. | Should | P2 |
| FR-DOC-020 | Bulk download as ZIP for authorised roles, audit-logged and limited by rate. | Could | P3 |



## 5.9 Notifications (NOTIF)


| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-NOTIF-001 | In-app notification centre with unread count and mark-as-read. | Must | P1 |
| FR-NOTIF-002 | Email notifications using templates with unsubscribe for non-critical types. | Must | P1 |
| FR-NOTIF-003 | Browser web-push notifications (opt-in). | Should | P2 |
| FR-NOTIF-004 | Per-user preferences by event type and channel; quiet hours respecting the user's timezone. | Should | P2 |
| FR-NOTIF-005 | Optional Slack or Microsoft Teams webhook for team-level alerts. | Could | P3 |
| FR-NOTIF-006 | Daily or weekly digest option. | Could | P3 |



## 5.10 Reports and Analytics (REP)


| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-REP-001 | Manager dashboard: today's attendance, late arrivals, pending approvals, overdue tasks, expiring documents and contracts. | Must | P1 |
| FR-REP-002 | Attendance reports: daily, weekly, monthly; per user, team and organisation; late/early/absent/overtime summaries. | Must | P1 |
| FR-REP-003 | Hours and cost reports per subcontractor, project and period. | Must | P1 |
| FR-REP-004 | Task and productivity reports with workload balance. | Should | P2 |
| FR-REP-005 | Compliance report: documents missing, expired, unsigned policies, onboarding incomplete. | Must | P2 |
| FR-REP-006 | All reports exportable to CSV, XLSX and PDF. | Must | P1 |
| FR-REP-007 | Scheduled reports emailed to chosen recipients (weekly, monthly). | Should | P2 |
| FR-REP-008 | Visibility of every report restricted by role and team scope. | Must | P1 |



## 5.11 Administration and Settings (ADM)


| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-ADM-001 | Policy configuration: idle and pause thresholds, grace minutes, maximum session length, allowed manual time per day, variance threshold, break rules. | Must | P1 |
| FR-ADM-002 | Role and permission management including custom roles. | Must | P1 |
| FR-ADM-003 | Branding: logo, colours, custom domain (optional). | Should | P3 |
| FR-ADM-004 | Data retention settings per data type (attendance events, recordings, documents, chat). | Should | P2 |
| FR-ADM-005 | Feature flags per organisation for gradual rollout. | Should | P2 |
| FR-ADM-006 | Audit log viewer with filters and export. | Must | P1 |
| FR-ADM-007 | Office and room management; map editor access. | Should | P2 |
| FR-ADM-008 | API keys and outgoing webhooks for integrations (read-only attendance and timesheet data). | Could | P3 |



## 5.12 Audit and Privacy (AUD)


| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-AUD-001 | An append-only audit log shall record who did what, when, from where, with before and after values for sensitive entities. Rows carry a hash chain so tampering is detectable. | Must | P1 |
| FR-AUD-002 | Data-subject export: a user's personal data can be exported as JSON/ZIP on request by HR. | Should | P2 |
| FR-AUD-003 | Data-subject deletion or anonymisation subject to legal retention rules, with a documented workflow. | Should | P2 |
| FR-AUD-004 | Consent records for monitoring notice, recording and AI features with version and timestamp. | Must | P1 |
| FR-AUD-005 | Privacy dashboard for each user showing what data is collected, retention periods and who accessed their documents. | Should | P3 |



# 6. Attendance Detection Design

**This section specifies how automatic and accurate in/out detection works. It is the most important HR capability and must be built and tested first.**


## 6.1 Signal Sources


| Signal | Source | Reliability | Use |
| --- | --- | --- | --- |
| Login / office entry | API + WebSocket connect | High | Starts presence tracking; first ACTIVE heartbeat triggers clock-in |
| Heartbeat (30 s) | Web client / desktop agent | High | Proves connection; carries active/idle counters |
| Input activity counters | Browser events (mouse, key, touch, scroll) counted only | Medium (browser only sees its own tab) | Active vs idle classification |
| OS idle time | Desktop agent (P3) | High | Catches work done in other apps |
| In-call flag | LiveKit connection state | High | Counts calls as active |
| Socket disconnect | Gateway | High | Starts grace timer for clock-out |
| Explicit logout / manual break | User action | High | Immediate state change |
| IP address, device ID | Request metadata | Medium | Anti-spoof and policy checks |



## 6.2 Attendance State Machine


| Current state | Event | Next state | System action |
| --- | --- | --- | --- |
| OFFLINE | First ACTIVE heartbeat (no open session) | ACTIVE | Create session; clock_in_at = server time; source AUTO_HEARTBEAT |
| ACTIVE | No input for 5 min (idle threshold) | IDLE | Open idle segment; notify user subtly |
| IDLE | Input resumes | ACTIVE | Close idle segment; add to idle_seconds |
| IDLE | Idle exceeds 15 min (pause threshold) | PAUSED | Pause active-time accrual; optional presence challenge |
| PAUSED | Input resumes | ACTIVE | Resume accrual; flag segment as 'long idle' |
| ACTIVE / IDLE | Join call or meeting | IN_MEETING | Count as active; link meeting_id |
| IN_MEETING | Leave call | ACTIVE | Credit meeting_seconds |
| ACTIVE | User starts break | ON_BREAK | Open break segment |
| ON_BREAK | User ends break or input after max break | ACTIVE | Close break; apply paid/unpaid policy |
| Any open state | Socket disconnect | DISCONNECTED (grace) | Start 120 s grace timer; keep session open |
| DISCONNECTED | Reconnect within 120 s | Previous state | Cancel timer; log gap |
| DISCONNECTED | Grace expires | OFFLINE | Close session; clock_out_at = last valid heartbeat; source DISCONNECT |
| Any open state | Heartbeats missing for more than 90 s (no disconnect event) | OFFLINE | Reconciler closes session at last heartbeat; source TIMEOUT |
| Any open state | Explicit logout | OFFLINE | Close session immediately; source LOGOUT |
| Any open state | Org-timezone midnight | Same state | Close session at 23:59:59.999 and open new session at 00:00:00 |
| Any open state | Session length greater than 14 h | OFFLINE | Close at last heartbeat; flag MAX_LENGTH for review |



## 6.3 Algorithm


### Heartbeat ingestion (executed for every heartbeat)

- **Verify the JWT, device ID, HMAC signature of the payload (session secret), sequence number greater than the last one, and a nonce not seen before. Reject and flag otherwise.**
- **Set serverTs = server clock; ignore any client timestamp except for diagnostics.**
- **Store latest heartbeat in Redis key org:{org}:presence:{user} with TTL 120 s; append to presence stream.**
- **Classify the interval: if inCall or activeSeconds greater than 0 then ACTIVE else IDLE; apply thresholds from the state machine.**
- **If no open session exists and the interval is ACTIVE, create a session (clock-in). If an open session exists, update counters and last_heartbeat_at.**
- **Publish state change to the office channel and the manager live board.**

### Reconciliation job (every 60 seconds)

- **Find open sessions whose last_heartbeat_at is older than 90 s and whose socket is not connected: close them at last_heartbeat_at.**
- **Find sessions that crossed midnight or exceed the maximum length: split or close as specified.**
- **Merge overlapping sessions from multiple devices; remove double-counted time.**
- **Recompute net_seconds = active + meeting - paid-break adjustments for open and recently closed sessions.**
- **Emit exceptions (late, early leave, absent) when thresholds pass.**

### Daily close job (shortly after local midnight)

- **Finalise attendance_daily rows for the previous day for each user.**
- **Generate or update the draft timesheet and reconciliation variance.**
- **Create absence records where no session exists on a scheduled working day and no leave/holiday applies.**

## 6.4 Configurable Parameters


| Parameter | Default | Range | Scope |
| --- | --- | --- | --- |
| Heartbeat interval | 30 s | 15 to 60 s | Global |
| Missed-heartbeat timeout | 90 s | 60 to 180 s | Org |
| Disconnect grace window | 120 s | 30 to 300 s | Org |
| Idle threshold | 5 min | 2 to 30 min | Org / team |
| Pause threshold | 15 min | 5 to 60 min | Org / team |
| Maximum session length | 14 h | 8 to 18 h | Org |
| Late-arrival grace | 10 min | 0 to 60 min | Schedule |
| Manual time limit per day | 2 h | 0 to 8 h | Org |
| Timesheet variance alert | 15 % | 5 to 50 % | Org |
| Re-authentication window for vault | 10 min | 1 to 60 min | Org |



## 6.5 Accuracy Requirements and How They Are Proven


| ID | Requirement | Verification |
| --- | --- | --- |
| NFR-ACC-001 | Clock-in timestamp within 5 s of the first real user activity in at least 99% of test runs. | Automated Playwright tests inject activity and compare server timestamp with test clock |
| NFR-ACC-002 | Clock-out timestamp within 30 s of the real last activity for logout, tab close and network loss in at least 99% of runs. | Chaos tests: kill tab, disable network, sleep laptop; compare with expected |
| NFR-ACC-003 | Zero double-counted time across two simultaneous devices. | Dual-client simulation, sum of segments must equal wall-clock union |
| NFR-ACC-004 | Daily totals identical when recomputed from raw events (determinism). | Nightly replay job compares stored totals with recomputed totals; any difference raises an alert |
| NFR-ACC-005 | Server clock drift under 1 s. | NTP monitoring alert at 500 ms drift |



## 6.6 Edge Cases


| Case | Handling |
| --- | --- |
| Laptop sleep or lid closed | Heartbeats stop; session closes at last heartbeat after 90 s; on wake a new session starts. Gap is not paid. |
| Browser tab in background | Browsers throttle timers; the client uses a Web Worker for the heartbeat and reports 'visible=false'. Counters still reflect input events from other tabs only via the agent; otherwise the interval is IDLE unless in call. |
| User works in another application (browser-only mode) | Browser cannot see it. The organisation chooses: (a) require the desktop agent, (b) allow manual time with limits, or (c) count tab-open as active. Recommended: desktop agent for subcontractors billed hourly. |
| Internet outage of 10 minutes | Session closes after grace; if the desktop agent or PWA buffered events, a correction is proposed automatically and flagged 'offline-synced' for manager approval. |
| Server restart during session | Sessions are durable in PostgreSQL; heartbeats continue after restart; the grace window covers short outages. |
| Forgotten logout overnight | Max-length and midnight rules close the session at the last heartbeat; no phantom hours. |
| Time-zone travel | Work date is determined in the organisation timezone; user timezone is shown for display only. |
| Daylight-saving changes | All storage is UTC; day boundaries use the IANA timezone database. |
| Mouse jiggler or auto-clicker | Pattern heuristics (perfectly regular intervals, no keyboard entropy) flag the session for review. No automatic penalty. |
| Shared or kiosk computer | Session bound to the logged-in user and device; device change triggers flag. |



## 6.7 Privacy and Ethics Guardrails

- **Collect the minimum: timestamps, state, counters and IP only.**
- **No screenshots, no keystroke content, no webcam or microphone capture for monitoring purposes.**
- **Users always see their own data and the current tracking state (tray icon or status badge).**
- **Managers see summaries; raw event streams are limited to HR with an audit entry per access.**
- **Raw presence events are deleted after 90 days (configurable); daily summaries are kept per retention policy.**

# 7. Database Design


## 7.1 Data Stores


| Store | Technology | Holds | Why |
| --- | --- | --- | --- |
| Primary relational DB | PostgreSQL 16 | Users, organisations, contracts, tasks, timesheets, attendance, document metadata, audit log | ACID, relational integrity, JSONB, RLS, mature backups |
| Time-series extension | TimescaleDB (hypertable) | presence_events with automatic partitioning, compression and 90-day retention | Efficient high-volume event storage inside the same database |
| In-memory store | Redis 7 | Live presence, avatar positions, rate limits, nonces, WebSocket adapter, BullMQ queues | Sub-millisecond reads/writes; state is reconstructible |
| Object storage | S3-compatible (AWS S3) | Encrypted documents, recordings, avatars, exports | Durable, cheap, versioned, lifecycle rules |
| Key management | AWS KMS | Key-encryption keys for documents and secrets | Hardware-protected keys, audit trail |
| Search (later) | OpenSearch | Full-text search at large scale | Only if Postgres full-text becomes insufficient |



## 7.2 Conventions

- **Primary keys are UUID v7 (time-ordered) except high-volume event tables that use bigint identity.**
- **Every business table includes org_id, created_at, updated_at (timestamptz, UTC) and created_by where relevant.**
- **Soft deletion with deleted_at for user-visible entities; hard deletion only through retention or crypto-shredding.**
- **Enumerations are implemented as PostgreSQL enums or constrained text and mirrored in packages/shared.**
- **Money uses numeric(12,2) with an explicit ISO currency code; durations are stored in integer seconds or minutes.**
- **Sensitive fields (tax ID, bank details, MFA secrets) are encrypted at the application layer (columns ending _enc).**

## 7.3 Entity Overview by Domain


| Domain | Tables |
| --- | --- |
| Identity and access | organizations, users, roles, user_roles, invitations, auth_sessions, devices, mfa_recovery_codes |
| People and contracts | teams, subcontractor_profiles, contracts, projects, project_members, work_schedules, leave_requests, holidays, onboarding_items |
| Attendance | attendance_sessions, attendance_segments, presence_events, attendance_daily, attendance_corrections |
| Timesheets | time_entries, timesheets, timesheet_approvals |
| Tasks | tasks, task_comments, task_attachments, task_activity, daily_plans, daily_plan_items, weekly_plans |
| Documents | folders, documents, document_versions, document_acl, document_share_links, document_access_logs, policy_acknowledgements |
| Office and meetings | offices, rooms, meetings, meeting_participants, recordings, channels, channel_members, messages |
| Platform | notifications, notification_preferences, audit_logs, consents, feature_flags, settings, webhooks |



## 7.4 Detailed Table Definitions

**The tables below define the core columns. The AI agent shall create Prisma models and SQL migrations from these definitions, adding indexes as listed in Section 7.6.**


### organizations

**Tenant root.**


| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK |  |
| name | varchar(200) | Company name |
| slug | varchar(80) unique | Subdomain / URL key |
| timezone | varchar(64) | IANA name, default Asia/Colombo |
| work_week | jsonb | Working days, e.g. [1,2,3,4,5] |
| default_currency | char(3) | ISO 4217 |
| settings | jsonb | Policy parameters from Section 6.4 |
| status | enum | ACTIVE, SUSPENDED, CLOSED |
| created_at, updated_at | timestamptz |  |



### users

**Employees, subcontractors, interns and admins.**


| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK |  |
| org_id | uuid FK | RLS key |
| email | citext | Unique per org |
| password_hash | text | Argon2id; null for SSO-only users |
| first_name, last_name, display_name | varchar |  |
| avatar_key | text | Object storage key |
| employment_type | enum | EMPLOYEE, SUBCONTRACTOR, INTERN |
| role_id | uuid FK roles |  |
| team_id | uuid FK teams | Nullable |
| manager_id | uuid FK users | Approver |
| timezone | varchar(64) | Display timezone |
| status | enum | INVITED, ACTIVE, SUSPENDED, OFFBOARDED |
| mfa_enabled | boolean |  |
| mfa_secret_enc | bytea | Encrypted TOTP secret |
| failed_login_count, locked_until | int, timestamptz | Lockout |
| last_login_at | timestamptz |  |



### subcontractor_profiles

**One-to-one extension of users for contractors.**


| Column | Type | Notes |
| --- | --- | --- |
| user_id | uuid PK/FK |  |
| company_name | varchar(200) |  |
| country | char(2) | ISO 3166 |
| tax_id_enc | bytea | Encrypted |
| bank_details_enc | bytea | Encrypted JSON |
| rate_type | enum | HOURLY, DAILY, FIXED |
| rate | numeric(12,2) |  |
| currency | char(3) |  |
| overtime_multiplier | numeric(4,2) | Default 1.5 |
| weekly_hours_cap | numeric(5,2) | Nullable |
| emergency_contact | jsonb |  |



### contracts

**Contract records with expiry tracking.**


| Column | Type | Notes |
| --- | --- | --- |
| id | uuid PK |  |
| org_id, user_id | uuid FK |  |
| title, scope | varchar, text |  |
| start_date, end_date | date |  |
| status | enum | DRAFT, ACTIVE, EXPIRED, TERMINATED |
| document_id | uuid FK documents | Signed contract file |
| renewal_notice_days | int | Default 30 |



### projects

**Work containers for tasks and time.**


| Column | Type | Notes |
| --- | --- | --- |
| id, org_id | uuid |  |
| name, code | varchar | Code unique per org |
| client_name | varchar | Nullable |
| manager_id | uuid FK users |  |
| billable | boolean |  |
| status | enum | ACTIVE, ON_HOLD, DONE, ARCHIVED |
| start_date, end_date | date |  |



### tasks

**Core task entity.**


| Column | Type | Notes |
| --- | --- | --- |
| id, org_id | uuid |  |
| project_id | uuid FK |  |
| parent_task_id | uuid FK tasks | Subtasks |
| title | varchar(300) |  |
| description | text | Rich text (sanitised HTML or Markdown) |
| status | enum | TODO, IN_PROGRESS, IN_REVIEW, BLOCKED, DONE |
| priority | enum | LOW, MEDIUM, HIGH, URGENT |
| assignee_id, reporter_id | uuid FK users |  |
| accepted_at | timestamptz | Subcontractor acceptance |
| due_date, planned_date | date | Drive daily and weekly lists |
| estimate_minutes, actual_minutes | int | Actual computed from time_entries |
| labels | text[] |  |
| recurrence_rule | text | RFC 5545 RRULE |
| completed_at | timestamptz |  |



### daily_plans and daily_plan_items

**Start-of-day plan and end-of-day report per user.**


| Column | Type | Notes |
| --- | --- | --- |
| daily_plans.id, org_id, user_id | uuid |  |
| plan_date | date | Unique per user and date |
| goals | text |  |
| eod_summary, blockers | text | End-of-day report |
| submitted_at | timestamptz |  |
| daily_plan_items.plan_id, task_id | uuid FK |  |
| daily_plan_items.sort_order, status | int, enum | PLANNED, DONE, CARRIED_OVER |



### attendance_sessions

**One row per continuous work session (the source of in/out times).**


| Column | Type | Notes |
| --- | --- | --- |
| id, org_id, user_id | uuid |  |
| work_date | date | In organisation timezone |
| clock_in_at | timestamptz | Server time |
| clock_out_at | timestamptz null | Null while open |
| clock_in_source | enum | AUTO_HEARTBEAT, AUTO_LOGIN, AGENT, CORRECTION |
| clock_out_source | enum null | LOGOUT, DISCONNECT, TIMEOUT, MIDNIGHT, MAX_LENGTH, AGENT, CORRECTION |
| active_seconds, idle_seconds, break_seconds, meeting_seconds, net_seconds | int | Computed counters |
| last_heartbeat_at | timestamptz | Used by reconciler |
| device_id | uuid FK devices |  |
| ip_in, ip_out | inet |  |
| flags | text[] | MULTI_DEVICE, LONG_IDLE, OFFLINE_SYNCED, SUSPICIOUS, MAX_LENGTH |
| status | enum | OPEN, CLOSED, PENDING_REVIEW, ADJUSTED |



### attendance_segments

**Fine-grained state intervals inside a session.**


| Column | Type | Notes |
| --- | --- | --- |
| id | bigint identity PK |  |
| session_id | uuid FK |  |
| state | enum | ACTIVE, IDLE, PAUSED, IN_MEETING, ON_BREAK, DISCONNECTED |
| started_at, ended_at | timestamptz |  |
| meeting_id | uuid FK null |  |
| reason | text | Optional |



### presence_events (hypertable)

**Raw event stream, partitioned by day; retained 90 days.**


| Column | Type | Notes |
| --- | --- | --- |
| id | bigint identity |  |
| org_id, user_id, session_id | uuid |  |
| server_ts | timestamptz | Partition key |
| client_ts | timestamptz | Diagnostics only |
| event_type | enum | HEARTBEAT, CONNECT, DISCONNECT, LOGIN, LOGOUT, BREAK_START, BREAK_END, CALL_JOIN, CALL_LEAVE |
| state | enum |  |
| seq | bigint | Monotonic per device |
| ip | inet |  |
| meta | jsonb | Counters, visibility, agent version |



### attendance_daily

**Materialised daily summary.**


| Column | Type | Notes |
| --- | --- | --- |
| org_id, user_id, work_date | PK |  |
| first_in, last_out | timestamptz |  |
| active_seconds, idle_seconds, break_seconds, meeting_seconds, net_seconds | int |  |
| expected_seconds | int | From schedule, holidays and leave |
| late_minutes, early_leave_minutes, overtime_minutes | int |  |
| day_status | enum | PRESENT, ABSENT, LEAVE, HOLIDAY, PARTIAL |



### attendance_corrections

**Requests to fix missed or wrong in/out times.**


| Column | Type | Notes |
| --- | --- | --- |
| id, org_id, user_id | uuid |  |
| session_id | uuid FK null | Null for a missed day |
| requested_in, requested_out | timestamptz |  |
| reason, evidence_document_id | text, uuid |  |
| status | enum | PENDING, APPROVED, REJECTED |
| reviewer_id, reviewed_at, review_note | uuid, timestamptz, text |  |



### work_schedules

**Expected hours.**


| Column | Type | Notes |
| --- | --- | --- |
| id, org_id | uuid |  |
| user_id or team_id | uuid | One of the two |
| days | jsonb | Per weekday start, end, expected hours |
| flexible | boolean |  |
| grace_minutes | int |  |
| effective_from, effective_to | date |  |



### time_entries

**Raw task-level time (timer or manual).**


| Column | Type | Notes |
| --- | --- | --- |
| id, org_id, user_id | uuid |  |
| project_id, task_id | uuid FK |  |
| started_at, ended_at | timestamptz |  |
| minutes | int |  |
| source | enum | TIMER, MANUAL, AUTO_FROM_ATTENDANCE |
| billable | boolean |  |
| note, manual_reason | text |  |
| timesheet_id | uuid FK null | Set on submission |
| flagged | boolean | Variance or manual-limit exceeded |



### timesheets

**Periodic approvable summary per user.**


| Column | Type | Notes |
| --- | --- | --- |
| id, org_id, user_id | uuid |  |
| period_start, period_end | date |  |
| status | enum | DRAFT, SUBMITTED, APPROVED, REJECTED, LOCKED, PAID |
| attendance_minutes, logged_minutes, billable_minutes, variance_minutes | int |  |
| amount, currency | numeric(12,2), char(3) | Payable amount |
| submitted_at, approved_by, approved_at, rejection_reason | mixed |  |



### documents

**Document metadata (content lives in object storage).**


| Column | Type | Notes |
| --- | --- | --- |
| id, org_id | uuid |  |
| folder_id | uuid FK |  |
| title_enc or title | text / bytea | Encrypted for confidential |
| category | enum | CONTRACT, NDA, IDENTITY, TAX, INVOICE, POLICY, CERTIFICATE, OTHER |
| confidentiality | enum | NORMAL, CONFIDENTIAL, RESTRICTED |
| owner_id, linked_user_id, linked_contract_id | uuid FK |  |
| tags | text[] |  |
| expires_at | date null | Reminders |
| password_protected | boolean |  |
| current_version_id | uuid FK |  |
| legal_hold, deleted_at | boolean, timestamptz |  |



### document_versions

**Each stored version with its own keys.**


| Column | Type | Notes |
| --- | --- | --- |
| id, document_id | uuid |  |
| version_no | int |  |
| storage_key | text | org_id/doc_id/version_id |
| file_name_enc, mime_type, size_bytes | bytea, text, bigint |  |
| sha256 | char(64) | Integrity and e-sign evidence |
| dek_wrapped_kms | bytea | DEK wrapped by KMS key |
| dek_wrapped_pw, pw_salt, pw_kdf_params | bytea null | Present when per-document password set |
| iv | bytea | AES-GCM nonce |
| scan_status | enum | PENDING, CLEAN, INFECTED |
| uploaded_by, uploaded_at | uuid, timestamptz |  |



### document_acl and document_share_links

**Permissions and external sharing.**


| Column | Type | Notes |
| --- | --- | --- |
| document_acl.document_id or folder_id | uuid |  |
| document_acl.principal_type, principal_id | enum, uuid | USER, ROLE, TEAM |
| document_acl.permission | enum | VIEW, DOWNLOAD, EDIT, MANAGE |
| document_acl.expires_at | timestamptz null |  |
| share_links.token_hash | char(64) | Only the hash is stored |
| share_links.password_hash | text null | Argon2id |
| share_links.expires_at, max_downloads, download_count, revoked_at | mixed |  |



### document_access_logs

**Immutable access trail.**


| Column | Type | Notes |
| --- | --- | --- |
| id | bigint identity |  |
| org_id, document_id, version_id, user_id | uuid | user_id null for share-link guests |
| action | enum | VIEW, DOWNLOAD, UPLOAD, SHARE, DELETE, ACL_CHANGE, PASSWORD_FAIL, RECOVER |
| ip, user_agent | inet, text |  |
| created_at | timestamptz |  |



### offices, rooms

**Virtual office structure.**


| Column | Type | Notes |
| --- | --- | --- |
| offices.id, org_id, name | uuid, varchar |  |
| offices.map_json | jsonb | Tiled map definition, floors, collision layer |
| rooms.id, office_id | uuid |  |
| rooms.name, type | varchar, enum | OPEN, MEETING, PRIVATE, BROADCAST |
| rooms.capacity | int |  |
| rooms.bounds | jsonb | Polygon or rectangle in map coordinates |
| rooms.access_mode | enum | OPEN, KNOCK, INVITE, PASSWORD |
| rooms.password_hash | text null |  |
| rooms.livekit_room_name | varchar | Media session key |



### meetings and meeting_participants

**Scheduled, instant and room meetings.**


| Column | Type | Notes |
| --- | --- | --- |
| meetings.id, org_id | uuid |  |
| title, agenda, notes | text |  |
| type | enum | INSTANT, ROOM, SCHEDULED |
| host_id, room_id | uuid FK |  |
| scheduled_start, scheduled_end, started_at, ended_at | timestamptz |  |
| recurrence_rule | text null |  |
| recording_id | uuid null |  |
| participants.meeting_id, user_id | uuid |  |
| participants.joined_at, left_at, duration_seconds | timestamptz, int | Credited to attendance |



### audit_logs

**Append-only; hash-chained.**


| Column | Type | Notes |
| --- | --- | --- |
| id | bigint identity |  |
| org_id, actor_id | uuid |  |
| action | varchar(80) | e.g. USER_ROLE_CHANGED |
| entity_type, entity_id | varchar, uuid |  |
| before, after | jsonb | Sensitive values redacted |
| ip, user_agent | inet, text |  |
| prev_hash, hash | char(64) | SHA-256 chain for tamper evidence |
| created_at | timestamptz |  |



### auth_sessions and devices

**Login sessions and known devices.**


| Column | Type | Notes |
| --- | --- | --- |
| auth_sessions.id, user_id | uuid |  |
| refresh_token_hash | char(64) | Rotated on each refresh; family id for reuse detection |
| device_id | uuid FK |  |
| ip, user_agent | inet, text |  |
| created_at, expires_at, revoked_at | timestamptz |  |
| devices.fingerprint_hash, platform, label, first_seen_at, last_seen_at, trusted | mixed |  |



## 7.5 Key Relationships

- **organizations 1 to N users, teams, projects, offices, documents.**
- **users 1 to 1 subcontractor_profiles (when employment_type is SUBCONTRACTOR); users 1 to N contracts.**
- **projects N to M users through project_members; projects 1 to N tasks; tasks 1 to N time_entries.**
- **users 1 to N attendance_sessions; attendance_sessions 1 to N attendance_segments; users 1 to N attendance_daily.**
- **timesheets 1 to N time_entries; timesheets N to 1 users.**
- **documents 1 to N document_versions; documents N to M principals through document_acl; documents 1 to N document_access_logs.**
- **offices 1 to N rooms; rooms 1 to N meetings; meetings 1 to N meeting_participants.**

## 7.6 Indexing, Partitioning and Retention


| Object | Strategy |
| --- | --- |
| attendance_sessions | Index (org_id, user_id, work_date); partial index on status = 'OPEN'; index on last_heartbeat_at for the reconciler |
| presence_events | Hypertable by server_ts (1-day chunks); compress after 7 days; drop after 90 days; index (user_id, server_ts) |
| tasks | Index (org_id, assignee_id, status); (org_id, assignee_id, planned_date); (project_id, status) |
| time_entries | Index (user_id, started_at); (timesheet_id) |
| documents | Index (org_id, category); GIN on tags; GIN tsvector for search of non-confidential titles; index on expires_at |
| document_access_logs, audit_logs | Partition by month; index (org_id, created_at); never updated or deleted by the application role |
| All tenant tables | Composite indexes lead with org_id; RLS policy on every table |



## 7.7 Redis Key Design


| Key pattern | Type | TTL | Purpose |
| --- | --- | --- | --- |
| org:{o}:presence:{u} | Hash | 120 s | Latest state, last heartbeat, device, call flag |
| org:{o}:office:{office}:pos | Geo / hash | None (cleaned on disconnect) | Avatar positions, grid index for interest management |
| hb:nonce:{u}:{nonce} | String | 300 s | Replay protection |
| rl:{route}:{ip or user} | Counter | Window | Rate limiting |
| reauth:{u} | String | 10 min | Vault re-authentication window |
| bull:* | Mixed | n/a | Job queues |



## 7.8 Object Storage Layout and Backup

- **Buckets: hrvo-docs (encrypted documents), hrvo-media (avatars, recordings), hrvo-exports (temporary, 24 h lifecycle).**
- **Key format: {org_id}/{doc_id}/{version_id}; versioning and object lock enabled for documents.**
- **PostgreSQL: continuous WAL archiving with point-in-time recovery, daily snapshots retained 35 days, weekly snapshots retained 12 months, cross-region copy.**
- **Targets: RPO 5 minutes, RTO 2 hours. Restore drills each quarter.**

# 8. External Interface Requirements


## 8.1 Screen Inventory


| Area | Screens |
| --- | --- |
| Public / auth | Login, accept invitation, forgot/reset password, 2FA setup and verify, privacy notice acceptance |
| Office | Office map, room view, people list, search, status menu, call panel, announcement banner, guest join page |
| Meetings and chat | Pre-join check, meeting view, schedule meeting, meeting notes, channels, direct messages |
| My work | Today (daily plan), Weekly planner, My tasks, Kanban board, task detail, timer widget |
| Attendance | My attendance (day / week / month), break control, correction request, live board (manager), exceptions |
| Timesheets | My timesheet, submit, approvals queue, rates and amounts, invoice export |
| Documents | Folders, document list, document detail with versions and access log, upload, vault unlock, share link dialog, e-sign |
| People (HR) | Directory, user profile, subcontractor profile and contract, onboarding checklist, schedules, leave, holidays |
| Reports | Dashboard, attendance, hours and cost, tasks, compliance, scheduled reports |
| Admin | Organisation settings, policies, roles, map editor, audit log, retention, integrations, feature flags |



## 8.2 UI and UX Principles

- **The office map is the home screen; a collapsible side panel shows tasks, attendance status and chat without leaving the map.**
- **Status and tracking are always visible: a badge shows 'Tracking: Active since 09:02' so the user is never unaware.**
- **WCAG 2.1 AA: keyboard navigation, screen-reader labels, colour contrast, list-view alternative to the map.**
- **Responsive layouts for 360 px to 4K; dark and light themes.**
- **Internationalisation framework from day one (English first; Sinhala and Tamil prepared).**

## 8.3 REST API (versioned /api/v1)


| Group | Representative endpoints |
| --- | --- |
| Auth | POST /auth/login, /auth/refresh, /auth/logout, /auth/2fa/enable, /auth/2fa/verify, /auth/password/forgot, /auth/password/reset, /auth/invitations/accept, GET /auth/sessions, DELETE /auth/sessions/:id |
| Users and org | GET/POST /users, GET/PATCH /users/:id, POST /users/:id/offboard, GET/PATCH /org, GET/POST /teams, GET/POST /projects, GET/POST /contracts, GET/PUT /schedules |
| Attendance | GET /attendance/me?from&to, GET /attendance/sessions, POST /attendance/break/start, POST /attendance/break/end, POST /attendance/corrections, PATCH /attendance/corrections/:id, GET /attendance/live, GET /attendance/daily, GET /attendance/export |
| Timesheets | GET /time-entries, POST /time-entries, POST /tasks/:id/timer/start, POST /tasks/:id/timer/stop, GET /timesheets, POST /timesheets/:id/submit, POST /timesheets/:id/approve, POST /timesheets/:id/reject, POST /timesheets/:id/reopen, GET /timesheets/:id/invoice |
| Tasks | GET/POST /tasks, GET/PATCH /tasks/:id, POST /tasks/:id/comments, POST /tasks/:id/accept, GET /plans/daily/:date, PUT /plans/daily/:date, POST /plans/daily/:date/submit, GET/PUT /plans/weekly/:weekStart |
| Documents | POST /documents/upload-ticket, POST /documents/:id/complete, GET /documents, GET /documents/:id, GET /documents/:id/download (requires reauth), POST /documents/:id/password, POST /documents/:id/unlock, POST /documents/:id/versions, PUT /documents/:id/acl, POST /documents/:id/share-links, GET /documents/:id/access-log, POST /auth/reauth |
| Office and meetings | GET /offices/:id, PUT /offices/:id/map, GET /rooms, POST /rooms/:id/token (LiveKit token), POST /meetings, GET /meetings, PATCH /meetings/:id, GET /meetings/:id/participants |
| Chat | GET /channels, POST /channels, GET /channels/:id/messages, POST /channels/:id/messages |
| Reports and admin | GET /reports/{attendance,hours,tasks,compliance}, POST /reports/schedules, GET /audit-logs, GET/PUT /settings, GET/PUT /roles, GET /notifications, PATCH /notifications/:id/read |


**API conventions: JSON; cursor pagination; RFC 7807 problem-details errors; idempotency keys on create endpoints; OpenAPI 3.1 specification generated automatically from NestJS decorators and used to generate the frontend client.**


## 8.4 WebSocket Events (Socket.IO)


| Direction | Event | Payload (summary) |
| --- | --- | --- |
| Client to server | presence:heartbeat | seq, nonce, intervalActiveSec, intervalIdleSec, visible, focused, inCall, signature |
| Client to server | office:join / office:leave | officeId |
| Client to server | office:move | x, y, direction (throttled 10 per second, validated against collision map) |
| Client to server | room:enter / room:leave | roomId, password (if required) |
| Client to server | status:set | status, message |
| Client to server | chat:send | channelId, body, attachments |
| Server to client | presence:update | userId, state, statusMessage |
| Server to client | office:positions | Batched positions for users in the neighbourhood |
| Server to client | room:state | Participants, lock state, LiveKit token |
| Server to client | attendance:event | Auto clock-in, auto clock-out, idle warning, session closed |
| Server to client | notification:new | Notification object |
| Server to client | chat:message | Message object |



## 8.5 Third-Party Integrations


| Service | Purpose | Phase |
| --- | --- | --- |
| LiveKit (Cloud or self-hosted) | Audio, video, screen share, recording | P2 |
| AWS S3 and KMS | Encrypted file storage and key custody | P1 |
| AWS SES or Resend | Transactional email | P1 |
| Google and Microsoft OIDC | Single sign-on | P2 |
| Google Calendar / Outlook Calendar | Meeting sync | P3 |
| ClamAV | Virus scanning | P1 |
| Sentry, Grafana | Monitoring | P1 |
| Slack / Teams webhooks | Alerts | P3 |
| DocuSign (optional) | Legally binding e-signature where required | P3 |



# 9. Non-Functional Requirements


| ID | Category | Requirement |
| --- | --- | --- |
| NFR-PERF-001 | Performance | API p95 latency under 300 ms and p99 under 800 ms for standard reads at 500 concurrent users. |
| NFR-PERF-002 | Performance | Page load (largest contentful paint) under 2.5 s on a 10 Mbps connection; office canvas at 60 fps with 100 visible avatars on a mid-range laptop. |
| NFR-PERF-003 | Performance | Avatar movement and presence updates delivered within 200 ms (p95) in-region; chat messages within 500 ms. |
| NFR-PERF-004 | Performance | Audio/video end-to-end latency under 300 ms (p95) in-region; audio-only fallback below 500 kbps. |
| NFR-SCAL-001 | Scalability | Launch capacity 500 concurrent users per deployment; architecture supports 5,000 by adding stateless API nodes, Redis cluster and LiveKit nodes without redesign. |
| NFR-SCAL-002 | Scalability | Presence gateway nodes are stateless; Socket.IO Redis adapter used; sticky sessions not required beyond the handshake. |
| NFR-AVAIL-001 | Availability | 99.9% monthly uptime for API and web (about 43 minutes downtime per month), excluding announced maintenance. |
| NFR-AVAIL-002 | Availability | Zero-downtime deployments via rolling updates; database migrations backwards compatible. |
| NFR-REL-001 | Reliability | No loss of attendance data: heartbeats acknowledged only after durable write; replay and reconciliation repair gaps. |
| NFR-REL-002 | Reliability | RPO 5 minutes and RTO 2 hours; quarterly restore test documented. |
| NFR-SEC-001 | Security | All data encrypted in transit (TLS 1.2+) and at rest (AES-256); confidential documents use envelope encryption (Section 10). |
| NFR-SEC-002 | Security | No Critical or High findings from OWASP ZAP scan and an independent penetration test before production launch. |
| NFR-SEC-003 | Security | Secrets are held in AWS Secrets Manager; none in source code, images or logs; dependencies scanned in CI. |
| NFR-SEC-004 | Security | Strict Content-Security-Policy, CSRF protection, input validation with Zod/class-validator, output encoding, rate limiting on all public endpoints. |
| NFR-PRIV-001 | Privacy | Compliance with Sri Lanka PDPA and, where applicable, GDPR: lawful basis, minimisation, purpose limitation, subject rights, breach notification process. |
| NFR-PRIV-002 | Privacy | Data residency selectable at deployment (default AWS Singapore or Mumbai). |
| NFR-USAB-001 | Usability | A new user completes onboarding and enters the office in under 5 minutes; core actions reachable in 3 clicks. |
| NFR-USAB-002 | Accessibility | WCAG 2.1 AA conformance for all non-map screens; the office has a full keyboard and list-view alternative. |
| NFR-COMP-001 | Compatibility | Latest two versions of Chrome, Edge, Firefox, Safari; iOS 16+ and Android 10+ browsers. |
| NFR-MAINT-001 | Maintainability | Test coverage of at least 80% for business logic and 100% for attendance and crypto modules; linting and type-checking enforced in CI. |
| NFR-MAINT-002 | Maintainability | Every module has an ADR (architecture decision record), README and OpenAPI documentation maintained by the AI agent. |
| NFR-OBS-001 | Observability | Structured logs with correlation IDs, metrics and traces; alerts for error rate, latency, queue backlog, clock drift and heartbeat ingestion lag. |
| NFR-I18N-001 | Localisation | UI text externalised; dates, times and currencies formatted by locale; English at launch. |



# 10. Security Architecture


## 10.1 Confidential Document Vault: Encryption Design

**Goal: a leak of the database, the storage bucket or a backup must not reveal the content of contract or identity documents.**


| Step | Operation |
| --- | --- |
| 1. Upload | API generates a random 256-bit data key (DEK) and a 96-bit IV for each file version and encrypts the stream with AES-256-GCM. The ciphertext is stored in S3. |
| 2. KMS wrapping | The DEK is wrapped (encrypted) by an AWS KMS key with encryption context {org_id, document_id}. The wrapped DEK is stored in document_versions.dek_wrapped_kms. The plaintext DEK is discarded from memory. |
| 3. Optional password | If the owner sets a document password, a key-encryption key is derived with Argon2id (memory 64 MiB, 3 iterations, random 16-byte salt) and the DEK is wrapped a second time into dek_wrapped_pw. Both wrappings are needed to open the file in password mode. |
| 4. Access | User must pass RBAC/ACL checks, a recent re-authentication (password or TOTP, 10-minute window) and, if required, the document password. The API asks KMS to unwrap, decrypts in memory, streams to the client, and writes the access log. |
| 5. Recovery | A lost document password can be reset only by a user with vault.recover permission; KMS-wrapped DEK is used to re-wrap with a new password; the event is logged and the owner is notified. |
| 6. Deletion | Crypto-shredding: destroying wrapped DEKs makes every copy and backup of the ciphertext permanently unreadable. |



## 10.2 Threat Model Summary


| Threat | Example | Mitigation |
| --- | --- | --- |
| Spoofing | Stolen password used to clock in as someone else | 2FA, device binding, anomalous-login alerts, signed heartbeats |
| Tampering | Manually editing attendance to inflate hours | Server-authoritative time, immutable originals, hash-chained audit log, correction approvals |
| Repudiation | Manager denies approving a timesheet | Audit log with actor, IP and before/after values |
| Information disclosure | Subcontractor reads another's contract | RBAC + ACL + RLS, encrypted documents, access logs |
| Denial of service | Flooding WebSocket or upload endpoints | Cloudflare WAF, rate limits, upload size limits, autoscaling |
| Elevation of privilege | Role escalation through API | Server-side permission checks on every route; permission tests in CI |
| Malicious upload | Malware in contract PDF | ClamAV scan, type allow-list, sandboxed preview conversion |
| Cross-tenant leak | Query missing org filter | PostgreSQL Row-Level Security as a second barrier |
| Heartbeat forgery | Script that sends fake heartbeats | HMAC with session secret, nonce, sequence, rate limit, pattern analysis |
| Supply chain | Malicious npm package from AI-suggested code | Lockfiles, dependency audit and review in CI, allow-list of new packages requiring human approval |



## 10.3 Security Controls Checklist

- **OWASP ASVS Level 2 as the baseline; automated checks in CI (dependency audit, secret scanning, static analysis).**
- **Principle of least privilege for IAM roles; separate production AWS account; no human access to production data without break-glass approval and logging.**
- **Short-lived presigned URLs (5 minutes), never public buckets, bucket policies deny non-TLS.**
- **Security headers: CSP, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy.**
- **Database access through a limited application role subject to RLS; no superuser in the app.**
- **Annual external penetration test and after every major release; vulnerability disclosure contact published.**
- **Incident response runbook with 72-hour breach-notification procedure.**

# 11. Legal, Privacy and Compliance Requirements


| Important: this section describes engineering requirements derived from common privacy principles. It is not legal advice. The organisation must have a qualified lawyer review the monitoring notice, contracts and data-protection approach for every country where users are located. |
| --- |


- **Employee and subcontractor monitoring requires a clear written notice describing what is collected, why, retention and who can see it; acceptance is recorded (FR-AUD-004).**
- **Monitoring shall be proportionate: attendance-relevant signals only; no screenshots, keystroke content or camera capture.**
- **Meeting recording requires a visible banner and consent from participants; recordings can be disabled by organisation policy.**
- **Subjects can request access to, correction of and deletion of their data; the system provides export and anonymisation tools (FR-AUD-002, 003).**
- **Cross-border transfers: store data in the region chosen by the organisation; document sub-processors (AWS, LiveKit, email provider).**
- **Subcontractor contracts shall state the data-processing terms and the monitoring policy.**
- **Retention defaults: raw presence events 90 days; attendance summaries and timesheets 7 years (configurable); documents per category policy; chat 2 years; recordings 90 days.**

# 12. Deployment and Operations


## 12.1 Environments


| Environment | Purpose | Notes |
| --- | --- | --- |
| Local | Developer / AI agent workstation | Docker Compose: Postgres, Redis, MinIO, ClamAV, LiveKit dev server, Mailhog |
| Preview | Per pull request | Ephemeral environment with seeded data for review |
| Staging | UAT and load tests | Production-like; anonymised data |
| Production | Live | Separate AWS account; multi-AZ |



## 12.2 Topology


| Stage | Topology |
| --- | --- |
| MVP (up to 50 users) | One or two EC2/Lightsail instances with Docker Compose (web, API, worker), managed PostgreSQL (RDS), managed Redis, S3, LiveKit Cloud. Cloudflare in front. |
| Growth (up to 500 users) | ECS Fargate services (web, API, gateway, worker) behind ALB, RDS Multi-AZ, ElastiCache, S3, self-hosted LiveKit on two nodes or LiveKit Cloud. |
| Scale (5,000+ users) | Autoscaled services, read replicas, Redis cluster, regional LiveKit nodes, CDN for static assets, OpenSearch. |



## 12.3 CI/CD

- **GitHub Actions on every pull request: install, lint, type-check, unit tests, build, Prisma migration check, dependency audit, secret scan.**
- **Playwright end-to-end tests on the preview environment; attendance accuracy suite nightly on staging.**
- **Main branch deploys automatically to staging; production deploy requires manual approval and runs migrations first (expand/contract pattern).**
- **Infrastructure defined in Terraform; no manual console changes.**

## 12.4 Indicative Running Cost (Estimate Only)

**These figures are rough planning estimates in US dollars per month and must be re-checked against current provider pricing before budgeting. Video usage (LiveKit or bandwidth) is the most variable item.**


| Stage | Infrastructure estimate | Main cost drivers |
| --- | --- | --- |
| MVP, up to 50 users | About US$150 to 400 per month | Compute, RDS, LiveKit Cloud minutes, email, monitoring |
| Growth, up to 500 users | About US$800 to 2,500 per month | Fargate, Multi-AZ database, media bandwidth and recording storage |



# 13. Delivery Plan: Building with an AI Coding Agent

**The client does not write code. An AI coding agent produces the code under the client's direction. This section describes how to run the project so that speed does not compromise quality or security.**


## 13.1 Roles


| Role | Who | Responsibility |
| --- | --- | --- |
| Product owner | You | Owns this SRS, approves each module, runs acceptance tests, decides priorities |
| AI coding agent | Claude Code (primary); optionally a second agent for review | Writes code, tests, migrations and documentation module by module from the SRS |
| Technical reviewer (strongly recommended) | Part-time senior engineer or consultant, a few hours per week | Reviews architecture, security-critical code (attendance engine, vault crypto, auth), infrastructure and the final penetration-test fixes |
| Designer (optional) | Freelancer | Office art assets, tilesets, brand and UX polish |
| Legal adviser | Lawyer | Monitoring notice, contracts, privacy policy |



| Honest expectation: an AI agent can write most of this code quickly, but it will make mistakes, especially in security, concurrency and real-time behaviour. Never ship the attendance engine, authentication or document encryption without tests and an independent review. Speed comes from clear specifications and small, verified increments, not from skipping verification. |
| --- |



## 13.2 Working Method

- **Specification first:**** split this SRS into markdown files in /docs (one per module). The agent reads the relevant file before writing code.**
- **Project rules file:**** create CLAUDE.md in the repository root defining stack, folder structure, naming, security rules (no secrets in code, RLS on every table, validate all input), testing rules and a Definition of Done.**
- **Small vertical slices:**** one requirement group at a time (for example FR-ATT-001 to 005), each delivered as migration, API, UI, tests and docs.**
- **Test-driven for critical logic:**** the agent must write the attendance state-machine tests before the implementation, using the scenarios in Section 6.6.**
- **Every slice ends with a demo:**** the agent starts the app locally and shows the feature working; you check it against the acceptance criteria in Section 14.**
- **Version control discipline:**** every slice on its own branch, pull request, automated checks, human or second-agent review, then merge.**
- **Dependencies:**** the agent must ask before adding any new package; reviewer approves.**
- **Memory of decisions:**** the agent records decisions as ADRs in /docs/adr so future sessions stay consistent.**

## 13.3 Definition of Done (per slice)

- **Requirement IDs implemented and listed in the pull request.**
- **Unit and integration tests pass; coverage thresholds met.**
- **Linting, type-check and dependency audit clean.**
- **RLS policy and permission tests exist for any new table or route.**
- **OpenAPI spec updated; UI states for loading, empty and error implemented.**
- **Audit-log entries written for sensitive actions.**
- **Documentation and ADR updated; demo recorded or screenshots attached.**

## 13.4 Phased Roadmap


| Phase | Duration (estimate) | Deliverables | Exit criteria |
| --- | --- | --- | --- |
| P0 Foundations | Weeks 1 to 2 | Monorepo, CI/CD, Docker Compose, Terraform skeleton, auth, RBAC, RLS, audit log, design system | Login with 2FA works; CI green; staging live |
| P1 Core HR MVP | Weeks 3 to 10 | ORG, ATT (web heartbeat engine), TS, TASK, DOC with vault, NOTIF, REP basics, onboarding | All Must items of P1 pass; HR matrix items 1, 2, 3, 5, 6, 7 demonstrable; pilot with 5 users |
| P2 Virtual office and meetings | Weeks 11 to 17 | Office map and avatars, presence, proximity audio/video, rooms, meetings, chat, map editor, SSO, leave | 200 concurrent avatars load test; HR matrix item 4 passes; attendance integrates with presence |
| P3 Hardening and extras | Weeks 18 to 22 | Desktop agent, offline sync, e-signature, calendar sync, recording, guests, advanced reports, penetration test fixes | Pen-test clean of High/Critical; DR drill passed |
| Launch | Weeks 23 to 24 | UAT, data migration, training, go-live, hypercare | Signed acceptance; support runbook in place |


**The duration is an estimate for one product owner, one AI agent working daily and one part-time reviewer. It assumes decisions are made promptly. Timelines can compress if the scope of P2 and P3 is reduced; the HR core in P1 should not be reduced.**


## 13.5 Suggested Slice Order Inside Phase 1


| Order | Slice | Requirement IDs |
| --- | --- | --- |
| 1 | Auth, invitations, 2FA, RBAC, RLS, audit log | FR-AUTH-001 to 004, 006 to 008, 010, 011; FR-AUD-001 |
| 2 | Org, users, teams, projects, schedules, subcontractor profiles, contracts | FR-ORG-001 to 006 |
| 3 | Attendance engine: heartbeat, state machine, sessions, reconciler, live board | FR-ATT-001 to 009, 013 to 016, 019, 020 |
| 4 | Tasks: CRUD, daily plan, weekly planner, Kanban | FR-TASK-001 to 008, 011 |
| 5 | Time entries, timers, timesheets, approvals, rates | FR-TS-001 to 006, 009, 011 to 013 |
| 6 | Documents: upload, folders, versions, ACL, access log, virus scan | FR-DOC-001 to 004, 009, 012, 013, 015 |
| 7 | Vault: re-auth, per-document password, envelope encryption, share links | FR-DOC-005 to 008, 010 |
| 8 | Notifications, dashboards, reports, onboarding, offboarding | FR-NOTIF-001, 002; FR-REP-001 to 004, 006, 008; FR-ORG-008, 009 |



## 13.6 Prompt Templates for the AI Agent


### Starting a slice


| Read docs/05-attendance.md and docs/06-attendance-design.md. Implement FR-ATT-001 to FR-ATT-005. First write the failing tests for every state transition in the state machine table, then implement the service, the WebSocket gateway handler, the Prisma migration with RLS policy, and the REST endpoints. Do not add new dependencies without asking. When done, run all tests, start the app, and show me a demo script I can follow. |
| --- |



### Security review


| Act as a security reviewer. Examine the changes in this branch against OWASP ASVS Level 2 and Section 10 of the SRS. List every issue with severity and a proposed fix. Check specifically: missing org_id filters, missing permission guards, unvalidated input, secrets in code, logging of sensitive data, and replay or forgery of heartbeats. |
| --- |



### Acceptance walk-through


| Generate a manual acceptance checklist for the requirement IDs in this pull request, with exact steps, test accounts and expected results, written for a non-technical product owner. |
| --- |



# 14. Testing and Acceptance


## 14.1 Test Strategy


| Level | Tools | Scope |
| --- | --- | --- |
| Unit | Vitest/Jest | Business rules, state machine, rate and overtime calculations, crypto helpers |
| Integration | Jest + Testcontainers (Postgres, Redis) | API with real database, RLS, queues |
| End-to-end | Playwright | Login, clock-in, tasks, timesheet approval, document vault flows, meetings with fake media devices |
| Load | k6, Artillery (WebSocket) | 500 concurrent users, 200 avatars in one office, heartbeat ingestion rate |
| Security | OWASP ZAP, npm audit, Semgrep, external pen test | Web vulnerabilities, dependency risk, auth and crypto review |
| Chaos / accuracy | Custom Playwright + network emulation | Disconnects, sleep, tab kill, dual devices, clock skew (Section 6.5) |
| Accessibility | axe-core, manual screen-reader checks | WCAG 2.1 AA |
| UAT | Client users | Real scenarios with pilot group |



## 14.2 Key Acceptance Criteria


| Ref | Scenario | Expected result |
| --- | --- | --- |
| AC-01 | User logs in at 09:00:00 and moves the mouse | Session created automatically; clock-in between 09:00:00 and 09:00:05 server time; no button pressed |
| AC-02 | User closes the browser tab at 17:30:00 | Session closed within 30 s of last heartbeat after grace; clock-out equals last heartbeat time |
| AC-03 | Internet cut for 60 s then restored | Session remains open; gap logged; no new session |
| AC-04 | Internet cut for 10 min | Session closed at last heartbeat; correction suggestion appears when back online |
| AC-05 | No input for 6 minutes | State becomes IDLE; after 16 minutes PAUSED; idle time not counted as payable |
| AC-06 | User in a 30-minute meeting without touching mouse | 30 minutes counted as active meeting time |
| AC-07 | Same user on laptop and phone simultaneously | One merged session; no double-counted time; flag raised |
| AC-08 | Session open across midnight | Two records split at midnight organisation time; day totals correct |
| AC-09 | Subcontractor submits weekly timesheet with 42 attendance hours and 30 logged hours | Variance alert shown to user and manager; manager can approve with comment or reject |
| AC-10 | Approved timesheet is edited by the subcontractor | Edit blocked; only a user with reopen permission can reopen, with audit entry |
| AC-11 | Subcontractor opens another subcontractor's contract by URL | Access denied and logged; no data leaked |
| AC-12 | Confidential contract download after 15 minutes since last login check | Re-authentication required; wrong document password logged as PASSWORD_FAIL; right password streams the file |
| AC-13 | Direct inspection of the storage bucket and database dump | Document content and confidential file names unreadable without KMS access |
| AC-14 | Daily plan created Monday with 5 tasks, 2 unfinished | Unfinished tasks carried to Tuesday and shown in weekly planner |
| AC-15 | Two users walk into the same meeting room | Audio/video connects within 3 s; both receive meeting time credit in attendance |
| AC-16 | Contract expiring in 30 days | Reminder email and in-app alert sent to HR and manager |



# 15. Risks and Mitigations


| Risk | Impact | Likelihood | Mitigation |
| --- | --- | --- | --- |
| Browser cannot see work done in other applications, so active time is understated | High | High | Offer desktop agent (P3), allow limited manual time with approval, policy choice per organisation; communicate clearly to subcontractors |
| AI-generated code contains security flaws | High | Medium | Security-review prompts, independent reviewer, SAST/DAST in CI, pen test before launch |
| Real-time performance degrades with many avatars | Medium | Medium | Interest management, update batching, load tests early in P2 |
| Video cost grows faster than expected | Medium | Medium | Audio-first defaults, simulcast, limits on recording, self-host LiveKit at scale |
| Legal challenge over monitoring | High | Low to Medium | Transparent notice, minimal data, legal review, consent records, no invasive capture |
| Scope creep from cloning every Spot feature | High | High | Strict phase gates; HR core first; map editor and extras only after P1 acceptance |
| Loss of document password | Medium | Medium | KMS-based recovery by authorised role with audit and owner notification |
| Key personnel or agent-tool dependency | Medium | Low | All decisions in ADRs; standard stack; repository and docs owned by client |
| Users feel surveilled, adoption drops | Medium | Medium | Transparency dashboard, no screenshots, focus on outcomes and hours accuracy, communicate benefits |
| Clock drift or infrastructure outage affects accuracy | High | Low | NTP monitoring, multi-AZ, grace windows, reconciliation replay |



# 16. Open Decisions for the Product Owner

**Please confirm or change the following before development starts. Defaults are shown in brackets.**


| # | Decision | Default if no answer |
| --- | --- | --- |
| 1 | Product name and branding | HR Virtual Office (working name) |
| 2 | Number of users at launch and in 12 months | 50 at launch, 500 at 12 months |
| 3 | Must hourly subcontractors install the desktop agent? | Browser-only in P1; agent recommended from P3 |
| 4 | Countries where users are located (for privacy law) | Sri Lanka plus unspecified remote locations |
| 5 | Payment currencies required | USD and LKR |
| 6 | Cloud provider and region | AWS Singapore (ap-southeast-1) |
| 7 | Video: LiveKit Cloud first or self-host from start? | LiveKit Cloud first |
| 8 | Is recording of meetings required? | Optional, off by default |
| 9 | Is legally binding e-signature required or is a simple signature enough? | Simple in-app signature with audit trail |
| 10 | Working week and public holiday calendar | Monday to Friday, Sri Lanka holidays |
| 11 | Languages at launch | English |
| 12 | Approval chain for timesheets | Direct manager only |



# Appendix A. Use Cases


### UC-01 Automatic clock-in and clock-out


| Item | Description |
| --- | --- |
| Actor | Subcontractor or employee |
| Precondition | Account active; monitoring notice accepted |
| Main flow | 1. User opens the site and signs in. 2. Office loads and the client starts heartbeats. 3. User interacts; first ACTIVE heartbeat arrives. 4. System creates the attendance session and shows 'Active since 09:02'. 5. User works, goes idle or takes meetings; states update automatically. 6. User logs out or closes the tab. 7. After the grace window the system closes the session at the last heartbeat. |
| Alternate flows | Network loss within grace: session continues. Network loss beyond grace: session closes, correction suggested. Second device: merged and flagged. |
| Postcondition | attendance_sessions row with accurate in/out; daily totals updated; draft timesheet updated |



### UC-02 Subcontractor weekly timesheet


| Item | Description |
| --- | --- |
| Actor | Subcontractor, Team Lead |
| Main flow | 1. During the week the user logs time with task timers. 2. On Friday the user opens the timesheet; the system shows attendance totals, task time and variance. 3. User adds notes and submits. 4. Team Lead reviews, comments and approves. 5. Timesheet locks; payable amount is calculated from rate and overtime rules. 6. Finance exports an invoice-ready file. |
| Alternate flows | Variance above threshold: warning to both. Rejection: returns to user with comment. |



### UC-03 Upload and open a password-protected contract


| Item | Description |
| --- | --- |
| Actor | HR Manager, Subcontractor |
| Main flow | 1. HR uploads the signed contract, sets category Contract and confidentiality Confidential, sets a document password and links it to the subcontractor. 2. System encrypts, scans and stores. 3. Subcontractor opens Documents, selects the contract. 4. System asks for re-authentication and the document password. 5. File opens in view-only mode with watermark; access is logged. |
| Alternate flows | Wrong password three times: temporary block and notification to HR. Infected file: quarantined. |



### UC-04 Join a meeting by walking into a room


| Item | Description |
| --- | --- |
| Actor | Any user |
| Main flow | 1. User moves avatar into Meeting Room 2. 2. System checks access mode and capacity. 3. Client receives a room token and connects to the media server. 4. User hears and sees participants. 5. User leaves the room; meeting time is credited to attendance. |
| Alternate flows | Room locked: knock request sent to occupants. Room full: user queued or offered another room. |



### UC-05 Daily plan and end-of-day report


| Item | Description |
| --- | --- |
| Actor | Subcontractor or employee |
| Main flow | 1. On first clock-in the system prompts the daily plan. 2. User picks tasks from Today and carry-overs and sets goals. 3. During the day the user works with timers. 4. At the end of the day the user submits a short report. 5. Unfinished tasks roll to the next day; the manager sees the summary. |



# Appendix B. Requirement Count Summary


| Module | Requirements | Must in P1 |
| --- | --- | --- |
| AUTH | 12 | Most |
| ORG | 12 | Most |
| VO | 14 | None (P2) |
| MEET | 14 | None (P2) |
| ATT | 23 | Core set: 001 to 005, 007 to 009, 013 to 016, 019, 020 |
| TS | 13 | Most |
| TASK | 16 | Core set |
| DOC | 20 | Core set including vault |
| NOTIF / REP / ADM / AUD | 6 / 8 / 8 / 5 | Basics |



# Appendix C. Approval

**By signing below, the parties approve this SRS as the baseline for design and development. Changes after approval follow change control.**


| Role | Name | Signature | Date |
| --- | --- | --- | --- |
| Product Owner |  |  |  |
| Technical Reviewer |  |  |  |
| HR Representative |  |  |  |
| Legal Adviser |  |  |  |

