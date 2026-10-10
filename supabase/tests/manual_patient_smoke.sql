-- H2.1 alta manual de pacientes: permisos por rol, aislamiento por workspace, email opcional, nota, auditoría
-- y rechazo de la coincidencia fuerte (mismo teléfono y mismo email en el mismo workspace).
-- Datos sintéticos; todo se revierte.
begin;
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',id,'authenticated','authenticated','h21-patients-'||tag||'@example.invalid','','{}',
  jsonb_build_object('bellis_signup','1','name','Prueba '||tag,'business','Consultorio '||tag,'specialty','Psicología',
    'province','Córdoba','city','Córdoba','timezone','America/Argentina/Buenos_Aires'),now(),now()
from (values ('b2100001-0000-4000-8000-000000000000'::uuid,'owner'),('b2100002-0000-4000-8000-000000000000'::uuid,'other'),
  ('b2100003-0000-4000-8000-000000000000'::uuid,'reception'),('b2100004-0000-4000-8000-000000000000'::uuid,'admin'),
  ('b2100005-0000-4000-8000-000000000000'::uuid,'professional')) as u(id,tag);

-- owner y other tienen cada uno su workspace (alta por trigger). Los otros tres se suman al de owner con su rol.
create temp table h21_fixture as
select 'b2100001-0000-4000-8000-000000000000'::uuid owner_id,'b2100002-0000-4000-8000-000000000000'::uuid other_id,
  'b2100003-0000-4000-8000-000000000000'::uuid reception_id,'b2100004-0000-4000-8000-000000000000'::uuid admin_id,
  'b2100005-0000-4000-8000-000000000000'::uuid professional_id,
  (select workspace_id from public.workspace_members where user_id='b2100001-0000-4000-8000-000000000000') w1,
  (select workspace_id from public.workspace_members where user_id='b2100002-0000-4000-8000-000000000000') w2,
  gen_random_uuid() public_patient;
grant select on h21_fixture to authenticated,anon;
create temp table h21_ids(tag text primary key,id uuid not null);
grant select,insert on h21_ids to authenticated;
insert into public.workspace_members(workspace_id,user_id,role)
select w1,reception_id,'reception'::public.workspace_role from h21_fixture
union all select w1,admin_id,'admin'::public.workspace_role from h21_fixture
union all select w1,professional_id,'professional'::public.workspace_role from h21_fixture;
-- Un paciente como los que crea el booking público: con email y sin created_by.
insert into public.patients(id,workspace_id,first_name,last_name,email,phone)
select public_patient,w1,'Prueba','Pública','h21-public@example.invalid','+5491155550000' from h21_fixture;

do $$ begin
  -- El esquema que pide H2.1.
  if (select is_nullable from information_schema.columns where table_schema='public' and table_name='patients' and column_name='email') <> 'YES'
    then raise exception 'email_still_required'; end if;
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='patients' and column_name='created_by')
    then raise exception 'created_by_missing'; end if;
  if (select created_by from public.patients where id=(select public_patient from h21_fixture)) is not null
    then raise exception 'public_patient_has_creator'; end if;
  -- Solo con sesión, y nunca con insert directo sobre la tabla.
  if has_function_privilege('anon','public.create_manual_patient(uuid,text,text,text,text,text)','execute')
    or has_function_privilege('anon','private.create_manual_patient(uuid,text,text,text,text,text)','execute')
    then raise exception 'anon_can_create_patients'; end if;
  if not has_function_privilege('authenticated','public.create_manual_patient(uuid,text,text,text,text,text)','execute')
    then raise exception 'authenticated_cannot_create_patients'; end if;
  if has_table_privilege('authenticated','public.patients','insert') or has_table_privilege('anon','public.patients','insert')
    then raise exception 'direct_patient_insert_allowed'; end if;
end $$;

-- Sin usuario no hay alta.
select set_config('request.jwt.claim.sub','',true);
set local role authenticated;
do $$ declare f record; begin
  select * into f from h21_fixture;
  begin perform public.create_manual_patient(f.w1,'Sin','Sesión','+5491155550009'); raise exception 'created_without_user';
  exception when others then if sqlerrm <> 'authentication_required' then raise; end if; end;
end $$;
reset role;

