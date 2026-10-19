-- FR-ORG-005 (ADR 032): separate early-leave grace, a daily break allowance, and the stored
-- excess break. grace_minutes stays the late-arrival grace; a null early-leave grace means
-- "same as grace_minutes", so existing schedules behave exactly as before.
ALTER TABLE "work_schedules" ADD COLUMN "early_leave_grace_minutes" INTEGER,
ADD COLUMN "break_allowance_minutes" INTEGER;

ALTER TABLE "attendance_daily" ADD COLUMN "excess_break_minutes" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE work_schedules
  ADD CONSTRAINT work_schedules_grace_range CHECK (grace_minutes BETWEEN 0 AND 240),
  ADD CONSTRAINT work_schedules_early_grace_range CHECK (early_leave_grace_minutes IS NULL OR early_leave_grace_minutes BETWEEN 0 AND 240),
  ADD CONSTRAINT work_schedules_break_range CHECK (break_allowance_minutes IS NULL OR break_allowance_minutes BETWEEN 0 AND 600),
  ADD CONSTRAINT work_schedules_one_scope CHECK (user_id IS NULL OR team_id IS NULL),
  ADD CONSTRAINT work_schedules_dates CHECK (effective_to IS NULL OR effective_to >= effective_from);
ALTER TABLE attendance_daily ADD CONSTRAINT attendance_daily_excess_break_nonneg CHECK (excess_break_minutes >= 0);
