-- ADR 064 (FR-VO-017): board games being played survive an API restart. Additive only: no existing
-- table or column changes. One row per game in progress; the row is deleted when the game ends,
-- so nothing is kept about games once they are over (no history, no scores).
CREATE TABLE "office_board_games" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "floor_id" VARCHAR(64) NOT NULL,
    "table_id" INTEGER NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "white_id" UUID NOT NULL,
    "black_id" UUID NOT NULL,
    -- The position, side to move and rule state (castling, en passant, counters, a checkers jump in
    -- progress), exactly as the shared rules engine left it after the last accepted move.
    "state" JSONB NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "office_board_games_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "office_board_games"
  ADD CONSTRAINT "office_board_games_kind_check" CHECK ("kind" IN ('chess', 'checkers')),
  ADD CONSTRAINT "office_board_games_players_check" CHECK ("white_id" <> "black_id"),
  ADD CONSTRAINT "office_board_games_state_check" CHECK (jsonb_typeof("state") = 'object' AND "state"->>'kind' = "kind"),
  ADD CONSTRAINT "office_board_games_updated_check" CHECK ("updated_at" >= "started_at");

-- One game per table.
CREATE UNIQUE INDEX "office_board_games_table_key" ON "office_board_games"("org_id", "floor_id", "table_id");

ALTER TABLE "office_board_games" ADD CONSTRAINT "office_board_games_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Both players belong to the game's organisation (users_org_id_id_key, 20261116000000).
ALTER TABLE "office_board_games" ADD CONSTRAINT "office_board_games_org_id_white_id_fkey" FOREIGN KEY ("org_id", "white_id") REFERENCES "users"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "office_board_games" ADD CONSTRAINT "office_board_games_org_id_black_id_fkey" FOREIGN KEY ("org_id", "black_id") REFERENCES "users"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "office_board_games" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "office_board_games" FORCE ROW LEVEL SECURITY;
CREATE POLICY "office_board_games_org_policy" ON "office_board_games" FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- The office starts, updates and ends (deletes) games.
GRANT SELECT, INSERT, UPDATE, DELETE ON "office_board_games" TO hrvo_app;
REVOKE TRUNCATE ON "office_board_games" FROM hrvo_app;
-- Erasure (FR-AUD-003) removes a person's games, like their other office data.
GRANT SELECT, DELETE ON "office_board_games" TO hrvo_retention;
