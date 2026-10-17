-- Reagendar un turno manual: el mismo turno pasa a otra fecha u horario. No se crea un turno nuevo ni una solicitud
-- nueva: cambian solo appointments.starts_at y ends_at, y el turno conserva su id, paciente, servicio, duración y cobro.
-- Como cambia el horario del turno, los triggers que ya existen reaccionan solos (por ejemplo la sincronización con
-- Google Calendar de 20261020100000); acá no hay nada específico de Google.
-- Solo turnos manuales y agendados, igual que la cancelación (20261015090000): los del booking público tienen
-- recordatorios al paciente encolados con su horario y el paciente no se entera de un cambio. No se encolan avisos.

-- El cálculo compartido de horarios libres, ahora con un turno que no cuenta: el que se está moviendo. Sin esto,
-- el turno ocupa su propio horario y no se podría correr media hora ni cambiar de día con el máximo diario completo.
-- Con p_exclude_appointment null es exactamente el cálculo de 20261013090000.
create function private.professional_free_slots(
  p_workspace uuid,p_professional uuid,p_day date,p_duration integer,p_notice_minutes integer,p_exclude_appointment uuid
) returns table(starts_at timestamptz) language plpgsql security invoker set search_path = '' as $$
declare v_rule public.availability_rules%rowtype;
  v_timezone text; v_candidate timestamptz; v_end timestamptz; v_local timestamp;
  v_step integer; v_max integer;
begin
  select w.timezone into v_timezone from public.workspaces w where w.id=p_workspace;
  if v_timezone is null or p_day is null or coalesce(p_duration,0) <= 0 then return; end if;
  select p.slot_interval_minutes,p.max_appointments_per_day into v_step,v_max
  from public.professionals p where p.id=p_professional and p.workspace_id=p_workspace;
  if v_step is null then return; end if;
  if v_max is not null and (select count(*) from public.appointments a
    where a.professional_id=p_professional and a.workspace_id=p_workspace
      and a.status in ('scheduled','completed') and a.id is distinct from p_exclude_appointment
      and a.starts_at >= p_day::timestamp at time zone v_timezone
      and a.starts_at < (p_day + 1)::timestamp at time zone v_timezone) >= v_max
    then return; end if;
  for v_rule in select * from public.availability_rules r
    where r.professional_id=p_professional and r.workspace_id=p_workspace
      and r.weekday=extract(dow from p_day)::integer loop
    for v_local in select gs from pg_catalog.generate_series(
      p_day + v_rule.starts_at,p_day + v_rule.ends_at - make_interval(mins=>p_duration),
      make_interval(mins=>v_step)) gs loop
      v_candidate := v_local at time zone v_timezone;
      v_end := v_candidate + make_interval(mins=>p_duration);
      if v_candidate < now() + make_interval(mins=>coalesce(p_notice_minutes,0)) then continue; end if;
      if (v_end at time zone v_timezone)::date <> p_day then continue; end if;
      if exists(select 1 from public.availability_blocks b where b.professional_id=p_professional
        and b.workspace_id=p_workspace and tstzrange(b.starts_at,b.ends_at,'[)')
          && tstzrange(v_candidate,v_end,'[)')) then continue; end if;
      if exists(select 1 from public.appointments a where a.professional_id=p_professional
        and a.workspace_id=p_workspace and a.status in ('scheduled','completed')
        and a.id is distinct from p_exclude_appointment
        and tstzrange(a.starts_at - make_interval(mins=>v_rule.buffer_minutes),
          a.ends_at + make_interval(mins=>v_rule.buffer_minutes),'[)')
          && tstzrange(v_candidate,v_end,'[)')) then continue; end if;
      starts_at := v_candidate;
      return next;
    end loop;
  end loop;
end $$;
revoke all on function private.professional_free_slots(uuid,uuid,date,integer,integer,uuid) from public,anon,authenticated;
grant execute on function private.professional_free_slots(uuid,uuid,date,integer,integer,uuid) to service_role;

-- La firma de siempre, para el booking público y el alta manual: el mismo cálculo, sin excluir ningún turno.
create or replace function private.professional_free_slots(
  p_workspace uuid,p_professional uuid,p_day date,p_duration integer,p_notice_minutes integer
) returns table(starts_at timestamptz) language sql security invoker set search_path = '' as $$
  select f.starts_at from private.professional_free_slots(p_workspace,p_professional,p_day,p_duration,p_notice_minutes,null::uuid) f;
$$;
revoke all on function private.professional_free_slots(uuid,uuid,date,integer,integer) from public,anon,authenticated;
grant execute on function private.professional_free_slots(uuid,uuid,date,integer,integer) to service_role;

