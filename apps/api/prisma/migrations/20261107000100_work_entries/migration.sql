-- ADR 049 §3, §4 (FR-WT-013..018): named work, work type and category on time entries, and the
-- task and project names as they were when the time was recorded (a rename keeps history).
ALTER TABLE "time_entries" ADD COLUMN "title" VARCHAR(200);
ALTER TABLE "time_entries" ADD COLUMN "work_type" VARCHAR(10);
ALTER TABLE "time_entries" ADD COLUMN "category" VARCHAR(20);
ALTER TABLE "time_entries" ADD COLUMN "task_title" VARCHAR(300);
ALTER TABLE "time_entries" ADD COLUMN "project_name" VARCHAR(200);

ALTER TABLE "time_entries"
  ADD CONSTRAINT "time_entries_work_type_check" CHECK ("work_type" IS NULL OR "work_type" IN ('OFFICE', 'REMOTE', 'ONSITE')),
  ADD CONSTRAINT "time_entries_category_check" CHECK ("category" IS NULL OR "category" IN
    ('DEVELOPMENT', 'DESIGN', 'TESTING', 'REVIEW', 'DOCUMENTATION', 'SUPPORT', 'RESEARCH', 'ADMIN', 'MEETING', 'TRAVEL', 'OTHER')),
  ADD CONSTRAINT "time_entries_title_check" CHECK ("title" IS NULL OR length(btrim("title")) >= 2);

-- Snapshots for existing rows: the names as they are now (the best record available). The lock
-- guard trigger refuses writes to entries of submitted/approved timesheets, so it is bypassed for
-- this one backfill only (the migration owner, inside the migration transaction).
ALTER TABLE "time_entries" DISABLE TRIGGER USER;
SET row_security = off;
UPDATE "time_entries" e SET "task_title" = t.title FROM tasks t WHERE t.id = e.task_id AND e.task_title IS NULL;
UPDATE "time_entries" e SET "project_name" = p.name FROM projects p WHERE p.id = e.project_id AND e.project_name IS NULL;
RESET row_security;
ALTER TABLE "time_entries" ENABLE TRIGGER USER;
-- Overlap checks for declared times use the existing (org_id, user_id, work_date) index.
