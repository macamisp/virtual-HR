-- FR-AUTH-010, NFR-REL-002, NFR-SEC-001. Metadata only; never select business rows.
-- Run using psql -X -v ON_ERROR_STOP=1 -f, with output in a mode-600 private file.
-- Exact counts can create I/O load. Each statement times out after 10 seconds.
\set ON_ERROR_STOP on
\pset pager off
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '1s';
SET LOCAL idle_in_transaction_session_timeout = '30s';
SELECT current_database() AS database, current_user AS audit_role,
       current_setting('server_version') AS version,
       pg_database_size(current_database()) AS database_bytes,
       current_setting('TimeZone') AS timezone,
       current_setting('transaction_read_only') AS read_only;
SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid();
SELECT extname, extversion, extnamespace::regnamespace AS schema FROM pg_extension ORDER BY extname;
SELECT nspname, pg_get_userbyid(nspowner) AS owner, nspacl
FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY nspname;
-- pg_roles excludes password hashes. Never use pg_authid or pg_shadow in audit output.
SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
       rolcanlogin, rolreplication, rolbypassrls, rolconnlimit
FROM pg_roles ORDER BY rolname;
SELECT roleid::regrole AS granted_role, member::regrole AS member, admin_option
FROM pg_auth_members ORDER BY 1, 2;
SELECT datname, pg_get_userbyid(datdba) AS owner, datacl, datconnlimit
FROM pg_database WHERE datname = current_database();
SELECT n.nspname, c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner,
       c.relrowsecurity, c.relforcerowsecurity, c.relacl,
       pg_total_relation_size(c.oid) AS total_bytes
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
  AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f') ORDER BY 1, 2;
SELECT * FROM pg_policies WHERE schemaname !~ '^pg_' ORDER BY schemaname, tablename, policyname;
SELECT defaclrole::regrole AS owner, defaclnamespace::regnamespace AS schema,
       defaclobjtype, defaclacl FROM pg_default_acl ORDER BY 1, 2, 3;
SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes
WHERE schemaname !~ '^pg_' AND schemaname <> 'information_schema' ORDER BY 1, 2, 3;
SELECT n.nspname, c.relname, co.conname, co.contype, co.convalidated,
       pg_get_constraintdef(co.oid) AS definition
FROM pg_constraint co JOIN pg_class c ON c.oid = co.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' ORDER BY 1, 2, 3;
SELECT n.nspname, c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname !~ '^pg_' ORDER BY 1, 2, 3;
-- Function signatures, ownership and search_path; bodies belong in the restricted schema backup.
SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS arguments,
       pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig, p.proacl,
       md5(p.prosrc) AS body_fingerprint
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' ORDER BY 1, 2, 3;
SELECT schemaname, sequencename, sequenceowner, data_type, start_value,
       min_value, max_value, increment_by, cycle, cache_size, last_value
FROM pg_sequences WHERE schemaname !~ '^pg_' ORDER BY 1, 2;
SELECT name, setting, unit FROM pg_settings
WHERE name IN ('max_connections', 'wal_level', 'archive_mode', 'ssl', 'ssl_min_protocol_version',
               'shared_buffers', 'max_wal_senders', 'max_replication_slots') ORDER BY name;
SELECT state, count(*) FROM pg_stat_activity WHERE datname = current_database() GROUP BY state;
-- Refuse to publish RLS-filtered counts as a complete inventory.
SELECT rolsuper OR rolbypassrls AS can_count_all FROM pg_roles WHERE rolname = current_user \gset
\if :can_count_all
SELECT format('SELECT %L AS table_name, count(*) AS row_count FROM %I.%I;',
              n.nspname || '.' || c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
  AND c.relkind IN ('r', 'p') ORDER BY n.nspname, c.relname
\gexec
\else
\echo 'INCOMPLETE: exact counts skipped; existing audit role cannot bypass FORCE RLS.'
\endif
-- No migration logs: failed migration logs may include confidential row contents.
SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS has_migrations \gset
\if :has_migrations
SELECT migration_name, checksum, started_at, finished_at, rolled_back_at, applied_steps_count
FROM public._prisma_migrations ORDER BY migration_name;
\endif
COMMIT;
