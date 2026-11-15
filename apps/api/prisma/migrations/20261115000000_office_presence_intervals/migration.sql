-- ADR 059 (FR-REP-009): when a person was connected to the virtual office, as server-timed
-- intervals. Additive only: no existing table or column changes. Deliberately nothing about where
-- the person was or what they did (no room, position, desk, game, nudge or avatar action).
CREATE TABLE "office_presence_intervals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL,
    "ended_at" TIMESTAMPTZ,
    "last_seen_at" TIMESTAMPTZ NOT NULL,
    "end_reason" VARCHAR(16),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "office_presence_intervals_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "office_presence_intervals"
  ADD CONSTRAINT "office_presence_intervals_end_reason_check" CHECK ("end_reason" IS NULL OR "end_reason" IN ('LEFT', 'DROPPED', 'SERVER_RESTART')),
  -- An interval never ends before it starts, and is never seen before it starts.
  ADD CONSTRAINT "office_presence_intervals_ended_check" CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at"),
  ADD CONSTRAINT "office_presence_intervals_seen_check" CHECK ("last_seen_at" >= "started_at"),
  -- An end reason exactly when the interval has ended.
  ADD CONSTRAINT "office_presence_intervals_reason_check" CHECK (("ended_at" IS NULL) = ("end_reason" IS NULL));

CREATE INDEX "office_presence_intervals_org_id_user_id_started_at_idx" ON "office_presence_intervals"("org_id", "user_id", "started_at");
-- At most one open interval per person (one avatar per person, whatever the number of tabs).
CREATE UNIQUE INDEX "office_presence_intervals_one_open_key" ON "office_presence_intervals"("org_id", "user_id") WHERE "ended_at" IS NULL;

ALTER TABLE "office_presence_intervals" ADD CONSTRAINT "office_presence_intervals_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "office_presence_intervals" ADD CONSTRAINT "office_presence_intervals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "office_presence_intervals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "office_presence_intervals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "office_presence_intervals_org_policy" ON "office_presence_intervals" FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- The application opens, refreshes and closes intervals; it never deletes them.
GRANT SELECT, INSERT, UPDATE ON "office_presence_intervals" TO hrvo_app;
-- (the default privileges would also give it DELETE; taken away so only retention and erasure delete)
REVOKE DELETE, TRUNCATE ON "office_presence_intervals" FROM hrvo_app;
-- Retention (FR-ADM-004) and erasure (FR-AUD-003) delete them, like raw presence events.
GRANT SELECT, DELETE ON "office_presence_intervals" TO hrvo_retention;

-- After an API restart (or a lost write), close intervals nobody has refreshed since a cutoff, at
-- the last time the server saw the person: never later than the last reliable observation. Runs
-- across organisations at startup, so it is a narrow definer function, like the lookup functions.
CREATE FUNCTION fn_close_stale_office_presence(p_stale_before TIMESTAMPTZ)
RETURNS INTEGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  UPDATE office_presence_intervals SET ended_at = last_seen_at, end_reason = 'SERVER_RESTART'
  WHERE ended_at IS NULL AND last_seen_at < p_stale_before;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION fn_close_stale_office_presence(TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_close_stale_office_presence(TIMESTAMPTZ) TO hrvo_app;
