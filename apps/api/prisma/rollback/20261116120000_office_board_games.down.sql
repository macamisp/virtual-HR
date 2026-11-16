-- Rollback of 20261116120000_office_board_games (ADR 064). Only after the previous API version is
-- running again (it never reads or writes this table). Loses the games in progress only (they
-- would have ended at the next restart anyway); every other table is untouched. Run as the schema
-- owner.
BEGIN;
DROP TABLE IF EXISTS "office_board_games";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261116120000_office_board_games';
COMMIT;
