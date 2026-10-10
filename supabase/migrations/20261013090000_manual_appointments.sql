-- H2.2: turnos cargados a mano por el consultorio (WhatsApp, teléfono, pacientes recurrentes) y cobros fuera de Bellis.
-- Se reutiliza solicitud -> pago -> turno: no hay un modelo paralelo y appointments.booking_intent_id sigue obligatorio.
-- Todo es aditivo. El booking público, Mercado Pago y el link externo no cambian de comportamiento.

-- De dónde viene la solicitud. Las que existen y las que crea el booking público son 'public'.
alter table public.booking_intents
  add column source text not null default 'public' check (source in ('public','manual')),
  add column created_by uuid references auth.users(id) on delete set null,
  -- Una solicitud manual nunca tiene un token: ninguna ruta pública puede leerla, pagarla ni agendarla.
  add constraint booking_intents_manual_has_no_token
    check (source <> 'manual' or (access_token_hash is null and resume_token_hash is null));

-- Cobros fuera de Bellis. provider='offline' lleva siempre el medio; los demás proveedores, nunca.
-- Un cobro offline no tiene preferencia, id de pago ni checkout: no se parece a un pago de Mercado Pago.
-- "Pendiente" no es una fila: mientras no se cobró no hay pago, así no se inventa proveedor ni medio.
alter table public.payments
  add column method text check (method in ('cash','transfer','other')),
  add column recorded_by uuid references auth.users(id) on delete set null,
  add constraint payments_offline_has_method check ((provider = 'offline') = (method is not null)),
  add constraint payments_offline_is_not_a_provider_payment check (provider <> 'offline' or (
    amount_minor > 0 and provider_order_id is null and provider_payment_id is null
    and provider_event_id is null and checkout_url is null));

