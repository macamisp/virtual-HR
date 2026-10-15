-- In-app notifications (FR-NOTIF-001) for task events and reminders (FR-TASK-011, 016),
-- job run markers, and an org listing for scheduled jobs.

-- ============ Part 1: tables (generated) ============
-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "link" VARCHAR(500),
    "entity_type" VARCHAR(40),
    "entity_id" UUID,
    "dedupe_key" VARCHAR(200),
    "send_email" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMPTZ,
    "emailed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "org_id" UUID NOT NULL,
    "job" VARCHAR(60) NOT NULL,
    "run_key" VARCHAR(60) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("org_id","job","run_key")
);

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_key" ON "notifications"("user_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============ Part 2: security (hand-written) ============

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications', 'job_runs'] LOOP
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

GRANT SELECT, INSERT, UPDATE ON notifications TO hrvo_app;
GRANT SELECT, INSERT ON job_runs TO hrvo_app;
REVOKE DELETE, TRUNCATE ON notifications, job_runs FROM hrvo_app;

-- Scheduled jobs iterate over tenants before any tenant context exists. This exposes only
-- ids and scheduling settings, never tenant data; all further work runs under SET LOCAL app.org_id.
CREATE FUNCTION fn_list_orgs_for_jobs()
RETURNS TABLE (id UUID, timezone VARCHAR, task_acceptance_escalation_hours INT)
SECURITY DEFINER
SET search_path = public
LANGUAGE sql STABLE AS $$
  SELECT o.id, o.timezone, o.task_acceptance_escalation_hours FROM organizations o ORDER BY o.id;
$$;
REVOKE ALL ON FUNCTION fn_list_orgs_for_jobs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_list_orgs_for_jobs() TO hrvo_app;
