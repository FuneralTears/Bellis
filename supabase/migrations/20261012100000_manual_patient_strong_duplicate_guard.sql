-- H2.1: la coincidencia fuerte también se rechaza en el servidor. La pantalla ya no ofrece crear un paciente con
-- el mismo teléfono y el mismo email que otro del workspace; sin esto, una llamada directa a la función lo creaba.
-- Solo cambia private.create_manual_patient, con su misma firma y sus mismos permisos. No hay restricción UNIQUE:
-- el booking público sigue guardando una ficha por solicitud, como hasta ahora.

-- Igual que en 20261012090000, más la verificación antes del alta.
-- Coincidencia fuerte = mismo teléfono y mismo email, los dos presentes, en el mismo workspace y sin eliminar.
-- El teléfono se compara por sus diez dígitos nacionales, igual que en la pantalla: +54 9 11 1234 5678 y
-- +54 11 1234 5678 son el mismo. Compartir solo el teléfono, solo el email o el nombre no impide el alta.
create or replace function private.create_manual_patient(
  p_workspace uuid,p_first_name text,p_last_name text,p_phone text,p_email text,p_note text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_id uuid;
  v_email text := nullif(lower(btrim(coalesce(p_email,''))),'');
  v_note text := nullif(btrim(coalesce(p_note,'')),'');
  v_phone_key text;
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
  if v_email is not null then
    v_phone_key := right(regexp_replace(p_phone,'[^0-9]','','g'),10);
    -- Dos altas simultáneas con los mismos datos esperan una a la otra, así la segunda ve a la primera.
    -- El candado se libera solo al terminar la transacción.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'bellis:manual_patient:' || p_workspace::text || ':' || v_phone_key || ':' || v_email,0));
    if exists(select 1 from public.patients p
      where p.workspace_id=p_workspace and p.deleted_at is null
        and lower(btrim(p.email))=v_email
        and right(regexp_replace(coalesce(p.phone,''),'[^0-9]','','g'),10)=v_phone_key)
      then raise exception 'patient_already_exists'; end if;
  end if;
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
