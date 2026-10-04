-- Coming back from Mercado Pago: the patient may return in another tab, without the token their first tab holds.
-- Each request gets a second opaque token, safe to travel in the return address. Only its SHA-256 is stored.
-- It lives exactly as long as the request and can be used again while the payment is still being settled.
alter table public.booking_intents
  add column resume_token_hash text unique check (resume_token_hash ~ '^[a-f0-9]{64}$');
-- Where the patient pays. Kept so they can go back to the same checkout instead of opening a second one.
alter table public.payments
  add column checkout_url text check (checkout_url is null or
    (length(checkout_url) <= 1000 and checkout_url ~ '^https://(www|sandbox)\.mercadopago\.com(\.ar)?/[^[:space:]]*$'));

-- Records the checkout that was just created for a request: its preference, its address and the return token.
-- One checkout per request: paying again reuses it, so a late payment can never belong to a forgotten preference.
create function public.attach_mercado_pago_checkout(p_intent uuid,p_preference text,p_checkout_url text,p_resume_hash text)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_payment public.payments%rowtype;
begin
  if length(p_preference) not between 3 and 200 or p_resume_hash !~ '^[a-f0-9]{64}$'
    then raise exception 'invalid_checkout'; end if;
  select * into v_payment from public.payments where booking_intent_id=p_intent for update;
  if not found or v_payment.provider<>'mercado_pago_ar' or v_payment.status<>'pending'
    or v_payment.provider_order_id is not null then raise exception 'invalid_payment_state'; end if;
  update public.booking_intents set resume_token_hash=p_resume_hash
    where id=p_intent and status='pending_payment' and expires_at>now();
  if not found then raise exception 'invalid_payment_state'; end if;
  update public.payments set provider_order_id=p_preference,checkout_url=p_checkout_url where id=v_payment.id;
end $$;
revoke all on function public.attach_mercado_pago_checkout(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.attach_mercado_pago_checkout(uuid,text,text,text) to service_role;

-- A request whose checkout could not be created is closed on the spot, and kept: nothing is deleted.
-- Only a request that never had a checkout can be closed this way.
create function public.cancel_unpaid_intent(p_intent uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_workspace uuid;
begin
  update public.booking_intents i set status='cancelled'
  where i.id=p_intent and i.status='pending_payment'
    and exists(select 1 from public.payments p where p.booking_intent_id=i.id
      and p.provider='mercado_pago_ar' and p.status='pending' and p.provider_order_id is null)
  returning i.workspace_id into v_workspace;
  if v_workspace is null then return false; end if;
  update public.payments set status='cancelled' where booking_intent_id=p_intent;
  insert into public.audit_events(workspace_id,action,object_type,object_id)
  values(v_workspace,'checkout_not_created','booking_intent',p_intent);
  return true;
end $$;
revoke all on function public.cancel_unpaid_intent(uuid) from public,anon,authenticated;
grant execute on function public.cancel_unpaid_intent(uuid) to service_role;
