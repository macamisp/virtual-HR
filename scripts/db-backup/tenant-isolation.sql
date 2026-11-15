-- Tenant-isolation check for a RESTORED THROWAWAY copy only (restore-test.sh, ADR 051).
-- Never run against production: it creates temp tables and attempts a (rolled back) cross-tenant write.
-- Output: one summary line "isolation<TAB>..." ; restore-test.sh fails unless failures=0.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
CREATE TEMP TABLE iso_orgs AS SELECT id::text AS org FROM public.organizations ORDER BY id LIMIT 2;
CREATE TEMP TABLE iso_tables AS
  SELECT c.relname::text AS tbl, CASE WHEN c.relname = 'organizations' THEN 'id' ELSE 'org_id' END AS col
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relforcerowsecurity
    AND has_table_privilege('hrvo_app', c.oid, 'SELECT')
    AND (c.relname = 'organizations' OR EXISTS (SELECT 1 FROM pg_attribute a
         WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped));
CREATE TEMP TABLE iso_expect (tbl text, org text, n bigint);
CREATE TEMP TABLE iso_seen (tbl text, org text, n bigint, foreign_rows bigint);
SELECT format('INSERT INTO iso_expect SELECT %L, %L, count(*) FROM public.%I WHERE %I::text = %L',
              t.tbl, o.org, t.tbl, t.col, o.org) FROM iso_tables t CROSS JOIN iso_orgs o \gexec
GRANT SELECT ON iso_orgs, iso_tables TO hrvo_app;
GRANT INSERT ON iso_seen TO hrvo_app;

SET ROLE hrvo_app;
-- 1. No tenant context: every tenant table must look empty.
SELECT set_config('app.org_id', '', false) \g /dev/null
SELECT format('INSERT INTO iso_seen SELECT %L, %L, count(*), count(*) FROM public.%I', t.tbl, '(none)', t.tbl)
FROM iso_tables t \gexec
-- 2. Each tenant: sees exactly its own rows and no other tenant's rows.
SELECT q FROM (
  SELECT o.org, 0 AS ord, format('SELECT set_config(%L, %L, false)', 'app.org_id', o.org) AS q FROM iso_orgs o
  UNION ALL
  SELECT o.org, 1, format('INSERT INTO iso_seen SELECT %L, %L, count(*), count(*) FILTER (WHERE %I::text <> %L) FROM public.%I',
                          t.tbl, o.org, t.col, o.org, t.tbl)
  FROM iso_orgs o CROSS JOIN iso_tables t
) s ORDER BY org, ord \gexec
RESET ROLE;
SELECT set_config('app.org_id', '', false) \g /dev/null

SELECT 'isolation' || chr(9) || format('orgs=%s tables=%s no_context_leaks=%s count_mismatches=%s foreign_rows=%s failures=%s',
  (SELECT count(*) FROM iso_orgs), (SELECT count(*) FROM iso_tables),
  (SELECT count(*) FROM iso_seen WHERE org = '(none)' AND n > 0),
  (SELECT count(*) FROM iso_seen s JOIN iso_expect e USING (tbl, org) WHERE s.n <> e.n),
  (SELECT count(*) FROM iso_seen WHERE org <> '(none)' AND foreign_rows > 0),
  (SELECT count(*) FROM iso_seen WHERE org = '(none)' AND n > 0)
  + (SELECT count(*) FROM iso_seen s JOIN iso_expect e USING (tbl, org) WHERE s.n <> e.n)
  + (SELECT count(*) FROM iso_seen WHERE org <> '(none)' AND foreign_rows > 0)
  + (SELECT count(*) FROM iso_expect e WHERE NOT EXISTS (SELECT 1 FROM iso_seen s WHERE s.tbl = e.tbl AND s.org = e.org)));
SELECT 'isolation_detail' || chr(9) || s.tbl || ' org=' || s.org || ' seen=' || s.n || ' expected=' || coalesce(e.n::text, '0')
       || ' foreign=' || s.foreign_rows
FROM iso_seen s LEFT JOIN iso_expect e USING (tbl, org)
WHERE (s.org = '(none)' AND s.n > 0) OR (s.org <> '(none)' AND (s.n <> e.n OR s.foreign_rows > 0))
ORDER BY 1 LIMIT 20;
