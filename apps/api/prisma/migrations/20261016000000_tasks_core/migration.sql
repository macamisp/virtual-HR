-- Tasks core: projects, project members, tasks, checklist, comments, attachment references,
-- append-only activity log. Ref: SRS 5.7 FR-TASK-001, 002, 006, 007; 7.4 projects/tasks.

-- ============ Part 1: tables (generated) ============
-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "task_acceptance_escalation_hours" INTEGER NOT NULL DEFAULT 24;

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "client_name" VARCHAR(200),
    "manager_id" UUID,
    "billable" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "start_date" DATE,
    "end_date" DATE,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "added_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("project_id","user_id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "project_id" UUID,
    "parent_task_id" UUID,
    "title" VARCHAR(300) NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" VARCHAR(20) NOT NULL DEFAULT 'TODO',
    "priority" VARCHAR(10) NOT NULL DEFAULT 'MEDIUM',
    "assignee_id" UUID,
    "reporter_id" UUID NOT NULL,
    "acceptance_status" VARCHAR(20) NOT NULL DEFAULT 'NOT_REQUIRED',
    "acceptance_requested_at" TIMESTAMPTZ,
    "accepted_at" TIMESTAMPTZ,
    "declined_at" TIMESTAMPTZ,
    "decline_reason" TEXT,
    "escalated_at" TIMESTAMPTZ,
    "due_date" DATE,
    "planned_date" DATE,
    "estimate_minutes" INTEGER,
    "actual_minutes" INTEGER,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recurrence_rule" TEXT,
    "completed_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_checklist_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "text" VARCHAR(300) NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "done_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "mentioned_user_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "task_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "url" TEXT NOT NULL,
    "mime_type" VARCHAR(100),
    "size_bytes" BIGINT,
    "added_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "task_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_activity" (
    "id" BIGSERIAL NOT NULL,
    "org_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "projects_org_id_code_key" ON "projects"("org_id", "code");

-- CreateIndex
CREATE INDEX "project_members_org_id_user_id_idx" ON "project_members"("org_id", "user_id");

-- CreateIndex
CREATE INDEX "tasks_org_id_assignee_id_status_idx" ON "tasks"("org_id", "assignee_id", "status");

-- CreateIndex
CREATE INDEX "tasks_org_id_reporter_id_idx" ON "tasks"("org_id", "reporter_id");

-- CreateIndex
CREATE INDEX "tasks_org_id_project_id_idx" ON "tasks"("org_id", "project_id");

-- CreateIndex
CREATE INDEX "tasks_org_id_due_date_idx" ON "tasks"("org_id", "due_date");

-- CreateIndex
CREATE INDEX "tasks_org_id_planned_date_idx" ON "tasks"("org_id", "planned_date");

-- CreateIndex
CREATE INDEX "tasks_parent_task_id_idx" ON "tasks"("parent_task_id");

-- CreateIndex
CREATE INDEX "task_checklist_items_task_id_idx" ON "task_checklist_items"("task_id");

-- CreateIndex
CREATE INDEX "task_comments_task_id_created_at_idx" ON "task_comments"("task_id", "created_at");

-- CreateIndex
CREATE INDEX "task_attachments_task_id_idx" ON "task_attachments"("task_id");

-- CreateIndex
CREATE INDEX "task_activity_task_id_created_at_idx" ON "task_activity"("task_id", "created_at");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_fkey" FOREIGN KEY ("parent_task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============ Part 2: integrity + security (hand-written) ============

ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'DONE'));
ALTER TABLE tasks ADD CONSTRAINT tasks_priority_check
  CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT'));
ALTER TABLE tasks ADD CONSTRAINT tasks_acceptance_check
  CHECK (acceptance_status IN ('NOT_REQUIRED', 'PENDING', 'ACCEPTED', 'DECLINED'));
ALTER TABLE tasks ADD CONSTRAINT tasks_not_own_parent CHECK (parent_task_id IS NULL OR parent_task_id <> id);
ALTER TABLE tasks ADD CONSTRAINT tasks_estimate_nonneg CHECK (estimate_minutes IS NULL OR estimate_minutes >= 0);
ALTER TABLE projects ADD CONSTRAINT projects_status_check
  CHECK (status IN ('ACTIVE', 'ON_HOLD', 'DONE', 'ARCHIVED'));
ALTER TABLE projects ADD CONSTRAINT projects_dates_check
  CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date);
ALTER TABLE organizations ADD CONSTRAINT organizations_escalation_hours_check
  CHECK (task_acceptance_escalation_hours BETWEEN 1 AND 720);

-- Enable + FORCE RLS with the strict tenant policy on every new table.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'projects', 'project_members', 'tasks', 'task_checklist_items',
    'task_comments', 'task_attachments', 'task_activity'
  ] LOOP
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

GRANT SELECT, INSERT, UPDATE, DELETE ON projects, project_members, tasks, task_checklist_items,
  task_comments, task_attachments TO hrvo_app;
-- Tasks, comments and attachments are soft-deleted; activity is append-only.
REVOKE DELETE, TRUNCATE ON tasks, task_comments, task_attachments FROM hrvo_app;
REVOKE UPDATE, DELETE, TRUNCATE ON task_activity FROM hrvo_app;
GRANT SELECT, INSERT ON task_activity TO hrvo_app;
GRANT USAGE, SELECT ON SEQUENCE task_activity_id_seq TO hrvo_app;
