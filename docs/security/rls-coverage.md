# Row-Level Security coverage

Generated 2026-10-19 from `pg_class` / `pg_policy` on a database at the current migration head. Every tenant table must have RLS **enabled and forced** with an organisation policy; the application role `hrvo_app` has NOBYPASSRLS. `organizations` is keyed by `id` instead of `org_id`. `_prisma_migrations` holds no tenant data.

| Table | RLS enabled | RLS forced | Policies | org_id column | hrvo_app privileges |
| --- | --- | --- | --- | --- | --- |
| `_prisma_migrations` | **no** | **no** | 0 | no | DELETE, INSERT, SELECT, UPDATE |
| `agent_devices` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `agent_pairing_codes` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `attendance_corrections` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `attendance_daily` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `attendance_flags` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `attendance_segments` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `attendance_sessions` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `audit_logs` | yes | yes | 1 | yes | INSERT, SELECT |
| `auth_sessions` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `calendar_busy` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `calendar_connections` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `calendar_event_links` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `calendar_oauth_states` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `channel_members` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `channels` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `contracts` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `daily_plan_items` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `daily_plans` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `desks` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `device_sequences` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `document_access_logs` | yes | yes | 1 | yes | INSERT, SELECT |
| `document_acl` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `document_folders` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `document_password_attempts` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `document_retention_rules` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `document_share_links` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `document_versions` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `documents` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `draft_timesheets_legacy` | yes | yes | 1 | yes | — |
| `heartbeat_nonces` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `invitations` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `job_runs` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `leave_requests` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `meeting_action_items` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `meeting_attendees` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `meeting_calls` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `meeting_lobby` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `meeting_participants` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `meeting_recordings` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `meetings` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `messages` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `monitoring_consents` | yes | yes | 1 | yes | INSERT, SELECT |
| `notification_preferences` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `notifications` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `offices` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `offline_sync_batches` | yes | yes | 1 | yes | INSERT, SELECT |
| `org_roles` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `organizations` | yes | yes | 1 | no | DELETE, INSERT, SELECT, UPDATE |
| `password_reset_tokens` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `presence_events` | yes | yes | 1 | yes | INSERT, SELECT |
| `privacy_requests` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `project_members` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `projects` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `public_holidays` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `recording_consents` | yes | yes | 1 | yes | INSERT, SELECT |
| `required_document_categories` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `room_invites` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `rooms` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `session_secrets` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `signature_requests` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `signature_signers` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `subcontractor_profiles` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `task_activity` | yes | yes | 1 | yes | INSERT, SELECT |
| `task_attachments` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `task_checklist_items` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `task_comments` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `task_saved_views` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `tasks` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `teams` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `time_entries` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `timesheet_approvals` | yes | yes | 1 | yes | INSERT, SELECT |
| `timesheet_days` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `timesheets` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `users` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `vault_reauth` | yes | yes | 1 | yes | INSERT, SELECT, UPDATE |
| `weekly_plans` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
| `work_schedules` | yes | yes | 1 | yes | DELETE, INSERT, SELECT, UPDATE |