-- Owner: con email y nota. Los datos inválidos se rechazan y no dejan nada.
select set_config('request.jwt.claim.sub',owner_id::text,true) from h21_fixture;
set local role authenticated;
do $$ declare f record; v_id uuid; begin
  select * into f from h21_fixture;
  v_id := public.create_manual_patient(f.w1,'  Ana  ','  Ejemplo ','+5491155550001','  Ana.Ejemplo@Example.INVALID ','  Escribió por WhatsApp.  ');
  insert into h21_ids values('owner',v_id);
  if (select count(*) from public.patients where id=v_id) <> 1 then raise exception 'owner_cannot_read_own_patient'; end if;
  if (select count(*) from public.patient_follow_up_opportunities where id=v_id and workspace_id=f.w1) <> 1
    then raise exception 'manual_patient_not_in_crm'; end if;
  if (select count(*) from public.patient_notes where patient_id=v_id) <> 1 then raise exception 'owner_cannot_read_note'; end if;
  begin perform public.create_manual_patient(f.w1,'   ','Ejemplo','+5491155550002'); raise exception 'blank_name_accepted';
  exception when others then if sqlerrm <> 'invalid_patient' then raise; end if; end;
  begin perform public.create_manual_patient(f.w1,'Ana','Ejemplo','11 5555 0002'); raise exception 'unnormalized_phone_accepted';
  exception when others then if sqlerrm <> 'invalid_patient' then raise; end if; end;
  begin perform public.create_manual_patient(f.w1,'Ana','Ejemplo',null); raise exception 'missing_phone_accepted';
  exception when others then if sqlerrm <> 'invalid_patient' then raise; end if; end;
  begin perform public.create_manual_patient(f.w1,'Ana','Ejemplo','+5491155550002','no-es-un-email'); raise exception 'bad_email_accepted';
  exception when others then if sqlerrm <> 'invalid_patient' then raise; end if; end;
  begin perform public.create_manual_patient(f.w1,'Ana','Ejemplo','+5491155550002',null,repeat('x',5001)); raise exception 'long_note_accepted';
  exception when others then if sqlerrm <> 'invalid_note' then raise; end if; end;
  begin perform public.create_manual_patient(null,'Ana','Ejemplo','+5491155550002'); raise exception 'null_workspace_accepted';
  exception when others then if sqlerrm <> 'not_authorized' then raise; end if; end;
end $$;
reset role;
do $$ declare f record; p public.patients%rowtype; begin
  select * into f from h21_fixture;
  select * into p from public.patients where id=(select id from h21_ids where tag='owner');
  if p.first_name <> 'Ana' or p.last_name <> 'Ejemplo' or p.email <> 'ana.ejemplo@example.invalid' or p.phone <> '+5491155550001'
    or p.created_by <> f.owner_id or p.status <> 'new' or p.workspace_id <> f.w1 or p.deleted_at is not null
    then raise exception 'owner_patient_wrong: %', row_to_json(p); end if;
  if (select count(*) from public.audit_events where action='patient_created_manually' and object_type='patient'
    and object_id=p.id and actor_user_id=f.owner_id and workspace_id=f.w1) <> 1 then raise exception 'creation_not_audited'; end if;
  if (select count(*) from public.patient_notes where patient_id=p.id and author_id=f.owner_id and note_type='general'
    and content='Escribió por WhatsApp.') <> 1 then raise exception 'note_wrong'; end if;
  if (select count(*) from public.audit_events a join public.patient_notes n on n.id=a.object_id
    where a.action='patient_note_created' and n.patient_id=p.id and a.actor_user_id=f.owner_id) <> 1 then raise exception 'note_not_audited'; end if;
  -- Los cinco intentos inválidos no crearon nada.
  if (select count(*) from public.patients where workspace_id=f.w1 and created_by is not null) <> 1 then raise exception 'invalid_attempt_left_rows'; end if;
end $$;

-- Recepción: sin email ni nota. El mismo teléfono dos veces no se bloquea: la pantalla avisa, la base no decide.
select set_config('request.jwt.claim.sub',reception_id::text,true) from h21_fixture;
set local role authenticated;
do $$ declare f record; v_id uuid; v_again uuid; begin
  select * into f from h21_fixture;
  v_id := public.create_manual_patient(f.w1,'Beto','Ejemplo','+5491155550003');
  insert into h21_ids values('reception',v_id);
  v_again := public.create_manual_patient(f.w1,'Beto','Repetido','+5491155550003','   ','   ');
  insert into h21_ids values('reception_again',v_again);
  if v_id = v_again then raise exception 'same_phone_merged'; end if;
  if (select count(*) from public.patients where id in (v_id,v_again) and email is null) <> 2 then raise exception 'reception_patients_wrong'; end if;
  if (select count(*) from public.patients where workspace_id=f.w1) <> 4 then raise exception 'reception_should_see_all'; end if;
