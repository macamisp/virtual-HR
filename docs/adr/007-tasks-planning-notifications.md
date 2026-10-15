# ADR 007: Tasks, Planning and Task Notifications

**Status:** Accepted (slice 1 of 3: tasks core)
**Date:** 15 October 2026
**Requirements:** SRS 5.7 FR-TASK-001..008, 011, 016; 7.4 projects, tasks, daily_plans, daily_plan_items, weekly_plans; FR-NOTIF-001.

## 1. Decisions agreed with the product owner (15 Oct 2026)

| Topic | Decision |
| --- | --- |
| Scheduled jobs | BullMQ on Redis (`bullmq` 6.3.10, `@nestjs/bullmq` 12.0.0). Also schedules the attendance reconciler, daily close and retention, which never ran outside tests before. |
| Rich text | Markdown stored as text; rendered in the browser with `marked` 18.0.14 and sanitised with `dompurify` 3.4.16 (tag/attribute allow-list, links get `rel="noopener noreferrer nofollow"`). |
| Drag and drop | Native HTML5 DnD plus keyboard controls (a "Move to" select on every card) and live-region announcements. No library. |
| Acceptance (FR-TASK-007) | Only subcontractors accept, and only tasks assigned by someone else. Escalation after `organizations.task_acceptance_escalation_hours` (default 24, 1–720) to the reporter and the reporter's manager (HR if none). |
| Projects | Minimal admin: `projects` + `project_members` with RLS; HR/admins/managers create projects; the project manager or a project admin manages members. |
| Visibility | Assignee and reporter; members and manager of the task's project (employees and subcontractors alike); team leads/managers for tasks assigned to their team or direct reports; HR/admins everything. Auditors have no task access. |
| weekly_plans | `user_id`, `week_start` (Monday), `goals` (checkable items), `capacity_minutes` (work schedule, else 40 h), `submitted_at`. |
| Notification centre | In-app bell with unread count, list and mark-as-read (FR-NOTIF-001), real-time over the existing socket, plus email for key events. Preferences (FR-NOTIF-004) stay P2. |

Packages were exact-pinned to the newest release at least two weeks old (supply-chain precaution).

## 2. Slice 1: tasks core

- **Schema** (`20261016000000_tasks_core`): `projects`, `project_members`, `tasks` (all SRS 7.4 columns plus acceptance state, `version` for optimistic concurrency, soft delete), `task_checklist_items`, `task_comments` (with `mentioned_user_ids`), `task_attachments`, `task_activity`. RLS forced on all; CHECK constraints for statuses, priorities and acceptance; `task_activity` is append-only (`hrvo_app` has no UPDATE/DELETE); tasks, comments and attachments are soft-deleted only.
- **Permissions:** new `tasks.use` (every role except Auditor), `tasks.assign`, `tasks.read.team`, `tasks.read.all`, `projects.manage`. Every task/project route requires `tasks.use`; finer authority is in `task-policy.ts`.
- **Policy** (`apps/api/src/tasks/task-policy.ts`, unit-tested first): `canSeeTask`, `taskPermissions` (edit / change status / assign / respond / delete / comment), `canAssignTo`, `requiresAcceptance`. The SQL list filter (`tasks.sql.ts` `visibleTo`) implements the same visibility rule for any viewer, so it also answers "who may be @mentioned".
- **Invisible = not found:** a task the caller cannot see returns 404, exactly like a missing one.
- **Workflow (FR-TASK-002):** default transitions in `packages/shared` (`TASK_TRANSITIONS`); DONE stamps `completed_at`, reopening clears it. A subcontractor cannot move a task until accepted.
- **Concurrency:** every PATCH carries `version`; a stale version gets 409 and the UI reloads. Mutations lock the row (`FOR UPDATE`).
- **Activity (FR-TASK-006):** every change writes `task_activity` in the same transaction, with previous and new values (the description records only that it changed).
- **Comments and mentions:** mentions are written as `@[Name](user:<id>)` by an accessible combobox composer. The API rejects mentions of people who cannot see the task.
- **Attachments:** https references only (name, URL, optional type/size) until the Documents module stores files.
- **Subtasks:** one level; they inherit the parent's project.
- **Estimate vs actual (FR-TASK-008):** `ActualTimeProvider` returns no data until `time_entries` exists (Timesheets slice); the overrun rule (`actual > estimate`) is in place and the UI says "no time logged yet".
- **Events:** `TaskEvents` emits `task.assigned/accepted/declined/mentioned/status` after commit; slice 3 subscribes for notifications.
- **Audit:** project creation/updates and membership changes go to the hash-chained audit log (membership changes alter who sees tasks). The audit writer moved to `common/audit-chain.ts` and is shared with auth.
- **Web:** My Tasks list (scopes mine / created by me / team / all, filters), Kanban board, task detail (acceptance panel, status, details, Markdown description, checklist, subtasks, attachments, comments with @mentions, activity), new task / subtask form, Projects page.

## 3. Tests (slice 1)

- `tasks-policy.test.ts`: visibility, permissions, assignment scope, acceptance rule, workflow.
- `tasks-e2e.test.ts`: projects (codes, membership audit, visibility), all FR-TASK-001 fields, the visibility matrix (assignee, reporter, lead, project members, other team, HR, other org), list scopes and filters, RLS without tenant context, append-only activity, per-route permissions (Auditor 403), assignment scope, acceptance/decline, workflow and activity log, optimistic concurrency, mentions, checklist, attachment URL validation, subtasks, deletion, input validation.
- Playwright `06-tasks.spec.ts`: create with sanitised Markdown (a `<script>` does not execute), subcontractor acceptance, @mention autocomplete, board move by keyboard and by drag.
