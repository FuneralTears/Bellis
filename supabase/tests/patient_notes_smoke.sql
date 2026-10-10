-- H1 notas internas: permisos, aislamiento por workspace y auditoría. Datos sintéticos; todo se revierte.
begin;
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',id,'authenticated','authenticated','h1-notes-'||tag||'@example.invalid','','{}',
  jsonb_build_object('bellis_signup','1','name','Prueba '||tag,'business','Consultorio '||tag,'specialty','Psicología',
    'province','Córdoba','city','Córdoba','timezone','America/Argentina/Buenos_Aires'),now(),now()
from (values ('b1000001-0000-4000-8000-000000000000'::uuid,'owner'),('b1000002-0000-4000-8000-000000000000'::uuid,'other'),
  ('b1000003-0000-4000-8000-000000000000'::uuid,'reception'),('b1000004-0000-4000-8000-000000000000'::uuid,'admin')) as u(id,tag);

-- owner y other tienen cada uno su workspace (alta por trigger). reception y admin se suman al de owner.
create temp table h1_notes_fixture as
select 'b1000001-0000-4000-8000-000000000000'::uuid owner_id,'b1000002-0000-4000-8000-000000000000'::uuid other_id,
  'b1000003-0000-4000-8000-000000000000'::uuid reception_id,'b1000004-0000-4000-8000-000000000000'::uuid admin_id,
  (select workspace_id from public.workspace_members where user_id='b1000001-0000-4000-8000-000000000000') w1,
  (select workspace_id from public.workspace_members where user_id='b1000002-0000-4000-8000-000000000000') w2,
  gen_random_uuid() p1,gen_random_uuid() p2,gen_random_uuid() foreign_note;
grant select on h1_notes_fixture to authenticated,anon;
create temp table h1_notes_ids(tag text primary key,id uuid not null);
grant select,insert on h1_notes_ids to authenticated;
insert into public.workspace_members(workspace_id,user_id,role)
select w1,reception_id,'reception'::public.workspace_role from h1_notes_fixture
union all select w1,admin_id,'admin'::public.workspace_role from h1_notes_fixture;
insert into public.patients(id,workspace_id,first_name,last_name,email)
select p1,w1,'Prueba','Uno','h1-notes-'||p1||'@example.invalid' from h1_notes_fixture
union all select p2,w2,'Prueba','Dos','h1-notes-'||p2||'@example.invalid' from h1_notes_fixture;
-- Sin usuario (servidor): la nota ajena se crea y no deja rastro de auditoría.
insert into public.patient_notes(id,workspace_id,patient_id,author_id,content)
select foreign_note,w2,p2,other_id,'Nota de otro consultorio' from h1_notes_fixture;
do $$ begin
  if exists(select 1 from public.audit_events where object_type='patient_note' and workspace_id in (select w1 from h1_notes_fixture union all select w2 from h1_notes_fixture)) then raise exception 'server write audited'; end if;
  if (select note_type from public.patient_notes where id=(select foreign_note from h1_notes_fixture))<>'general' then raise exception 'default type'; end if;
end $$;

