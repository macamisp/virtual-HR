-- Rollback of 20261115000000_office_presence_intervals (ADR 059). Only after the previous API
-- version is running again (it never reads or writes this table). Loses office-connection
-- intervals only; attendance, meetings and every other table are untouched. Run as the schema owner.
BEGIN;
DROP FUNCTION IF EXISTS fn_close_stale_office_presence(TIMESTAMPTZ);
DROP TABLE IF EXISTS "office_presence_intervals";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261115000000_office_presence_intervals';
COMMIT;
