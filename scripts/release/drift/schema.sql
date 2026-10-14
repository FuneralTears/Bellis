-- Bellis schema capture. Read by scripts/release/drift/capture.mjs.
-- Read-only: it asks PostgreSQL's catalogs what the schema is. No row of any table of the product is read.
-- The search path is emptied first, so every name PostgreSQL prints is written out in full (schema.name) and the
-- answer does not depend on who asks. Times are in UTC.
--
-- What is covered: the schemas public and private (tables and their columns, constraints, indexes, row-level
-- security and its policies, functions, views, triggers, types, sequences, grants and default privileges), the
-- triggers on auth's tables that call a function of those schemas, the extensions the migrations install, and the
-- pg_cron jobs named bellis-*. Objects that belong to an extension are left out: they change with the platform.
begin transaction isolation level repeatable read read only;
set local time zone 'UTC';
set local search_path = '';
with settings as (
  select array['public', 'private']::text[] as schemas,
    array['btree_gist', 'pg_cron']::text[] as extensions,
    -- Schemas the platform owns. Anything else that is not ours is reported as unknown.
    array['auth', 'storage', 'realtime', '_realtime', 'extensions', 'graphql', 'graphql_public', 'vault', 'pgbouncer', 'net', 'cron', 'supabase_functions',
      'supabase_migrations', 'pgsodium', 'pgsodium_masks', 'pgmq', 'pgmq_public', '_analytics', '_supavisor', 'information_schema']::text[] as platform
),
ns as (select n.oid, n.nspname, n.nspowner, n.nspacl from pg_namespace n, settings s where n.nspname = any (s.schemas)),
member as (select d.classid, d.objid from pg_depend d where d.deptype = 'e')
select jsonb_build_object(
  'database_time', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'server_version', current_setting('server_version_num'),
  'applied_migrations', (select coalesce(jsonb_agg(m.version order by m.version), '[]'::jsonb) from supabase_migrations.schema_migrations m),
  'other_cron_jobs', (select count(*) from cron.job j where j.jobname is null or j.jobname not like 'bellis-%'),
  'schemas', (select coalesce(jsonb_agg(x.o order by x.o ->> 'id'), '[]'::jsonb) from (
    select jsonb_build_object('id', n.nspname, 'owner', pg_get_userbyid(n.nspowner), 'unknown', false,
      'grants', (select coalesce(jsonb_agg(g.g order by g.g), '[]'::jsonb) from (select (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) || ':' || a.privilege_type || (case when a.is_grantable then '*' else '' end) as g
        from aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a) g)) as o
    from ns n
    union all
    select jsonb_build_object('id', n.nspname, 'owner', pg_get_userbyid(n.nspowner), 'unknown', true, 'grants', '[]'::jsonb)
    from pg_namespace n, settings s where n.nspname !~ '^pg_' and n.nspname <> all (s.platform) and n.nspname <> all (s.schemas)) x),
  'tables', (select coalesce(jsonb_agg(jsonb_build_object('id', n.nspname || '.' || c.relname, 'owner', pg_get_userbyid(c.relowner), 'kind', c.relkind::text,
      'rls', c.relrowsecurity, 'rls_forced', c.relforcerowsecurity, 'options', coalesce(to_jsonb(c.reloptions), '[]'::jsonb),
      'columns', (select coalesce(jsonb_agg(jsonb_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull,
          'default', pg_get_expr(d.adbin, d.adrelid), 'identity', a.attidentity::text, 'generated', a.attgenerated::text,
          'collation', (select cn.nspname || '.' || co.collname from pg_collation co join pg_namespace cn on cn.oid = co.collnamespace join pg_type t on t.oid = a.atttypid where co.oid = a.attcollation and a.attcollation <> t.typcollation),
          'grants', (select coalesce(jsonb_agg(g.g order by g.g), '[]'::jsonb) from (select (case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end) || ':' || x.privilege_type || (case when x.is_grantable then '*' else '' end) as g
            from aclexplode(a.attacl) x) g)) order by a.attnum), '[]'::jsonb)
        from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
      'grants', (select coalesce(jsonb_agg(g.g order by g.g), '[]'::jsonb) from (select (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) || ':' || a.privilege_type || (case when a.is_grantable then '*' else '' end) as g
        from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a) g)) order by n.nspname, c.relname), '[]'::jsonb)
    from pg_class c join ns n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and not exists (select 1 from member m where m.classid = 'pg_class'::regclass and m.objid = c.oid)),
  'constraints', (select coalesce(jsonb_agg(jsonb_build_object('id', n.nspname || '.' || c.relname || '.' || k.conname, 'table', n.nspname || '.' || c.relname, 'type', k.contype::text,
      'definition', pg_get_constraintdef(k.oid), 'validated', k.convalidated, 'deferrable', k.condeferrable, 'deferred', k.condeferred) order by n.nspname, c.relname, k.conname), '[]'::jsonb)
    from pg_constraint k join pg_class c on c.oid = k.conrelid join ns n on n.oid = c.relnamespace
    where not exists (select 1 from member m where m.classid = 'pg_class'::regclass and m.objid = c.oid)),
  'indexes', (select coalesce(jsonb_agg(jsonb_build_object('id', n.nspname || '.' || ic.relname, 'table', n.nspname || '.' || c.relname, 'definition', pg_get_indexdef(i.indexrelid),
      'unique', i.indisunique, 'primary', i.indisprimary, 'valid', i.indisvalid, 'predicate', pg_get_expr(i.indpred, i.indrelid), 'expressions', pg_get_expr(i.indexprs, i.indrelid)) order by n.nspname, ic.relname), '[]'::jsonb)
    from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_class c on c.oid = i.indrelid join ns n on n.oid = c.relnamespace
    where not exists (select 1 from member m where m.classid = 'pg_class'::regclass and m.objid = c.oid)),
  'policies', (select coalesce(jsonb_agg(jsonb_build_object('id', n.nspname || '.' || c.relname || '.' || p.polname, 'table', n.nspname || '.' || c.relname, 'command', p.polcmd::text, 'permissive', p.polpermissive,
      'roles', (select coalesce(jsonb_agg(r.r order by r.r), '[]'::jsonb) from (select case when x = 0 then 'PUBLIC' else pg_get_userbyid(x) end as r from unnest(p.polroles) x) r),
      'using', pg_get_expr(p.polqual, p.polrelid), 'check', pg_get_expr(p.polwithcheck, p.polrelid)) order by n.nspname, c.relname, p.polname), '[]'::jsonb)
    from pg_policy p join pg_class c on c.oid = p.polrelid join ns n on n.oid = c.relnamespace),
  'functions', (select coalesce(jsonb_agg(jsonb_build_object('id', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', 'kind', p.prokind::text,
      'arguments', pg_get_function_arguments(p.oid), 'result', pg_get_function_result(p.oid), 'language', l.lanname, 'volatility', p.provolatile::text, 'security_definer', p.prosecdef,
      'leakproof', p.proleakproof, 'parallel', p.proparallel::text, 'strict', p.proisstrict, 'config', coalesce(to_jsonb(p.proconfig), '[]'::jsonb), 'owner', pg_get_userbyid(p.proowner),
      'body', p.prosrc, 'sql_body', pg_get_function_sqlbody(p.oid),
      'grants', (select coalesce(jsonb_agg(g.g order by g.g), '[]'::jsonb) from (select (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) || ':' || a.privilege_type || (case when a.is_grantable then '*' else '' end) as g
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) g)) order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)), '[]'::jsonb)
    from pg_proc p join ns n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
    where not exists (select 1 from member m where m.classid = 'pg_proc'::regclass and m.objid = p.oid)),
  'views', (select coalesce(jsonb_agg(jsonb_build_object('id', n.nspname || '.' || c.relname, 'kind', c.relkind::text, 'owner', pg_get_userbyid(c.relowner), 'definition', pg_get_viewdef(c.oid),
      'options', coalesce(to_jsonb(c.reloptions), '[]'::jsonb),
      'grants', (select coalesce(jsonb_agg(g.g order by g.g), '[]'::jsonb) from (select (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) || ':' || a.privilege_type || (case when a.is_grantable then '*' else '' end) as g
        from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a) g)) order by n.nspname, c.relname), '[]'::jsonb)
    from pg_class c join ns n on n.oid = c.relnamespace
    where c.relkind in ('v', 'm') and not exists (select 1 from member m where m.classid = 'pg_class'::regclass and m.objid = c.oid)),
  'triggers', (select coalesce(jsonb_agg(jsonb_build_object('id', tn.nspname || '.' || c.relname || '.' || t.tgname, 'table', tn.nspname || '.' || c.relname, 'function', fn.nspname || '.' || f.proname,
      'enabled', t.tgenabled::text, 'type', t.tgtype, 'definition', pg_get_triggerdef(t.oid)) order by tn.nspname, c.relname, t.tgname), '[]'::jsonb)
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace tn on tn.oid = c.relnamespace join pg_proc f on f.oid = t.tgfoid join pg_namespace fn on fn.oid = f.pronamespace, settings s
    where not t.tgisinternal and (tn.nspname = any (s.schemas) or (tn.nspname = 'auth' and fn.nspname = any (s.schemas)))),
  'types', (select coalesce(jsonb_agg(jsonb_build_object('id', n.nspname || '.' || t.typname, 'kind', t.typtype::text, 'owner', pg_get_userbyid(t.typowner),
      'values', (select coalesce(jsonb_agg(e.enumlabel order by e.enumsortorder), '[]'::jsonb) from pg_enum e where e.enumtypid = t.oid),
      'base', (case when t.typtype = 'd' then format_type(t.typbasetype, t.typtypmod) end), 'not_null', t.typnotnull, 'default', t.typdefault,
      'checks', (select coalesce(jsonb_agg(pg_get_constraintdef(k.oid) order by k.conname), '[]'::jsonb) from pg_constraint k where k.contypid = t.oid),
      'attributes', (select coalesce(jsonb_agg(jsonb_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod)) order by a.attnum), '[]'::jsonb)
        from pg_attribute a where t.typtype = 'c' and a.attrelid = t.typrelid and a.attnum > 0 and not a.attisdropped)) order by n.nspname, t.typname), '[]'::jsonb)
    from pg_type t join ns n on n.oid = t.typnamespace
    where (t.typtype in ('e', 'd') or (t.typtype = 'c' and exists (select 1 from pg_class c where c.oid = t.typrelid and c.relkind = 'c')))
      and not exists (select 1 from member m where m.classid = 'pg_type'::regclass and m.objid = t.oid)),
  'sequences', (select coalesce(jsonb_agg(jsonb_build_object('id', n.nspname || '.' || c.relname, 'owner', pg_get_userbyid(c.relowner), 'type', format_type(q.seqtypid, null), 'start', q.seqstart::text,
      'increment', q.seqincrement::text, 'minimum', q.seqmin::text, 'maximum', q.seqmax::text, 'cycle', q.seqcycle,
      'grants', (select coalesce(jsonb_agg(g.g order by g.g), '[]'::jsonb) from (select (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) || ':' || a.privilege_type || (case when a.is_grantable then '*' else '' end) as g
        from aclexplode(coalesce(c.relacl, acldefault('s', c.relowner))) a) g)) order by n.nspname, c.relname), '[]'::jsonb)
    from pg_class c join ns n on n.oid = c.relnamespace join pg_sequence q on q.seqrelid = c.oid
    where not exists (select 1 from member m where m.classid = 'pg_class'::regclass and m.objid = c.oid)),
  'default_privileges', (select coalesce(jsonb_agg(jsonb_build_object('id', pg_get_userbyid(d.defaclrole) || ':' || n.nspname || ':' || d.defaclobjtype::text,
      'grants', (select coalesce(jsonb_agg(g.g order by g.g), '[]'::jsonb) from (select (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) || ':' || a.privilege_type || (case when a.is_grantable then '*' else '' end) as g
        from aclexplode(d.defaclacl) a) g)) order by pg_get_userbyid(d.defaclrole), n.nspname, d.defaclobjtype), '[]'::jsonb)
    from pg_default_acl d join ns n on n.oid = d.defaclnamespace),
  'extensions', (select coalesce(jsonb_agg(jsonb_build_object('id', e.extname, 'schema', n.nspname, 'info_version', e.extversion) order by e.extname), '[]'::jsonb)
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace, settings s where e.extname = any (s.extensions)),
  'cron', (select coalesce(jsonb_agg(jsonb_build_object('id', j.jobname, 'schedule', j.schedule, 'command', j.command, 'active', j.active, 'database', j.database, 'username', j.username) order by j.jobname), '[]'::jsonb)
    from cron.job j where j.jobname like 'bellis-%')
) as schema;
rollback;