-- Recepción: crea y lee; no puede firmar por otro, usar un tipo inválido ni escribir en otro workspace.
select set_config('request.jwt.claim.sub',reception_id::text,true) from h1_notes_fixture;
set local role authenticated;
do $$ declare f record; v_id uuid; denied boolean; begin
  select * into f from h1_notes_fixture;
  insert into public.patient_notes(workspace_id,patient_id,author_id,content,note_type)
    values(f.w1,f.p1,f.reception_id,'Pidió que lo contactemos la próxima semana.','follow_up') returning id into v_id;
  insert into h1_notes_ids values('reception',v_id);
  if (select count(*) from public.patient_notes where patient_id=f.p1)<>1 then raise exception 'own note not readable'; end if;
  if (select count(*) from public.patient_notes where patient_id=f.p2)<>0 then raise exception 'foreign note readable'; end if;
  denied:=false;
  begin insert into public.patient_notes(workspace_id,patient_id,author_id,content) values(f.w1,f.p1,f.owner_id,'Firmada por otro');
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'note signed as another user'; end if;
  denied:=false;
  begin insert into public.patient_notes(workspace_id,patient_id,author_id,content,note_type) values(f.w1,f.p1,f.reception_id,'Tipo inválido','clinical');
  exception when check_violation then denied:=true; end;
  if not denied then raise exception 'unknown note type accepted'; end if;
  denied:=false;
  begin insert into public.patient_notes(workspace_id,patient_id,author_id,content) values(f.w2,f.p2,f.reception_id,'En otro workspace');
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'note written in foreign workspace'; end if;
  denied:=false;
  begin insert into public.patient_notes(workspace_id,patient_id,author_id,content) values(f.w1,f.p2,f.reception_id,'Paciente ajeno');
  exception when insufficient_privilege or foreign_key_violation then denied:=true; end;
  if not denied then raise exception 'note attached to foreign patient'; end if;
end $$;

-- Owner: crea la suya y ve las dos del workspace.
reset role;
select set_config('request.jwt.claim.sub',owner_id::text,true) from h1_notes_fixture;
set local role authenticated;
do $$ declare f record; v_id uuid; begin
  select * into f from h1_notes_fixture;
  insert into public.patient_notes(workspace_id,patient_id,author_id,content,note_type)
    values(f.w1,f.p1,f.owner_id,'Prefiere recordatorios por WhatsApp.','administrative') returning id into v_id;
  insert into h1_notes_ids values('owner',v_id);
  if (select count(*) from public.patient_notes where patient_id=f.p1)<>2 then raise exception 'workspace notes not readable'; end if;
end $$;

-- Recepción: edita la propia; la del owner no puede editarla ni eliminarla. El autor no se puede cambiar.
reset role;
select set_config('request.jwt.claim.sub',reception_id::text,true) from h1_notes_fixture;
set local role authenticated;
do $$ declare f record; n integer; denied boolean := false; begin
  select * into f from h1_notes_fixture;
  update public.patient_notes set content='Editada sin permiso' where id=(select id from h1_notes_ids where tag='owner');
  get diagnostics n=row_count; if n<>0 then raise exception 'non-author edited a note'; end if;
  delete from public.patient_notes where id=(select id from h1_notes_ids where tag='owner');
  get diagnostics n=row_count; if n<>0 then raise exception 'non-author deleted a note'; end if;
  update public.patient_notes set content='Pidió que lo contactemos el lunes.',note_type='general' where id=(select id from h1_notes_ids where tag='reception');
  get diagnostics n=row_count; if n<>1 then raise exception 'author cannot edit own note'; end if;
  begin update public.patient_notes set author_id=f.owner_id where id=(select id from h1_notes_ids where tag='reception');
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'author changed'; end if;
end $$;

-- Otro workspace: no lee, no edita, no elimina y no puede agregar notas al paciente ajeno.
reset role;
select set_config('request.jwt.claim.sub',other_id::text,true) from h1_notes_fixture;
set local role authenticated;
do $$ declare f record; n integer; denied boolean := false; begin
  select * into f from h1_notes_fixture;
  if (select count(*) from public.patient_notes where patient_id=f.p1)<>0 then raise exception 'foreign workspace reads notes'; end if;
  if (select count(*) from public.patient_notes)<>1 then raise exception 'own workspace note missing'; end if;
  update public.patient_notes set content='Ajena' where patient_id=f.p1;
  get diagnostics n=row_count; if n<>0 then raise exception 'foreign workspace edited notes'; end if;
  delete from public.patient_notes where patient_id=f.p1;
  get diagnostics n=row_count; if n<>0 then raise exception 'foreign workspace deleted notes'; end if;
  begin insert into public.patient_notes(workspace_id,patient_id,author_id,content) values(f.w1,f.p1,f.other_id,'Ajena');
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'foreign workspace wrote a note'; end if;
end $$;

