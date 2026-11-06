-- ADR 049 §1 (FR-WT-001..006): server-verified calls.
-- Which device reports the call and when it last confirmed it (a second device does not end it).
ALTER TABLE "attendance_sessions" ADD COLUMN "call_device_id" VARCHAR(100);
ALTER TABLE "attendance_sessions" ADD COLUMN "call_confirmed_at" TIMESTAMPTZ;
-- The kind of call a heartbeat meeting segment was verified for, and its meeting (meeting_id keeps
-- its ADR 001 meaning: a segment only the meetings hook closes).
ALTER TABLE "attendance_segments" ADD COLUMN "call_kind" VARCHAR(20);
ALTER TABLE "attendance_segments" ADD COLUMN "call_meeting_id" UUID;
ALTER TABLE "attendance_segments" ADD CONSTRAINT "attendance_segments_call_kind_check"
  CHECK ("call_kind" IS NULL OR "call_kind" IN ('ROOM', 'PROXIMITY', 'MEETING'));
-- Meeting interval lists read IN_MEETING segments by session and time.
CREATE INDEX "attendance_segments_meeting_idx" ON "attendance_segments" ("org_id", "session_id") WHERE "state" = 'IN_MEETING';

-- FR-WT-006: meeting time on timesheet days and periods (part of attendance, never added to it).
ALTER TABLE "timesheet_days" ADD COLUMN "meeting_minutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "timesheets" ADD COLUMN "meeting_minutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "timesheet_days" ADD CONSTRAINT "timesheet_days_meeting_minutes_check" CHECK ("meeting_minutes" >= 0);

-- Backfill from the sessions (display only: no amount, status or entry changes). Runs as the
-- migration owner with row security off, like the ADR 008 merge, so no organisation is skipped.
SET row_security = off;
UPDATE "timesheet_days" d SET "meeting_minutes" = a.minutes
FROM (
  SELECT org_id, user_id, work_date, (SUM(meeting_seconds) / 60)::int AS minutes
  FROM attendance_sessions WHERE status NOT IN ('CANCELLED', 'ADJUSTED')
  GROUP BY org_id, user_id, work_date
) a
WHERE d.org_id = a.org_id AND d.user_id = a.user_id AND d.work_date = a.work_date::date AND a.minutes > 0;
UPDATE "timesheets" t SET "meeting_minutes" = s.minutes
FROM (SELECT timesheet_id, SUM(meeting_minutes)::int AS minutes FROM timesheet_days GROUP BY timesheet_id) s
WHERE t.id = s.timesheet_id AND s.minutes > 0;
RESET row_security;
