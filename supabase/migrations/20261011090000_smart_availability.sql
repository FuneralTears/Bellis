-- H1.5: la frecuencia con la que se ofrecen horarios deja de ser una constante de 15 minutos y pasa a ser una
-- preferencia de la agenda del profesional, junto con un máximo opcional de turnos por día.
-- La frecuencia solo decide qué inicios se proponen: la duración sale de la solicitud y el descanso de la regla,
-- igual que antes, y la disponibilidad se sigue validando en el servidor.

-- Quien ya atendía conserva los 15 minutos que tenía; quien se registre después recibe 30. Por eso la columna
-- nace sin default: un `add column ... default 30` le habría cambiado la agenda a los existentes.
alter table public.professionals
  add column slot_interval_minutes integer,
  add column max_appointments_per_day integer;
update public.professionals set slot_interval_minutes=15 where slot_interval_minutes is null;
alter table public.professionals
  alter column slot_interval_minutes set default 30,
  alter column slot_interval_minutes set not null,
  add constraint professionals_slot_interval_minutes_check check (slot_interval_minutes in (15,30,60)),
  -- null = sin límite.
  add constraint professionals_max_appointments_per_day_check check (max_appointments_per_day between 1 and 50);

-- Misma firma, mismos permisos y mismas reglas que en 20260928030100. Cambia el paso de la grilla, que sigue
-- anclada al inicio de cada regla, y se agrega el máximo diario.
create or replace function public.available_slots_for_intent(p_intent uuid,p_day date)
returns table(starts_at timestamptz) language plpgsql security invoker set search_path = '' as $$
declare v_intent public.booking_intents%rowtype; v_rule public.availability_rules%rowtype;
  v_timezone text; v_notice integer; v_candidate timestamptz; v_end timestamptz; v_local timestamp;
  v_step integer; v_max integer;
begin
  select * into v_intent from public.booking_intents where id=p_intent;
  if not found or v_intent.status not in ('awaiting_schedule','payment_confirmed') or v_intent.expires_at < now()
    or not exists(select 1 from public.payments p where p.booking_intent_id=p_intent
      and p.status='approved' and p.amount_minor=v_intent.price_minor and p.currency_code=v_intent.currency_code)
    then return; end if;
  if p_day < (now() at time zone (select timezone from public.workspaces where id=v_intent.workspace_id))::date
    or p_day > (now() + interval '60 days')::date then return; end if;
  select w.timezone,s.min_notice_minutes into v_timezone,v_notice
  from public.workspaces w join public.services s on s.workspace_id=w.id
  where w.id=v_intent.workspace_id and s.id=v_intent.service_id and s.active;
  if v_timezone is null then return; end if;
  select p.slot_interval_minutes,p.max_appointments_per_day into v_step,v_max
  from public.professionals p where p.id=v_intent.professional_id and p.workspace_id=v_intent.workspace_id;
  if v_step is null then return; end if;
  -- El día es el día local del workspace. Cuentan los mismos turnos que ocupan lugar: agendados y completados.
  if v_max is not null and (select count(*) from public.appointments a
    where a.professional_id=v_intent.professional_id and a.workspace_id=v_intent.workspace_id
      and a.status in ('scheduled','completed')
      and a.starts_at >= p_day::timestamp at time zone v_timezone
      and a.starts_at < (p_day + 1)::timestamp at time zone v_timezone) >= v_max
    then return; end if;
  for v_rule in select * from public.availability_rules r
    where r.professional_id=v_intent.professional_id and r.workspace_id=v_intent.workspace_id
      and r.weekday=extract(dow from p_day)::integer loop
    for v_local in select gs from pg_catalog.generate_series(
      p_day + v_rule.starts_at,p_day + v_rule.ends_at - make_interval(mins=>v_intent.duration_minutes),
      make_interval(mins=>v_step)) gs loop
      v_candidate := v_local at time zone v_timezone;
      v_end := v_candidate + make_interval(mins=>v_intent.duration_minutes);
      if v_candidate < now() + make_interval(mins=>v_notice) then continue; end if;
      if (v_end at time zone v_timezone)::date <> p_day then continue; end if;
      if exists(select 1 from public.availability_blocks b where b.professional_id=v_intent.professional_id
        and b.workspace_id=v_intent.workspace_id and tstzrange(b.starts_at,b.ends_at,'[)')
          && tstzrange(v_candidate,v_end,'[)')) then continue; end if;
      if exists(select 1 from public.appointments a where a.professional_id=v_intent.professional_id
        and a.workspace_id=v_intent.workspace_id and a.status in ('scheduled','completed')
        and tstzrange(a.starts_at - make_interval(mins=>v_rule.buffer_minutes),
          a.ends_at + make_interval(mins=>v_rule.buffer_minutes),'[)')
          && tstzrange(v_candidate,v_end,'[)')) then continue; end if;
      starts_at := v_candidate;
      return next;
    end loop;
  end loop;
end $$;

-- Igual que en 20260928030100, más un candado por profesional y día local antes de volver a validar el horario.
-- Dos reservas simultáneas de solicitudes distintas no se veían entre sí: la restricción de solapamiento las
-- frenaba, pero no protegía el descanso ni protegería el máximo diario.
-- Clave: hashtextextended('bellis:schedule:<professional_id>:<AAAA-MM-DD local>', 0). Se calcula dentro de
-- PostgreSQL, es la misma para toda reserva de ese profesional en ese día y se libera sola al terminar la
-- transacción. Una colisión entre claves distintas solo haría esperar a una reserva ajena, nunca rechazarla.
create or replace function public.schedule_paid_intent(p_intent uuid,p_starts_at timestamptz)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_intent public.booking_intents%rowtype; v_id uuid; v_end timestamptz; v_local_day date;
begin
  select * into v_intent from public.booking_intents where id=p_intent for update;
  if not found or v_intent.status not in ('payment_confirmed','awaiting_schedule')
    then raise exception 'payment_not_confirmed'; end if;
  v_local_day := (p_starts_at at time zone (select timezone from public.workspaces where id=v_intent.workspace_id))::date;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'bellis:schedule:' || v_intent.professional_id::text || ':' || pg_catalog.to_char(v_local_day,'YYYY-MM-DD'),0));
  if not exists(select 1 from public.available_slots_for_intent(p_intent,v_local_day) s where s.starts_at=p_starts_at)
    then raise exception 'slot_unavailable'; end if;
  v_end := p_starts_at + make_interval(mins=>v_intent.duration_minutes);
  insert into public.appointments(workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at)
  values(v_intent.workspace_id,p_intent,v_intent.professional_id,v_intent.patient_id,p_starts_at,v_end)
  returning id into v_id;
  update public.booking_intents set status='scheduled' where id=p_intent;
  insert into public.notification_outbox(workspace_id,appointment_id,channel,template_key,deliver_after)
  values(v_intent.workspace_id,v_id,'email','patient_confirmed',now()),
    (v_intent.workspace_id,v_id,'email','professional_new',now()),
    (v_intent.workspace_id,v_id,'email','patient_reminder_24h',greatest(now(),p_starts_at - interval '24 hours')),
    (v_intent.workspace_id,v_id,'email','patient_reminder_2h',greatest(now(),p_starts_at - interval '2 hours'));
  insert into public.audit_events(workspace_id,action,object_type,object_id)
  values(v_intent.workspace_id,'appointment_scheduled','appointment',v_id);
  return v_id;
end $$;
