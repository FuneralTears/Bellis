alter table public.services add column external_payment_url text;

create function private.validate_service_payment_link()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.external_payment_url is not null and
    (length(new.external_payment_url) > 1000 or new.external_payment_url !~ '^https://[^[:space:]]+$')
    then raise exception 'invalid_payment_link'; end if;
  return new;
end $$;
revoke all on function private.validate_service_payment_link() from public,anon,authenticated;
create trigger service_payment_link_guard before insert or update on public.services
for each row execute function private.validate_service_payment_link();

create or replace function public.create_checkout_intent(
  p_service uuid,p_first_name text,p_last_name text,p_email text,p_phone text,
  p_answers jsonb,p_token_hash text
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_intent uuid; v_workspace public.workspaces%rowtype; v_booking public.booking_intents%rowtype;
  v_service_link text;
begin
  if p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_token_hash'; end if;
  v_intent := public.create_preconsultation_intent(p_service,p_first_name,p_last_name,p_email,p_phone,p_answers);
  select * into v_booking from public.booking_intents where id=v_intent;
  select * into v_workspace from public.workspaces where id=v_booking.workspace_id;
  select external_payment_url into v_service_link from public.services where id=p_service;
  if v_workspace.status='suspended' or (v_workspace.status='trial' and v_workspace.trial_ends_at < now())
    then raise exception 'workspace_unavailable'; end if;
  if v_workspace.payment_provider <> 'external_link'
    or coalesce(v_service_link,v_workspace.external_payment_url) is null
    then raise exception 'payment_not_configured'; end if;
  update public.booking_intents set access_token_hash=p_token_hash where id=v_intent;
  insert into public.payments(workspace_id,booking_intent_id,provider,provider_order_id,amount_minor,currency_code,status)
  values(v_booking.workspace_id,v_intent,'external_link',v_intent::text,v_booking.price_minor,v_booking.currency_code,'pending');
  return v_intent;
end $$;
revoke all on function public.create_checkout_intent(uuid,text,text,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.create_checkout_intent(uuid,text,text,text,text,jsonb,text) to service_role;
