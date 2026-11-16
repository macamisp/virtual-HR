-- FR-AUTH-010, FR-REP-009: bind the person to the interval's tenant at the database layer.
-- Keep the original migration immutable for databases that have already applied it.
ALTER TABLE public.users ADD CONSTRAINT users_org_id_id_key UNIQUE (org_id, id);
ALTER TABLE public.office_presence_intervals
  DROP CONSTRAINT office_presence_intervals_user_id_fkey,
  ADD CONSTRAINT office_presence_intervals_org_id_user_id_fkey
    FOREIGN KEY (org_id, user_id) REFERENCES public.users (org_id, id)
    ON DELETE CASCADE ON UPDATE CASCADE;

-- pg_temp must be explicit and last; qualify the target as well. A caller cannot use this
-- cross-tenant maintenance capability to close live intervals by supplying a future cutoff.
CREATE OR REPLACE FUNCTION public.fn_close_stale_office_presence(p_stale_before TIMESTAMPTZ)
RETURNS INTEGER
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  UPDATE public.office_presence_intervals
    SET ended_at = last_seen_at, end_reason = 'SERVER_RESTART'
    WHERE ended_at IS NULL
      AND last_seen_at < LEAST(p_stale_before, clock_timestamp() - interval '3 minutes');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_close_stale_office_presence(TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_close_stale_office_presence(TIMESTAMPTZ) TO hrvo_app;