end $$;
reset role;
do $$ begin
  if exists(select 1 from public.patient_notes where patient_id in (select id from h21_ids where tag like 'reception%'))
    then raise exception 'empty_note_saved'; end if;
  if (select count(*) from public.patients where id in (select id from h21_ids where tag like 'reception%')
    and created_by=(select reception_id from h21_fixture)) <> 2 then raise exception 'reception_creator_wrong'; end if;
end $$;

-- Rol professional: ve y gestiona al paciente que cargó, y nada más del workspace.
select set_config('request.jwt.claim.sub',professional_id::text,true) from h21_fixture;
set local role authenticated;
do $$ declare f record; v_id uuid; v_rows integer; begin
  select * into f from h21_fixture;
  v_id := public.create_manual_patient(f.w1,'Caro','Ejemplo','+5491155550004','caro@example.invalid');
  insert into h21_ids values('professional',v_id);
  if (select count(*) from public.patients where id=v_id) <> 1 then raise exception 'professional_cannot_read_own_patient'; end if;
  if (select count(*) from public.patients where workspace_id=f.w1) <> 1 then raise exception 'professional_reads_others'; end if;
  update public.patients set status='active' where id=v_id;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'professional_cannot_update_own_patient'; end if;
  update public.patients set status='inactive' where id=(select id from h21_ids where tag='owner');
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then raise exception 'professional_updated_foreign_patient'; end if;
  -- La nota interna de H1 funciona sobre el paciente recién creado.
  insert into public.patient_notes(workspace_id,patient_id,author_id,content) values(f.w1,v_id,f.professional_id,'Prefiere turnos a la tarde.');
end $$;
reset role;

-- Admin: puede cargar.
select set_config('request.jwt.claim.sub',admin_id::text,true) from h21_fixture;
set local role authenticated;
do $$ declare f record; v_id uuid; begin
  select * into f from h21_fixture;
  v_id := public.create_manual_patient(f.w1,'Dani','Ejemplo','+5491155550005');
  insert into h21_ids values('admin',v_id);
  if (select count(*) from public.patients where workspace_id=f.w1) <> 6 then raise exception 'admin_should_see_all'; end if;
end $$;
reset role;

-- Otro workspace: ni carga ni ve.
select set_config('request.jwt.claim.sub',other_id::text,true) from h21_fixture;
set local role authenticated;
do $$ declare f record; v_id uuid; begin
  select * into f from h21_fixture;
  begin perform public.create_manual_patient(f.w1,'Intruso','Ejemplo','+5491155550006'); raise exception 'foreign_workspace_write';
  exception when others then if sqlerrm <> 'not_authorized' then raise; end if; end;
  if exists(select 1 from public.patients where workspace_id=f.w1) then raise exception 'foreign_workspace_read'; end if;
  -- En el suyo sí, y queda en el suyo.
  v_id := public.create_manual_patient(f.w2,'Eva','Ejemplo','+5491155550007');
  if (select workspace_id from public.patients where id=v_id) <> f.w2 then raise exception 'patient_in_wrong_workspace'; end if;
end $$;
reset role;

-- Coincidencia fuerte: mismo teléfono y mismo email, los dos presentes, en el mismo workspace. La base la rechaza
-- aunque la llamada no pase por la pantalla. Compartir solo uno de los dos datos, o el nombre, no impide el alta.
select set_config('request.jwt.claim.sub',admin_id::text,true) from h21_fixture;
set local role authenticated;
do $$ declare f record; v_id uuid; begin
  select * into f from h21_fixture;
  -- Contra el paciente manual de owner (Ana, +5491155550001, ana.ejemplo@example.invalid), con otro nombre.
  begin perform public.create_manual_patient(f.w1,'Otro','Nombre','+5491155550001','ana.ejemplo@example.invalid'); raise exception 'strong_duplicate_created';
  exception when others then if sqlerrm <> 'patient_already_exists' then raise; end if; end;
  -- Mayúsculas, espacios y el prefijo sin el 9 no lo esquivan.
  begin perform public.create_manual_patient(f.w1,'Otro','Nombre','+541155550001','  ANA.Ejemplo@Example.INVALID '); raise exception 'strong_duplicate_created_with_other_format';
  exception when others then if sqlerrm <> 'patient_already_exists' then raise; end if; end;
  -- Contra un paciente del booking público también.
  begin perform public.create_manual_patient(f.w1,'Otro','Nombre','+5491155550000','h21-public@example.invalid'); raise exception 'strong_duplicate_of_public_patient_created';
  exception when others then if sqlerrm <> 'patient_already_exists' then raise; end if; end;
  -- Solo el teléfono igual: se crea.
  v_id := public.create_manual_patient(f.w1,'Ana','Ejemplo','+5491155550001','otra.ana@example.invalid');
  insert into h21_ids values('same_phone',v_id);
  -- Solo el email igual: se crea.
  v_id := public.create_manual_patient(f.w1,'Ana','Ejemplo','+5491155550011','ana.ejemplo@example.invalid');
  insert into h21_ids values('same_email',v_id);
  -- Mismo teléfono y sin email: se crea, aunque ya haya una ficha con ese teléfono.
  v_id := public.create_manual_patient(f.w1,'Ana','Ejemplo','+5491155550001');
  insert into h21_ids values('same_phone_no_email',v_id);
  -- La ficha recién creada con ese email ya es una coincidencia fuerte para un tercer intento.
  begin perform public.create_manual_patient(f.w1,'Tercero','Intento','+5491155550011','ana.ejemplo@example.invalid'); raise exception 'second_strong_duplicate_created';
  exception when others then if sqlerrm <> 'patient_already_exists' then raise; end if; end;
