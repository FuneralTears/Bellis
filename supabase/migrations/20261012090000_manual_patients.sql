-- H2.1: pacientes que llegan por fuera del booking público (WhatsApp, teléfono, recurrentes).
-- El booking público no cambia: sigue exigiendo email y sigue creando sus pacientes con service_role.

-- Un paciente cargado a mano puede no tener email. created_by queda vacío en los que crea el booking público.
alter table public.patients alter column email drop not null;
alter table public.patients add column created_by uuid references auth.users(id) on delete set null;

-- Igual que en 20260928035000, más una rama: quien tiene rol "professional" ve también los pacientes que cargó,
-- aunque todavía no tengan una solicitud con él. Owner, admin y recepción ya veían todos los del workspace.
drop policy patient_read on public.patients;
create policy patient_read on public.patients for select to authenticated using (
  private.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[])
  or exists(select 1 from public.booking_intents i join public.professionals p
    on p.id=i.professional_id and p.workspace_id=i.workspace_id
    where i.patient_id=patients.id and i.workspace_id=patients.workspace_id and p.user_id=(select auth.uid()))
  or (created_by=(select auth.uid())
    and private.has_workspace_role(workspace_id,array['professional']::public.workspace_role[])));

-- Igual que en 20260929031500, con la misma rama: quien cargó al paciente puede cambiarle el estado.
drop policy patient_status_write on public.patients;
create policy patient_status_write on public.patients for update to authenticated
using (
  deleted_at is null and (
    private.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[])
    or exists (select 1 from public.booking_intents i join public.professionals pr
      on pr.id=i.professional_id and pr.workspace_id=i.workspace_id
      where i.patient_id=patients.id and i.workspace_id=patients.workspace_id
        and pr.user_id=(select auth.uid()))
    or (created_by=(select auth.uid())
      and private.has_workspace_role(workspace_id,array['professional']::public.workspace_role[]))
  )
)
with check (
  deleted_at is null and (
    private.has_workspace_role(workspace_id,array['owner','admin','reception']::public.workspace_role[])
    or exists (select 1 from public.booking_intents i join public.professionals pr
      on pr.id=i.professional_id and pr.workspace_id=i.workspace_id
      where i.patient_id=patients.id and i.workspace_id=patients.workspace_id
        and pr.user_id=(select auth.uid()))
    or (created_by=(select auth.uid())
      and private.has_workspace_role(workspace_id,array['professional']::public.workspace_role[]))
  )
);

-- Alta manual. No hay insert directo sobre patients: la identidad y el rol se verifican acá.
-- Teléfono con el mismo formato que exige el booking público. El email es opcional y se guarda en minúsculas.
-- La nota, si viene, es una nota interna de tipo general (H1) firmada por quien carga al paciente.
-- No se busca ni se bloquea por duplicados: la pantalla avisa y la persona decide.
create function private.create_manual_patient(
  p_workspace uuid,p_first_name text,p_last_name text,p_phone text,p_email text,p_note text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_id uuid;
  v_email text := nullif(lower(btrim(coalesce(p_email,''))),'');
  v_note text := nullif(btrim(coalesce(p_note,'')),'');
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if p_workspace is null or not private.has_workspace_role(p_workspace,
    array['owner','admin','professional','reception']::public.workspace_role[])
    then raise exception 'not_authorized'; end if;
  if length(btrim(coalesce(p_first_name,''))) not between 1 and 120
    or length(btrim(coalesce(p_last_name,''))) not between 1 and 120
    or coalesce(p_phone,'') !~ '^\+54[0-9]{8,13}$'
    or (v_email is not null and (length(v_email) not between 5 and 255 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'))
    then raise exception 'invalid_patient'; end if;
  if v_note is not null and char_length(v_note) > 5000 then raise exception 'invalid_note'; end if;
  insert into public.patients(workspace_id,first_name,last_name,email,phone,created_by)
  values(p_workspace,btrim(p_first_name),btrim(p_last_name),v_email,p_phone,v_user)
  returning id into v_id;
  -- Quién y cuándo. Los datos del paciente no se copian a la auditoría.
  insert into public.audit_events(workspace_id,actor_user_id,action,object_type,object_id)
  values(p_workspace,v_user,'patient_created_manually','patient',v_id);
  if v_note is not null then
    insert into public.patient_notes(workspace_id,patient_id,author_id,content,note_type)
    values(p_workspace,v_id,v_user,v_note,'general');
  end if;
  return v_id;
end $$;
revoke all on function private.create_manual_patient(uuid,text,text,text,text,text) from public,anon,authenticated;
grant execute on function private.create_manual_patient(uuid,text,text,text,text,text) to authenticated;

create function public.create_manual_patient(
  p_workspace uuid,p_first_name text,p_last_name text,p_phone text,p_email text default null,p_note text default null
) returns uuid language sql security invoker set search_path = '' as $$
  select private.create_manual_patient(p_workspace,p_first_name,p_last_name,p_phone,p_email,p_note);
$$;
revoke all on function public.create_manual_patient(uuid,text,text,text,text,text) from public,anon;
grant execute on function public.create_manual_patient(uuid,text,text,text,text,text) to authenticated;
