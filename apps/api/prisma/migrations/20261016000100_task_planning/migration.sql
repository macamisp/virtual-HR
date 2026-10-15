-- Task planning: daily plans + items (Today, EOD report), weekly plans (goals, capacity),
-- saved task views. Ref: SRS 5.7 FR-TASK-003, 004, 005; 7.4.

-- ============ Part 1: tables (generated) ============
-- CreateTable
CREATE TABLE "daily_plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "plan_date" DATE NOT NULL,
    "goals" TEXT NOT NULL DEFAULT '',
    "confirmed_at" TIMESTAMPTZ,
    "eod_summary" TEXT,
    "blockers" TEXT,
    "tomorrow_plan" TEXT,
    "submitted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_plan_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PLANNED',
    "carried_to_date" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_plan_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "goals" JSONB NOT NULL DEFAULT '[]',
    "capacity_minutes" INTEGER,
    "submitted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_saved_views" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "filters" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_plans_org_id_plan_date_idx" ON "daily_plans"("org_id", "plan_date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_plans_user_id_plan_date_key" ON "daily_plans"("user_id", "plan_date");

-- CreateIndex
CREATE INDEX "daily_plan_items_task_id_idx" ON "daily_plan_items"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "daily_plan_items_plan_id_task_id_key" ON "daily_plan_items"("plan_id", "task_id");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_plans_user_id_week_start_key" ON "weekly_plans"("user_id", "week_start");

-- CreateIndex
CREATE UNIQUE INDEX "task_saved_views_user_id_name_key" ON "task_saved_views"("user_id", "name");

-- AddForeignKey
ALTER TABLE "daily_plans" ADD CONSTRAINT "daily_plans_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_plans" ADD CONSTRAINT "daily_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_plan_items" ADD CONSTRAINT "daily_plan_items_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_plan_items" ADD CONSTRAINT "daily_plan_items_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "daily_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_plan_items" ADD CONSTRAINT "daily_plan_items_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_plans" ADD CONSTRAINT "weekly_plans_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_plans" ADD CONSTRAINT "weekly_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_saved_views" ADD CONSTRAINT "task_saved_views_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_saved_views" ADD CONSTRAINT "task_saved_views_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============ Part 2: integrity + security (hand-written) ============

ALTER TABLE daily_plan_items ADD CONSTRAINT daily_plan_items_status_check
  CHECK (status IN ('PLANNED', 'DONE', 'CARRIED_OVER'));
ALTER TABLE weekly_plans ADD CONSTRAINT weekly_plans_monday_check
  CHECK (EXTRACT(ISODOW FROM week_start) = 1);
ALTER TABLE weekly_plans ADD CONSTRAINT weekly_plans_capacity_check
  CHECK (capacity_minutes IS NULL OR capacity_minutes BETWEEN 0 AND 10080);

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['daily_plans', 'daily_plan_items', 'weekly_plans', 'task_saved_views'] LOOP
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

GRANT SELECT, INSERT, UPDATE, DELETE ON daily_plans, daily_plan_items, weekly_plans, task_saved_views TO hrvo_app;
