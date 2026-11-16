-- Rollback of 20261116000000_office_presence_security (FR-AUTH-010, FR-REP-009, ADR 059).
-- Restores the single-column user foreign key and the original stale-close function. Keeps every
-- office-connection interval. The API code is the same before and after; run as the schema owner.
-- Run this before rolling back 20261115000000_office_presence_intervals, never after.
BEGIN;
ALTER TABLE public.office_presence_intervals
  DROP CONSTRAINT IF EXISTS office_presence_intervals_org_id_user_id_fkey,
  ADD CONSTRAINT office_presence_intervals_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_org_id_id_key;
CREATE OR REPLACE FUNCTION public.fn_close_stale_office_presence(p_stale_before TIMESTAMPTZ)
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
REVOKE ALL ON FUNCTION public.fn_close_stale_office_presence(TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_close_stale_office_presence(TIMESTAMPTZ) TO hrvo_app;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261116000000_office_presence_security';
COMMIT;
