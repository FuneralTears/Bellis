-- H2.5: cancelar un turno manual y decidir qué pasa con su cobro, en una sola operación.
-- No cambia tablas, vistas ni la disponibilidad: el cálculo de horarios, el máximo diario y la restricción de
-- superposición ya cuentan solo turnos 'scheduled' y 'completed', así que un turno cancelado libera su horario.
-- La señal de pago pendiente del CRM (20261014090000) tampoco cuenta turnos cancelados.

-- Solo turnos que cargó el consultorio (source='manual') y que siguen agendados. Un turno ya atendido no se
-- cancela: la sesión ocurrió. Los del booking público tienen su propio circuito de pago y no pasan por acá.
-- p_mode:
--   'no_payment'     cancela sin registrar un cobro nuevo. Si el turno ya tenía un cobro, se conserva tal cual.
--   'record_payment' registra el cobro (por ejemplo, una cancelación tardía que se cobra igual) y cancela.
--                    Exige medio e importe, y que el turno todavía no tenga cobro.
-- Nunca borra ni reembolsa un pago, y no encola avisos.
create function private.cancel_manual_appointment(
  p_appointment uuid,p_mode text,p_payment_method text,p_amount_minor integer
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := (select auth.uid()); v_appointment public.appointments%rowtype; v_intent public.booking_intents%rowtype;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  select * into v_appointment from public.appointments where id=p_appointment;
  if not found or private.manual_booking_workspace(v_appointment.professional_id) is distinct from v_appointment.workspace_id
    then raise exception 'not_authorized'; end if;
  -- La solicitud primero, igual que record_offline_payment: un cobro y una cancelación simultáneos esperan uno
  -- al otro. Después el turno, leído de nuevo, para que dos cancelaciones no pasen las dos.
  select * into v_intent from public.booking_intents where id=v_appointment.booking_intent_id for update;
  select * into v_appointment from public.appointments where id=p_appointment for update;
  if v_intent.source <> 'manual' then raise exception 'not_manual_appointment'; end if;
  if v_appointment.status = 'cancelled' then raise exception 'appointment_already_cancelled'; end if;
  if v_appointment.status <> 'scheduled' then raise exception 'appointment_not_cancellable'; end if;
  if p_mode is null or p_mode not in ('no_payment','record_payment') then raise exception 'invalid_cancel_mode'; end if;
  if p_mode = 'no_payment' then
    if p_payment_method is not null or p_amount_minor is not null then raise exception 'invalid_payment'; end if;
  else
    if p_payment_method is null or p_amount_minor is null then raise exception 'invalid_payment'; end if;
    -- Valida medio e importe, rechaza un segundo cobro ('payment_already_recorded') y audita el cobro.
    perform private.insert_offline_payment(v_intent.workspace_id,v_intent.id,p_payment_method,p_amount_minor,v_intent.currency_code,v_user);
  end if;
  update public.appointments set status='cancelled' where id=v_appointment.id;
  update public.booking_intents set status='cancelled' where id=v_intent.id;
  -- Quién y cuándo. Nada del paciente ni del cobro queda en la auditoría.
  insert into public.audit_events(workspace_id,actor_user_id,action,object_type,object_id)
  values(v_appointment.workspace_id,v_user,'manual_appointment_cancelled','appointment',v_appointment.id);
  return v_appointment.id;
end $$;
revoke all on function private.cancel_manual_appointment(uuid,text,text,integer) from public,anon,authenticated;
grant execute on function private.cancel_manual_appointment(uuid,text,text,integer) to authenticated;

create function public.cancel_manual_appointment(
  p_appointment uuid,p_mode text,p_payment_method text default null,p_amount_minor integer default null
) returns uuid language sql security invoker set search_path = '' as $$
  select private.cancel_manual_appointment(p_appointment,p_mode,p_payment_method,p_amount_minor);
$$;
revoke all on function public.cancel_manual_appointment(uuid,text,text,integer) from public,anon;
grant execute on function public.cancel_manual_appointment(uuid,text,text,integer) to authenticated;