-- Admin: gestiona notas de otros dentro de su workspace, y solo ahí.
reset role;
select set_config('request.jwt.claim.sub',admin_id::text,true) from h1_notes_fixture;
set local role authenticated;
do $$ declare f record; n integer; begin
  select * into f from h1_notes_fixture;
  update public.patient_notes set note_type='payment' where id=(select id from h1_notes_ids where tag='reception');
  get diagnostics n=row_count; if n<>1 then raise exception 'admin cannot edit workspace note'; end if;
  delete from public.patient_notes where id=(select id from h1_notes_ids where tag='owner');
  get diagnostics n=row_count; if n<>1 then raise exception 'admin cannot delete workspace note'; end if;
  delete from public.patient_notes where id=f.foreign_note;
  get diagnostics n=row_count; if n<>0 then raise exception 'admin deleted a foreign workspace note'; end if;
end $$;

-- Recepción elimina la propia.
reset role;
select set_config('request.jwt.claim.sub',reception_id::text,true) from h1_notes_fixture;
set local role authenticated;
do $$ declare n integer; begin
  delete from public.patient_notes where id=(select id from h1_notes_ids where tag='reception');
  get diagnostics n=row_count; if n<>1 then raise exception 'author cannot delete own note'; end if;
end $$;

-- Público: anon no tiene ningún privilegio sobre la tabla.
reset role;
select set_config('request.jwt.claim.sub','',true);
set local role anon;
do $$ declare denied boolean := false; begin
  begin perform 1 from public.patient_notes limit 1;
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'anon can read notes'; end if;
end $$;

reset role;
do $$ declare f record; begin
  select * into f from h1_notes_fixture;
  if has_table_privilege('anon','public.patient_notes','select,insert,update,delete,truncate,references,trigger') then raise exception 'anon has note privileges'; end if;
  if has_table_privilege('authenticated','public.patient_notes','truncate') then raise exception 'authenticated can truncate notes'; end if;
  -- Ninguna función ni vista pública (booking, perfil, checkout) toca las notas.
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosrc ilike '%patient_notes%')
    then raise exception 'public function references notes'; end if;
  if exists(select 1 from pg_views where schemaname='public' and definition ilike '%patient_notes%')
    then raise exception 'public view references notes'; end if;
  -- Auditoría: 2 altas, 2 ediciones (autor y admin), 2 eliminaciones (admin y autor). Los intentos rechazados no dejan filas.
  if (select count(*) from public.audit_events where object_type='patient_note' and workspace_id=f.w1)<>6 then raise exception 'audit trail incomplete'; end if;
  if (select count(*) from public.audit_events where object_type='patient_note' and workspace_id in (f.w1,f.w2) and action='patient_note_created')<>2
    or (select count(*) from public.audit_events where object_type='patient_note' and workspace_id in (f.w1,f.w2) and action='patient_note_updated')<>2
    or (select count(*) from public.audit_events where object_type='patient_note' and workspace_id in (f.w1,f.w2) and action='patient_note_deleted')<>2
    then raise exception 'audit actions wrong'; end if;
  if not exists(select 1 from public.audit_events where action='patient_note_deleted' and actor_user_id=f.admin_id
      and object_id=(select id from h1_notes_ids where tag='owner')) then raise exception 'admin deletion not attributed'; end if;
  if exists(select 1 from public.audit_events where object_type='patient_note' and actor_user_id=f.other_id) then raise exception 'rejected attempt audited'; end if;
  if (select count(*) from public.patient_notes where patient_id=f.p1)<>0 or not exists(select 1 from public.patient_notes where id=f.foreign_note)
    then raise exception 'final state wrong'; end if;
end $$;
rollback;
