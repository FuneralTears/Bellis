-- H1: notas internas en la ficha. public.patient_notes (CRM fase 1) sigue siendo la fuente de verdad:
-- se le agrega tipo, eliminación, gestión por owner/admin y registro en audit_events.
-- No hay tipo "clínica": guardar datos clínicos espera la política de privacidad y retención.
alter table public.patient_notes add column note_type text not null default 'general'
  check (note_type in ('general','follow_up','administrative','payment'));

-- author_id, workspace_id y patient_id siguen sin poder cambiarse desde la Data API.
grant update(note_type) on public.patient_notes to authenticated;
grant delete on public.patient_notes to authenticated;
-- Los privilegios por defecto del proyecto dejan estos tres en las tablas nuevas; las notas no los necesitan.
revoke truncate,references,trigger on public.patient_notes from anon,authenticated;

-- El autor gestiona sus notas; owner y admin, todas las del workspace. La lectura y el alta no cambian.
drop policy patient_notes_update on public.patient_notes;
create policy patient_notes_update on public.patient_notes for update to authenticated using (
  (author_id=(select auth.uid()) or private.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[]))
  and exists(select 1 from public.patients p where p.id=patient_id and p.workspace_id=patient_notes.workspace_id and p.deleted_at is null)
) with check (
  (author_id=(select auth.uid()) or private.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[]))
  and exists(select 1 from public.patients p where p.id=patient_id and p.workspace_id=patient_notes.workspace_id and p.deleted_at is null)
);
create policy patient_notes_delete on public.patient_notes for delete to authenticated using (
  (author_id=(select auth.uid()) or private.has_workspace_role(workspace_id,array['owner','admin']::public.workspace_role[]))
  and exists(select 1 from public.patients p where p.id=patient_id and p.workspace_id=patient_notes.workspace_id and p.deleted_at is null)
);

-- Quién creó, editó o eliminó cada nota. El texto de la nota no se copia a la auditoría.
create function private.audit_patient_note() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_note public.patient_notes%rowtype;
begin
  -- Sin usuario no hay acción de una persona: borrados en cascada y tareas del servidor.
  if (select auth.uid()) is null then return null; end if;
  if tg_op='DELETE' then v_note := old; else v_note := new; end if;
  if tg_op='UPDATE' and new.content=old.content and new.note_type=old.note_type then return null; end if;
  insert into public.audit_events(workspace_id,actor_user_id,action,object_type,object_id)
  values(v_note.workspace_id,(select auth.uid()),
    case tg_op when 'INSERT' then 'patient_note_created' when 'UPDATE' then 'patient_note_updated' else 'patient_note_deleted' end,
    'patient_note',v_note.id);
  return null;
end $$;
revoke all on function private.audit_patient_note() from public,anon,authenticated;
create trigger patient_note_audit after insert or update or delete on public.patient_notes
  for each row execute function private.audit_patient_note();
