-- Schema/security fingerprint shared by backup-encrypted.sh (baseline, in the backup snapshot) and
-- restore-test.sh (restored copy). Catalog metadata only; never business rows. ADR 051.
-- One row per line: key<TAB>value. Hashes cover definitions, so a changed body/policy fails the restore test.
-- Canonical forms: a dump/restore re-deparses `x IN (...)` on varchar with different casts/parentheses, and
-- pg_dump omits an ACL equal to the owner default. Expressions are compared with only []/()/::text/
-- ::character varying noise removed (values, columns and operators still count); default ACLs compare as NULL.
SELECT k || chr(9) || v FROM (
  SELECT 'role:' || rolname AS k,
         format('super=%s bypassrls=%s login=%s createrole=%s createdb=%s inherit=%s',
                rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb, rolinherit) AS v
  FROM pg_roles WHERE rolname !~ '^pg_' AND rolname NOT IN ('postgres', 'hrvo_restore_su')
  UNION ALL
  SELECT 'role_memberships', count(*)::text || ' md5=' || md5(coalesce(string_agg(
           roleid::regrole::text || '>' || member::regrole::text, ',' ORDER BY 1), ''))
  FROM pg_auth_members WHERE roleid::regrole::text !~ '^pg_' AND member::regrole::text !~ '^pg_'
  UNION ALL
  SELECT 'tables', count(*)::text || ' forced_rls=' || count(*) FILTER (WHERE c.relforcerowsecurity)
         || ' rls=' || count(*) FILTER (WHERE c.relrowsecurity) || ' md5=' || md5(string_agg(
           c.relname || ':' || pg_get_userbyid(c.relowner) || ':' || c.relrowsecurity || c.relforcerowsecurity
           || ':' || coalesce(nullif(c.relacl, acldefault('r', c.relowner))::text, ''), ',' ORDER BY c.relname))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  UNION ALL
  SELECT 'columns', count(*)::text || ' md5=' || md5(string_agg(
           c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull,
           ',' ORDER BY c.relname, a.attnum))
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'policies', count(*)::text || ' md5=' || md5(string_agg(
           tablename || '.' || policyname || ':' || permissive || ':' || array_to_string(roles, '+') || ':' || cmd
           || ':' || regexp_replace(coalesce(qual, ''), '[()]|::character varying|::text\[\]|::text', '', 'g') || ':' || regexp_replace(coalesce(with_check, ''), '[()]|::character varying|::text\[\]|::text', '', 'g'), ',' ORDER BY tablename, policyname))
  FROM pg_policies WHERE schemaname = 'public'
  UNION ALL
  SELECT 'functions', count(*)::text || ' secdef=' || count(*) FILTER (WHERE p.prosecdef) || ' md5=' || md5(string_agg(
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || pg_get_userbyid(p.proowner)
           || ':' || p.prosecdef || ':' || coalesce(array_to_string(p.proconfig, ';'), '') || ':'
           || coalesce(nullif(p.proacl, acldefault('f', p.proowner))::text, '') || ':' || md5(p.prosrc), ',' ORDER BY p.proname, p.oid::regprocedure::text))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'triggers', count(*)::text || ' md5=' || md5(coalesce(string_agg(
           regexp_replace(pg_get_triggerdef(t.oid), '[()]|::character varying|::text\[\]|::text', '', 'g') || ':' || t.tgenabled::text, ',' ORDER BY c.relname, t.tgname), ''))
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE NOT t.tgisinternal AND n.nspname = 'public'
  UNION ALL
  SELECT 'indexes', count(*)::text || ' md5=' || md5(string_agg(regexp_replace(indexdef, '[()]|::character varying|::text\[\]|::text', '', 'g'), ',' ORDER BY tablename, indexname))
  FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL
  SELECT 'constraints', count(*)::text || ' md5=' || md5(string_agg(
           c.relname || '.' || co.conname || ':' || regexp_replace(pg_get_constraintdef(co.oid), '[()]|::character varying|::text\[\]|::text', '', 'g') || ':' || co.convalidated,
           ',' ORDER BY c.relname, co.conname))
  FROM pg_constraint co JOIN pg_class c ON c.oid = co.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
  UNION ALL
  -- Names only: sequence values are non-transactional, so they are not frozen by the snapshot.
  SELECT 'sequences', count(*)::text || ' md5=' || md5(coalesce(string_agg(
           sequencename || ':' || data_type::text, ',' ORDER BY sequencename), ''))
  FROM pg_sequences WHERE schemaname = 'public'
  UNION ALL
  SELECT 'extensions', string_agg(extname || '=' || extversion, ',' ORDER BY extname) FROM pg_extension
) f ORDER BY k;