end $$;
reset role;
-- Una ficha eliminada no bloquea: se da de baja la que cargó el rol professional (Caro, +5491155550004).
update public.patients set deleted_at=now() where id=(select id from h21_ids where tag='professional');
select set_config('request.jwt.claim.sub',admin_id::text,true) from h21_fixture;
set local role authenticated;
do $$ declare f record; v_id uuid; begin
  select * into f from h21_fixture;
  v_id := public.create_manual_patient(f.w1,'Caro','Ejemplo','+5491155550004','caro@example.invalid');
  insert into h21_ids values('after_deleted',v_id);
end $$;
reset role;
-- Otro workspace con los mismos datos: se crea, y recién ahí queda bloqueado dentro de ese workspace.
select set_config('request.jwt.claim.sub',other_id::text,true) from h21_fixture;
set local role authenticated;
do $$ declare f record; v_id uuid; begin
  select * into f from h21_fixture;
  v_id := public.create_manual_patient(f.w2,'Ana','Ejemplo','+5491155550001','ana.ejemplo@example.invalid');
  if (select workspace_id from public.patients where id=v_id) <> f.w2 then raise exception 'cross_workspace_patient_wrong'; end if;
  begin perform public.create_manual_patient(f.w2,'Ana','Ejemplo','+5491155550001','ana.ejemplo@example.invalid'); raise exception 'strong_duplicate_created_in_other_workspace';
  exception when others then if sqlerrm <> 'patient_already_exists' then raise; end if; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','',true);

-- El booking público no cambia: sigue guardando una ficha por solicitud, aunque repita teléfono y email.
insert into public.patients(workspace_id,first_name,last_name,email,phone)
select w1,'Ana','Ejemplo','ana.ejemplo@example.invalid','+5491155550001' from h21_fixture;
do $$ declare f record; begin
  select * into f from h21_fixture;
  if (select count(*) from public.patients where workspace_id=f.w1 and email='ana.ejemplo@example.invalid' and phone='+5491155550001') <> 2
    then raise exception 'public_booking_duplicate_blocked'; end if;
  if exists(select 1 from pg_catalog.pg_constraint where conrelid='public.patients'::regclass and contype='u' and conname <> 'patients_workspace_id_id_unique')
    then raise exception 'unexpected_unique_on_patients'; end if;
  -- Los rechazos no dejaron fichas ni auditoría: en w1 hay 5 altas de antes más 4 de este bloque.
  if (select count(*) from public.patients where workspace_id=f.w1 and created_by is not null) <> 9 then raise exception 'rejected_duplicate_left_rows'; end if;
  if exists(select 1 from public.patients where first_name in ('Otro','Tercero') and workspace_id in (f.w1,f.w2)) then raise exception 'rejected_patient_saved'; end if;
end $$;

do $$ declare f record; begin
  select * into f from h21_fixture;
  -- Una auditoría por alta, cada una con su actor; ninguna para el paciente del booking público.
  if (select count(*) from public.audit_events where action='patient_created_manually' and workspace_id=f.w1) <> 9
    or (select count(distinct actor_user_id) from public.audit_events where action='patient_created_manually' and workspace_id=f.w1) <> 4
    then raise exception 'audit_count_wrong'; end if;
  if exists(select 1 from public.audit_events where object_id=f.public_patient) then raise exception 'public_patient_audited'; end if;
  if exists(select 1 from public.audit_events where action='patient_created_manually' and actor_user_id is null) then raise exception 'audit_without_actor'; end if;
end $$;
select count(*) as manual_patients from public.patients
where workspace_id=(select w1 from h21_fixture) and created_by is not null;
rollback;