-- El cálculo de horarios libres, compartido por el booking público y por el turno manual.
-- Es el cuerpo que tenía available_slots_for_intent en 20261011090000, sin cambios: reglas de la semana,
-- frecuencia del profesional, máximo diario, bloqueos y turnos existentes con su descanso.
-- p_notice_minutes es la anticipación mínima: el booking público pasa la del servicio; el turno manual pasa 0,
-- que igual deja afuera cualquier horario que ya pasó.
create function private.professional_free_slots(
  p_workspace uuid,p_professional uuid,p_day date,p_duration integer,p_notice_minutes integer
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
  -- El día es el día local del workspace. Cuentan los mismos turnos que ocupan lugar: agendados y completados.
  if v_max is not null and (select count(*) from public.appointments a
    where a.professional_id=p_professional and a.workspace_id=p_workspace
      and a.status in ('scheduled','completed')
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
        and tstzrange(a.starts_at - make_interval(mins=>v_rule.buffer_minutes),
          a.ends_at + make_interval(mins=>v_rule.buffer_minutes),'[)')
          && tstzrange(v_candidate,v_end,'[)')) then continue; end if;
      starts_at := v_candidate;
      return next;
    end loop;
  end loop;
end $$;
revoke all on function private.professional_free_slots(uuid,uuid,date,integer,integer) from public,anon,authenticated;
grant execute on function private.professional_free_slots(uuid,uuid,date,integer,integer) to service_role;

-- Misma firma, mismos permisos y mismos controles que en 20261011090000: la solicitud tiene que estar paga,
-- vigente y dentro de la ventana de reserva. Lo único que cambia es que el cálculo vive en el helper.
create or replace function public.available_slots_for_intent(p_intent uuid,p_day date)
returns table(starts_at timestamptz) language plpgsql security invoker set search_path = '' as $$
declare v_intent public.booking_intents%rowtype; v_timezone text; v_notice integer;
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
  return query select f.starts_at from private.professional_free_slots(
    v_intent.workspace_id,v_intent.professional_id,p_day,v_intent.duration_minutes,v_notice) f;
end $$;

-- Quién puede cargar turnos en la agenda de un profesional: owner, admin y recepción, en la de cualquiera del
-- workspace; un profesional, solo en la propia. Devuelve el workspace, o null si no corresponde.
create function private.manual_booking_workspace(p_professional uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_workspace uuid; v_owner uuid;
begin
  if (select auth.uid()) is null then return null; end if;
  select p.workspace_id,p.user_id into v_workspace,v_owner from public.professionals p where p.id=p_professional and p.active;
  if v_workspace is null then return null; end if;
  if private.has_workspace_role(v_workspace,array['owner','admin','reception']::public.workspace_role[])
    or v_owner=(select auth.uid()) then return v_workspace; end if;
  return null;
end $$;
revoke all on function private.manual_booking_workspace(uuid) from public,anon,authenticated;

-- Registra un cobro hecho fuera de Bellis sobre una solicitud manual. Una solicitud tiene un solo pago.
create function private.insert_offline_payment(
  p_workspace uuid,p_intent uuid,p_method text,p_amount_minor integer,p_currency char(3),p_actor uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_method is null or p_method not in ('cash','transfer','other') or coalesce(p_amount_minor,0) <= 0 or p_currency <> 'ARS'
    then raise exception 'invalid_payment'; end if;
  if exists(select 1 from public.payments where booking_intent_id=p_intent) then raise exception 'payment_already_recorded'; end if;
  insert into public.payments(workspace_id,booking_intent_id,provider,method,amount_minor,currency_code,status,approved_at,recorded_by)
  values(p_workspace,p_intent,'offline',p_method,p_amount_minor,p_currency,'approved',now(),p_actor)
  returning id into v_id;
  -- Quién y cuándo. El importe y el medio quedan en el pago, no en la auditoría.
  insert into public.audit_events(workspace_id,actor_user_id,action,object_type,object_id)
  values(p_workspace,p_actor,'offline_payment_recorded','payment',v_id);
  return v_id;
end $$;
revoke all on function private.insert_offline_payment(uuid,uuid,text,integer,character,uuid) from public,anon,authenticated;

-- Los horarios que se pueden ofrecer para un turno manual: los mismos que vería un paciente, sin la anticipación
-- mínima del servicio (esa regla es para pacientes) y sin el tope de 60 días del booking público.
create function private.manual_available_slots(p_professional uuid,p_service uuid,p_day date)
returns table(starts_at timestamptz) language plpgsql security definer set search_path = '' as $$
declare v_workspace uuid := private.manual_booking_workspace(p_professional); v_duration integer;
begin
  if (select auth.uid()) is null then raise exception 'authentication_required'; end if;
  if v_workspace is null then raise exception 'not_authorized'; end if;
  select s.duration_minutes into v_duration from public.services s
  where s.id=p_service and s.workspace_id=v_workspace and s.professional_id=p_professional and s.active;
  if v_duration is null then raise exception 'invalid_service'; end if;
  return query select f.starts_at from private.professional_free_slots(v_workspace,p_professional,p_day,v_duration,0) f
    order by f.starts_at;
end $$;
revoke all on function private.manual_available_slots(uuid,uuid,date) from public,anon,authenticated;
grant execute on function private.manual_available_slots(uuid,uuid,date) to authenticated;

create function public.manual_available_slots(p_professional uuid,p_service uuid,p_day date)
returns table(starts_at timestamptz) language sql security invoker set search_path = '' as $$
  select s.starts_at from private.manual_available_slots(p_professional,p_service,p_day) s;
$$;
revoke all on function public.manual_available_slots(uuid,uuid,date) from public,anon;
grant execute on function public.manual_available_slots(uuid,uuid,date) to authenticated;

-- Alta de un turno manual, todo en una transacción: solicitud (source='manual'), pago si ya se cobró, y turno.
-- El horario tiene que ser uno que el cálculo compartido ofrece: no hay forma de forzar uno fuera de la
-- disponibilidad ni en el pasado. No se encolan emails.
-- p_payment_method null = pago pendiente (sin fila de pago). Con medio, el cobro queda registrado; el importe es
-- el del servicio salvo que venga otro.
create function private.create_manual_appointment(
  p_professional uuid,p_patient uuid,p_service uuid,p_starts_at timestamptz,p_payment_method text,p_amount_minor integer
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_workspace uuid; v_manager boolean;
  v_service public.services%rowtype; v_timezone text; v_day date; v_intent uuid; v_appointment uuid; v_end timestamptz;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  v_workspace := private.manual_booking_workspace(p_professional);
  if v_workspace is null then raise exception 'not_authorized'; end if;
  v_manager := private.has_workspace_role(v_workspace,array['owner','admin','reception']::public.workspace_role[]);
  -- El paciente es del workspace. Un profesional sin rol de gestión solo usa pacientes que ya puede ver:
  -- los que cargó o los que tienen una solicitud con él.
  if not exists(select 1 from public.patients pt where pt.id=p_patient and pt.workspace_id=v_workspace and pt.deleted_at is null
    and (v_manager or pt.created_by=v_user or exists(select 1 from public.booking_intents i
      where i.patient_id=pt.id and i.workspace_id=v_workspace and i.professional_id=p_professional)))
    then raise exception 'invalid_patient'; end if;
  select * into v_service from public.services s
  where s.id=p_service and s.workspace_id=v_workspace and s.professional_id=p_professional and s.active;
  if not found or v_service.currency_code <> 'ARS' then raise exception 'invalid_service'; end if;
  if p_payment_method is null and p_amount_minor is not null then raise exception 'invalid_payment'; end if;
  if p_payment_method is not null and (p_payment_method not in ('cash','transfer','other')
    or coalesce(p_amount_minor,v_service.price_minor) <= 0) then raise exception 'invalid_payment'; end if;
  if p_starts_at is null or p_starts_at <= now() then raise exception 'slot_in_past'; end if;
  select w.timezone into v_timezone from public.workspaces w where w.id=v_workspace;
  v_day := (p_starts_at at time zone v_timezone)::date;
  if not exists(select 1 from private.professional_free_slots(v_workspace,p_professional,v_day,v_service.duration_minutes,0) f
    where f.starts_at=p_starts_at) then raise exception 'slot_unavailable'; end if;
  -- El mismo candado que toma la reserva pública: por profesional y día local. Dos altas simultáneas, manuales
  -- o públicas, esperan una a la otra; por eso el horario se vuelve a validar después de tomarlo.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'bellis:schedule:' || p_professional::text || ':' || pg_catalog.to_char(v_day,'YYYY-MM-DD'),0));
  if not exists(select 1 from private.professional_free_slots(v_workspace,p_professional,v_day,v_service.duration_minutes,0) f
    where f.starts_at=p_starts_at) then raise exception 'slot_unavailable'; end if;
  v_end := p_starts_at + make_interval(mins=>v_service.duration_minutes);
  insert into public.booking_intents(workspace_id,professional_id,service_id,patient_id,status,price_minor,currency_code,duration_minutes,source,created_by)
  values(v_workspace,p_professional,p_service,p_patient,'scheduled',v_service.price_minor,v_service.currency_code,v_service.duration_minutes,'manual',v_user)
  returning id into v_intent;
  if p_payment_method is not null then
    perform private.insert_offline_payment(v_workspace,v_intent,p_payment_method,
      coalesce(p_amount_minor,v_service.price_minor),v_service.currency_code,v_user);
  end if;
  insert into public.appointments(workspace_id,booking_intent_id,professional_id,patient_id,starts_at,ends_at)
  values(v_workspace,v_intent,p_professional,p_patient,p_starts_at,v_end)
  returning id into v_appointment;
  insert into public.audit_events(workspace_id,actor_user_id,action,object_type,object_id)
  values(v_workspace,v_user,'manual_appointment_created','appointment',v_appointment);
  return v_appointment;
end $$;
revoke all on function private.create_manual_appointment(uuid,uuid,uuid,timestamptz,text,integer) from public,anon,authenticated;
grant execute on function private.create_manual_appointment(uuid,uuid,uuid,timestamptz,text,integer) to authenticated;

create function public.create_manual_appointment(
  p_professional uuid,p_patient uuid,p_service uuid,p_starts_at timestamptz,
  p_payment_method text default null,p_amount_minor integer default null
) returns uuid language sql security invoker set search_path = '' as $$
  select private.create_manual_appointment(p_professional,p_patient,p_service,p_starts_at,p_payment_method,p_amount_minor);
$$;
revoke all on function public.create_manual_appointment(uuid,uuid,uuid,timestamptz,text,integer) from public,anon;
grant execute on function public.create_manual_appointment(uuid,uuid,uuid,timestamptz,text,integer) to authenticated;

-- Cobro posterior de un turno manual que quedó pendiente. Solo turnos manuales: los del booking público se
-- cobran por su propio medio. Un turno cancelado no se cobra desde acá.
create function private.record_offline_payment(p_appointment uuid,p_method text,p_amount_minor integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_appointment public.appointments%rowtype; v_intent public.booking_intents%rowtype;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  select * into v_appointment from public.appointments where id=p_appointment;
  if not found or private.manual_booking_workspace(v_appointment.professional_id) is distinct from v_appointment.workspace_id
    then raise exception 'not_authorized'; end if;
  select * into v_intent from public.booking_intents where id=v_appointment.booking_intent_id for update;
  if v_intent.source <> 'manual' then raise exception 'not_manual_appointment'; end if;
  if v_appointment.status not in ('scheduled','completed') then raise exception 'appointment_not_active'; end if;
  return private.insert_offline_payment(v_intent.workspace_id,v_intent.id,p_method,
    coalesce(p_amount_minor,v_intent.price_minor),v_intent.currency_code,v_user);
end $$;
revoke all on function private.record_offline_payment(uuid,text,integer) from public,anon,authenticated;
grant execute on function private.record_offline_payment(uuid,text,integer) to authenticated;

create function public.record_offline_payment(p_appointment uuid,p_method text,p_amount_minor integer default null)
returns uuid language sql security invoker set search_path = '' as $$
  select private.record_offline_payment(p_appointment,p_method,p_amount_minor);
$$;
revoke all on function public.record_offline_payment(uuid,text,integer) from public,anon;
grant execute on function public.record_offline_payment(uuid,text,integer) to authenticated;