-- El turno que se puede reagendar, ya bloqueado, y su duración en minutos. Mismos permisos que cargar o cancelar
-- un turno en esa agenda (manual_booking_workspace). La solicitud se bloquea primero, como en la cancelación y en
-- el cobro: un cobro, una cancelación y un reagendado simultáneos esperan uno al otro.
create function private.reschedulable_manual_appointment(p_appointment uuid,p_lock boolean)
returns public.appointments language plpgsql security definer set search_path = '' as $$
declare v_appointment public.appointments%rowtype; v_intent public.booking_intents%rowtype;
begin
  if (select auth.uid()) is null then raise exception 'authentication_required'; end if;
  select * into v_appointment from public.appointments where id=p_appointment;
  if not found or private.manual_booking_workspace(v_appointment.professional_id) is distinct from v_appointment.workspace_id
    then raise exception 'not_authorized'; end if;
  if p_lock then
    select * into v_intent from public.booking_intents where id=v_appointment.booking_intent_id for update;
    select * into v_appointment from public.appointments where id=p_appointment for update;
  else
    select * into v_intent from public.booking_intents where id=v_appointment.booking_intent_id;
  end if;
  if v_intent.source <> 'manual' then raise exception 'not_manual_appointment'; end if;
  if v_appointment.status <> 'scheduled' then raise exception 'appointment_not_reschedulable'; end if;
  return v_appointment;
end $$;
revoke all on function private.reschedulable_manual_appointment(uuid,boolean) from public,anon,authenticated;

-- Los horarios a los que se puede mover el turno ese día: los libres de su agenda para su misma duración, sin contar
-- el propio turno y sin su horario actual. Sin la anticipación mínima del servicio, como el alta manual.
create function private.manual_reschedule_slots(p_appointment uuid,p_day date)
returns table(starts_at timestamptz) language plpgsql security definer set search_path = '' as $$
declare v_appointment public.appointments%rowtype := private.reschedulable_manual_appointment(p_appointment,false);
  v_duration integer := round(extract(epoch from v_appointment.ends_at - v_appointment.starts_at) / 60)::integer;
begin
  return query select f.starts_at from private.professional_free_slots(v_appointment.workspace_id,v_appointment.professional_id,
    p_day,v_duration,0,v_appointment.id) f where f.starts_at <> v_appointment.starts_at order by f.starts_at;
end $$;
revoke all on function private.manual_reschedule_slots(uuid,date) from public,anon,authenticated;
grant execute on function private.manual_reschedule_slots(uuid,date) to authenticated;

create function public.manual_reschedule_slots(p_appointment uuid,p_day date)
returns table(starts_at timestamptz) language sql security invoker set search_path = '' as $$
  select s.starts_at from private.manual_reschedule_slots(p_appointment,p_day) s;
$$;
revoke all on function public.manual_reschedule_slots(uuid,date) from public,anon;
grant execute on function public.manual_reschedule_slots(uuid,date) to authenticated;

-- Mueve el turno. El horario nuevo tiene que ser uno que el cálculo compartido ofrece, como en el alta manual, y se
-- valida otra vez con el mismo candado por profesional y día local que toman el alta manual y la reserva pública.
-- La restricción appointments_no_overlap sigue siendo la última barrera.
create function private.reschedule_manual_appointment(p_appointment uuid,p_starts_at timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_appointment public.appointments%rowtype;
  v_duration integer; v_timezone text; v_day date;
begin
  v_appointment := private.reschedulable_manual_appointment(p_appointment,true);
  if p_starts_at is null or p_starts_at <= now() then raise exception 'slot_in_past'; end if;
  if p_starts_at = v_appointment.starts_at then raise exception 'slot_unchanged'; end if;
  v_duration := round(extract(epoch from v_appointment.ends_at - v_appointment.starts_at) / 60)::integer;
  select w.timezone into v_timezone from public.workspaces w where w.id=v_appointment.workspace_id;
  v_day := (p_starts_at at time zone v_timezone)::date;
  if not exists(select 1 from private.professional_free_slots(v_appointment.workspace_id,v_appointment.professional_id,
    v_day,v_duration,0,v_appointment.id) f where f.starts_at=p_starts_at) then raise exception 'slot_unavailable'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'bellis:schedule:' || v_appointment.professional_id::text || ':' || pg_catalog.to_char(v_day,'YYYY-MM-DD'),0));
  if not exists(select 1 from private.professional_free_slots(v_appointment.workspace_id,v_appointment.professional_id,
    v_day,v_duration,0,v_appointment.id) f where f.starts_at=p_starts_at) then raise exception 'slot_unavailable'; end if;
  update public.appointments set starts_at=p_starts_at,ends_at=p_starts_at + make_interval(mins=>v_duration)
  where id=v_appointment.id;
  -- Quién y cuándo. Ni el paciente ni los horarios quedan en la auditoría.
  insert into public.audit_events(workspace_id,actor_user_id,action,object_type,object_id)
  values(v_appointment.workspace_id,v_user,'manual_appointment_rescheduled','appointment',v_appointment.id);
  return v_appointment.id;
end $$;
revoke all on function private.reschedule_manual_appointment(uuid,timestamptz) from public,anon,authenticated;
grant execute on function private.reschedule_manual_appointment(uuid,timestamptz) to authenticated;

create function public.reschedule_manual_appointment(p_appointment uuid,p_starts_at timestamptz)
returns uuid language sql security invoker set search_path = '' as $$
  select private.reschedule_manual_appointment(p_appointment,p_starts_at);
$$;
revoke all on function public.reschedule_manual_appointment(uuid,timestamptz) from public,anon;
grant execute on function public.reschedule_manual_appointment(uuid,timestamptz) to authenticated;
