-- create_checkout_intent is SECURITY INVOKER and runs as the trusted service role.
grant usage on schema private to service_role;
grant select on private.mercado_pago_accounts to service_role;
