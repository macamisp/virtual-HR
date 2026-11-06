-- ADR 049 §2 (FR-WT-007..012) overtime requests and §7 (FR-WT-023..024) onsite work requests.
-- Hand-written: tables, constraints, row-level security and grants in one step.

-- §2: approval affects pay only when the organisation turns it on (off = ADR 008 exactly).
ALTER TABLE "organizations" ADD COLUMN "overtime_requires_approval" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "overtime_requests" (
  "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"            UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id"           UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "work_date"         DATE NOT NULL,
  "planned_start"     TIME,
  "planned_end"       TIME,
  "requested_minutes" INTEGER NOT NULL,
  "project_id"        UUID REFERENCES "projects"("id") ON DELETE SET NULL,
  "task_id"           UUID REFERENCES "tasks"("id") ON DELETE SET NULL,
  "work_description"  TEXT NOT NULL,
  "reason"            TEXT NOT NULL,
  "notes"             TEXT NOT NULL DEFAULT '',
  "status"            VARCHAR(10) NOT NULL DEFAULT 'PENDING',
  "approved_minutes"  INTEGER,
  "decided_by"        UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at"        TIMESTAMPTZ,
  "decision_comment"  TEXT,
  "cancelled_by"      UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "cancelled_at"      TIMESTAMPTZ,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "overtime_requests_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT "overtime_requests_minutes_check" CHECK ("requested_minutes" BETWEEN 15 AND 720),
  CONSTRAINT "overtime_requests_approved_check" CHECK ("approved_minutes" IS NULL OR ("approved_minutes" BETWEEN 1 AND "requested_minutes")),
  CONSTRAINT "overtime_requests_approved_status_check" CHECK (("status" = 'APPROVED') = ("approved_minutes" IS NOT NULL) OR "status" = 'CANCELLED'),
  CONSTRAINT "overtime_requests_times_check" CHECK (("planned_start" IS NULL) = ("planned_end" IS NULL) AND ("planned_end" IS NULL OR "planned_end" > "planned_start")),
  CONSTRAINT "overtime_requests_text_check" CHECK (length(btrim("work_description")) >= 3 AND length(btrim("reason")) >= 3),
  CONSTRAINT "overtime_requests_decided_check" CHECK ("status" NOT IN ('APPROVED', 'REJECTED') OR "decided_at" IS NOT NULL)
);
-- FR-WT-010: one pending or approved claim per person and day, whatever the caller.
CREATE UNIQUE INDEX "overtime_requests_one_per_day" ON "overtime_requests" ("org_id", "user_id", "work_date") WHERE "status" IN ('PENDING', 'APPROVED');
CREATE INDEX "overtime_requests_status_idx" ON "overtime_requests" ("org_id", "status", "work_date");

CREATE TABLE "onsite_work_requests" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"           UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id"          UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "work_date"        DATE NOT NULL,
  "started_at"       TIMESTAMPTZ NOT NULL,
  "ended_at"         TIMESTAMPTZ NOT NULL,
  "minutes"          INTEGER NOT NULL,
  "location"         VARCHAR(200) NOT NULL,
  "project_id"       UUID REFERENCES "projects"("id") ON DELETE SET NULL,
  "task_id"          UUID REFERENCES "tasks"("id") ON DELETE SET NULL,
  "description"      TEXT NOT NULL,
  "reason"           TEXT NOT NULL,
  "status"           VARCHAR(10) NOT NULL DEFAULT 'PENDING',
  "decided_by"       UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at"       TIMESTAMPTZ,
  "decision_comment" TEXT,
  "time_entry_id"    UUID REFERENCES "time_entries"("id") ON DELETE SET NULL,
  "cancelled_at"     TIMESTAMPTZ,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "onsite_work_requests_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT "onsite_work_requests_range_check" CHECK ("ended_at" > "started_at" AND "minutes" BETWEEN 1 AND 960),
  CONSTRAINT "onsite_work_requests_text_check" CHECK (length(btrim("location")) >= 3 AND length(btrim("description")) >= 3 AND length(btrim("reason")) >= 3),
  CONSTRAINT "onsite_work_requests_decided_check" CHECK ("status" NOT IN ('APPROVED', 'REJECTED') OR "decided_at" IS NOT NULL)
);
CREATE INDEX "onsite_work_requests_user_day_idx" ON "onsite_work_requests" ("org_id", "user_id", "work_date");
CREATE INDEX "onsite_work_requests_status_idx" ON "onsite_work_requests" ("org_id", "status", "work_date");

-- §7: approved onsite work becomes an ONSITE time entry (a work log, never attendance).
ALTER TABLE "time_entries" DROP CONSTRAINT "time_entries_source_check";
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_source_check" CHECK ("source" IN ('TIMER', 'MANUAL', 'AUTO_FROM_ATTENDANCE', 'ONSITE'));
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_onsite_times_check" CHECK ("source" <> 'ONSITE' OR ("started_at" IS NOT NULL AND "ended_at" IS NOT NULL));
ALTER TABLE "timesheet_days" ADD COLUMN "onsite_minutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "timesheet_days" ADD CONSTRAINT "timesheet_days_onsite_minutes_check" CHECK ("onsite_minutes" >= 0);

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['overtime_requests', 'onsite_work_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL
         USING (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)
         WITH CHECK (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
      t || '_org_policy', t);
  END LOOP;
END
$$;
-- Requests are cancelled or decided, never deleted (approval history, FR-WT-009).
GRANT SELECT, INSERT, UPDATE ON overtime_requests, onsite_work_requests TO hrvo_app;
REVOKE DELETE, TRUNCATE ON overtime_requests, onsite_work_requests FROM hrvo_app;
