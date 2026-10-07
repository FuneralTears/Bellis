import test from 'node:test';
import assert from 'node:assert/strict';
import { MercadoPagoOAuthError, getValidMercadoPagoAccessToken } from '../functions/_shared/mercado-pago-oauth.ts';
import { createMercadoPagoCheckout, recordVerifiedPayment, withSellerAccount } from '../functions/_shared/bellis-payment.ts';

// The checkout and the webhook as the Edge Functions run them: a valid seller token first, then Mercado Pago.
const config = { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://bellis.example/mercado-pago/callback', testToken: false };
const day = 24 * 60 * 60 * 1000;
const now = () => Date.parse('2026-10-04T12:00:00Z');
const at = (ms) => new Date(now() + ms).toISOString();
const stored = (extra = {}) => ({ accessToken: 'APP_USR-access-old', refreshToken: 'TG-refresh-old', expiresAt: at(90 * day), sellerUserId: '99912345', environment: 'production', ...extra });
function memoryStore(initial) {
  return {
    stored: initial, lease: false, failures: [], status: initial ? 'connected' : 'disconnected',
    async credentials() { return this.status === 'connected' ? this.stored : null; },
    async claimRefresh() { if (this.lease) return false; this.lease = true; return true; },
    async rotate(_workspace, tokens) { this.stored = { ...this.stored, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? this.stored.refreshToken, expiresAt: tokens.expiresAt }; this.lease = false; },
    async failRefresh(_workspace, permanent) { this.failures.push(permanent); this.lease = false; if (permanent) this.status = 'error'; },
  };
}
/** Stands in for Mercado Pago. Records every call so a test can tell which token created which preference. */
function mercadoPago({ refresh, preference, payment, order } = {}) {
  const calls = { refresh: [], preferences: [], payments: [], orders: [] };
  const fetch = async (url, init = {}) => {
    const token = init.headers?.Authorization?.replace('Bearer ', '');
    if (url === 'https://api.mercadopago.com/oauth/token') {
      calls.refresh.push(JSON.parse(init.body));
      await new Promise((resolve) => setTimeout(resolve, 15));
      return refresh ? refresh() : Response.json({ access_token: 'APP_USR-access-new', refresh_token: 'TG-refresh-new', expires_in: 15552000, user_id: 99912345, live_mode: true });
    }
    if (url === 'https://api.mercadopago.com/checkout/preferences') {
      calls.preferences.push({ token, body: JSON.parse(init.body) });
      return preference ? preference(token) : Response.json({ id: `pref-${calls.preferences.length}`, init_point: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=1', sandbox_init_point: 'https://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=1' });
    }
    if (url.startsWith('https://api.mercadopago.com/v1/payments/')) { calls.payments.push({ token, url }); return payment(token); }
    if (url.startsWith('https://api.mercadopago.com/merchant_orders/')) { calls.orders.push({ token, url }); return order ? order(token) : orderAnswer(); }
    throw new Error(`unexpected call to ${url}`);
  };
  return { calls, fetch };
}
// What the server holds for the request. None of it comes from the browser.
const order = { intentId: 'intent-1', workspaceId: 'ws-1', serviceId: 'service-1', title: 'Consulta', amountMinor: 2500000, currency: 'ARS',
  expiresAt: '2026-10-06T12:00:00.000Z', returnUrl: 'https://bellis.example/p/ana', notificationUrl: 'https://supabase.example/functions/v1/bellis-mp-webhook?intent=intent-1' };
/** The checkout exactly as bellis-public runs it. */
async function checkout(store, mp, saved = []) {
  const realFetch = globalThis.fetch; globalThis.fetch = mp.fetch;
  try {
    const account = await getValidMercadoPagoAccessToken(store, config, order.workspaceId, { now, fetch: mp.fetch, sleep: () => new Promise((resolve) => setTimeout(resolve, 10)) });
    return await createMercadoPagoCheckout(store, account, order, async (id) => { saved.push(id); });
  } finally { globalThis.fetch = realFetch; }
}
const noSecrets = (error) => !/APP_USR|TG-|secret-1/.test(`${error.message} ${JSON.stringify(error)}`);

test('checkout with a valid token: one preference, built from the stored request, without renewing', async () => {
  const store = memoryStore(stored()); const mp = mercadoPago(); const saved = [];
  const url = await checkout(store, mp, saved);
  assert.match(url, /^https:\/\/www\.mercadopago\.com\.ar\//);
  assert.equal(mp.calls.refresh.length, 0);
  assert.equal(mp.calls.preferences.length, 1);
  assert.equal(mp.calls.preferences[0].token, 'APP_USR-access-old');
  assert.deepEqual(mp.calls.preferences[0].body, {
    items: [{ id: 'service-1', title: 'Consulta', quantity: 1, currency_id: 'ARS', unit_price: 25000 }],
    external_reference: 'intent-1', notification_url: order.notificationUrl,
    back_urls: { success: order.returnUrl, pending: order.returnUrl, failure: order.returnUrl }, auto_return: 'approved',
    expires: true, expiration_date_to: '2026-10-06T12:00:00.000+00:00',
  });
  assert.deepEqual(saved, ['pref-1']);
});

test('checkout with a token about to expire or expired: renewed first, and the preference uses the new token', async () => {
  for (const expiresAt of [at(day / 2), at(-day)]) {
    const store = memoryStore(stored({ expiresAt })); const mp = mercadoPago();
    await checkout(store, mp);
    assert.deepEqual(mp.calls.refresh, [{ client_id: 'client-1', client_secret: 'secret-1', grant_type: 'refresh_token', refresh_token: 'TG-refresh-old' }]);
    assert.equal(mp.calls.preferences[0].token, 'APP_USR-access-new');
    assert.equal(store.stored.refreshToken, 'TG-refresh-new');
    assert.equal(store.status, 'connected');
  }
});

test('a renewal that brings no new refresh token keeps the one already stored', async () => {
  const store = memoryStore(stored({ expiresAt: at(-day) }));
  const mp = mercadoPago({ refresh: () => Response.json({ access_token: 'APP_USR-access-new', expires_in: 15552000, user_id: 99912345, live_mode: true }) });
  await checkout(store, mp);
  assert.equal(store.stored.accessToken, 'APP_USR-access-new');
  assert.equal(store.stored.refreshToken, 'TG-refresh-old');
});

test('two checkouts at the same time renew once and both use the new token', async () => {
  const store = memoryStore(stored({ expiresAt: at(-day) })); const mp = mercadoPago();
  const realFetch = globalThis.fetch; globalThis.fetch = mp.fetch;
  try {
    const run = async (id) => {
      const account = await getValidMercadoPagoAccessToken(store, config, 'ws-1', { now, fetch: mp.fetch, sleep: () => new Promise((resolve) => setTimeout(resolve, 10)) });
      return createMercadoPagoCheckout(store, account, { ...order, intentId: id }, async () => {});
    };
    await Promise.all([run('intent-1'), run('intent-2')]);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(mp.calls.refresh.length, 1);
  assert.deepEqual(mp.calls.preferences.map((item) => item.token), ['APP_USR-access-new', 'APP_USR-access-new']);
  assert.deepEqual(mp.calls.preferences.map((item) => item.body.external_reference).sort(), ['intent-1', 'intent-2']);
});

test('a renewal Mercado Pago rejects (400, 401) stops the checkout and leaves the connection in error', async () => {
  for (const status of [400, 401]) {
    const store = memoryStore(stored({ expiresAt: at(-day) })); const mp = mercadoPago({ refresh: () => new Response('{"message":"invalid_grant"}', { status }) });
    await assert.rejects(() => checkout(store, mp), (error) => error instanceof MercadoPagoOAuthError && error.permanent && noSecrets(error));
    assert.equal(mp.calls.preferences.length, 0);
    assert.equal(store.status, 'error');
    // From then on the workspace has no usable account until the owner reconnects.
    await assert.rejects(() => checkout(store, mp), /mercado_pago_not_connected/);
  }
});

test('a temporary renewal failure (500) stops an expired checkout without touching the connection, and does not stop a still valid one', async () => {
  const down = () => new Response('down', { status: 500 });
  const expired = memoryStore(stored({ expiresAt: at(-day) })); const mp = mercadoPago({ refresh: down });
  await assert.rejects(() => checkout(expired, mp), (error) => error instanceof MercadoPagoOAuthError && !error.permanent && noSecrets(error));
  assert.equal(mp.calls.preferences.length, 0);
  assert.equal(expired.status, 'connected');
  assert.equal(expired.lease, false);
  const soon = memoryStore(stored({ expiresAt: at(day / 2) })); const mp2 = mercadoPago({ refresh: down });
  await checkout(soon, mp2);
  assert.equal(mp2.calls.preferences[0].token, 'APP_USR-access-old');
});

test('a function deployed without the application settings fails safely instead of marking the account as rejected', async () => {
  const store = memoryStore(stored({ expiresAt: at(-day) })); const mp = mercadoPago();
  const account = () => getValidMercadoPagoAccessToken(store, { ...config, clientSecret: '' }, 'ws-1', { now, fetch: mp.fetch });
  await assert.rejects(account, (error) => error instanceof MercadoPagoOAuthError && !error.permanent && error.message === 'mercado_pago_oauth_not_configured');
  assert.equal(mp.calls.refresh.length, 0);
  assert.equal(store.status, 'connected');
  assert.deepEqual(store.failures, []);
});

test('a renewal that answers for another seller never creates a preference', async () => {
  const store = memoryStore(stored({ expiresAt: at(-day) }));
  const mp = mercadoPago({ refresh: () => Response.json({ access_token: 'APP_USR-access-other', refresh_token: 'TG-refresh-other', expires_in: 100, user_id: 111, live_mode: true }) });
  await assert.rejects(() => checkout(store, mp), /mercado_pago_seller_mismatch/);
  assert.equal(mp.calls.preferences.length, 0);
  assert.equal(store.stored.accessToken, 'APP_USR-access-old');
  assert.equal(store.status, 'error');
});

test('a workspace without a connected account, or disconnected, gets no checkout', async () => {
  const never = memoryStore(null); const mp = mercadoPago();
  await assert.rejects(() => checkout(never, mp), (error) => error.message === 'mercado_pago_not_connected' && noSecrets(error));
  const disconnected = memoryStore(stored()); disconnected.status = 'disconnected';
  await assert.rejects(() => checkout(disconnected, mp), /mercado_pago_not_connected/);
  assert.equal(mp.calls.preferences.length, 0);
  assert.equal(mp.calls.refresh.length, 0);
});

test('a token Mercado Pago no longer accepts marks the connection as failed, and other failures do not', async () => {
  const revoked = memoryStore(stored()); const saved = [];
  await assert.rejects(() => checkout(revoked, mercadoPago({ preference: () => new Response('{"message":"invalid token APP_USR-access-old"}', { status: 401 }) }), saved),
    (error) => error instanceof MercadoPagoOAuthError && error.permanent && error.message === 'mercado_pago_token_rejected' && noSecrets(error));
  assert.equal(revoked.status, 'error');
  assert.deepEqual(saved, []);
  const busy = memoryStore(stored());
  await assert.rejects(() => checkout(busy, mercadoPago({ preference: () => new Response('down', { status: 503 }) })), (error) => error.message === 'mercado_pago_http_503' && noSecrets(error));
  assert.equal(busy.status, 'connected');
});

test('the amount charged is the stored one: nothing in the checkout takes a price, a seller or a workspace from outside', async () => {
  const store = memoryStore(stored()); const mp = mercadoPago();
  const realFetch = globalThis.fetch; globalThis.fetch = mp.fetch;
  try {
    const account = await getValidMercadoPagoAccessToken(store, config, 'ws-1', { now });
    // Extra fields a tampered request might carry are simply not inputs.
    await createMercadoPagoCheckout(store, account, { ...order, price: 1, unit_price: 1, amount: 1, seller_user_id: '111', collector_id: '111' }, async () => {});
  } finally { globalThis.fetch = realFetch; }
  const body = mp.calls.preferences[0].body;
  assert.equal(body.items[0].unit_price, 25000);
  assert.equal(body.items[0].currency_id, 'ARS');
  assert.ok(!JSON.stringify(body).includes('111'));
  assert.equal(mp.calls.preferences[0].token, 'APP_USR-access-old');
});

/** The payments table and the approval RPC, as the webhook sees them. The RPC is idempotent in the database. */
function paymentsDb() {
  const db = { recorded: [], status: 'pending',
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'payment-1', workspace_id: 'ws-1', provider: 'mercado_pago_ar', provider_order_id: 'pref-1', amount_minor: 2500000, currency_code: 'ARS' } }) }) }) }),
    rpc: async (name, args) => { if (db.status !== args.p_status) { db.status = args.p_status; db.recorded.push({ name, args }); } return { error: null }; } };
  return db;
}
const intent = { id: 'intent-1', workspace_id: 'ws-1', price_minor: 2500000, currency_code: 'ARS' };
// As Mercado Pago answers: the payment names its seller and its merchant order; the preference is on the order.
const paymentAnswer = (extra = {}) => Response.json({ id: 123456, external_reference: 'intent-1', collector_id: 99912345, order: { id: 777001, type: 'mercadopago' }, transaction_amount: 25000, currency_id: 'ARS', status: 'approved', ...extra });
function orderAnswer(extra = {}) { return Response.json({ id: 777001, preference_id: 'pref-1', external_reference: 'intent-1', collector: { id: 99912345 }, ...extra }); }
/** The webhook after its signature check, exactly as bellis-mp-webhook runs it. */
async function notify(store, mp, db, eventId = 'webhook:1') {
  const realFetch = globalThis.fetch; globalThis.fetch = mp.fetch;
  try {
    const account = await getValidMercadoPagoAccessToken(store, config, intent.workspace_id, { now, fetch: mp.fetch });
    const payment = await withSellerAccount(store, intent.workspace_id, account, (provider) => provider.getPayment('123456'));
    await recordVerifiedPayment(db, intent, account, payment, eventId);
  } finally { globalThis.fetch = realFetch; }
}

test('webhook: an approved payment is read back with the seller token and recorded with the verified values', async () => {
  const store = memoryStore(stored()); const db = paymentsDb(); const mp = mercadoPago({ payment: () => paymentAnswer() });
  await notify(store, mp, db);
  assert.equal(mp.calls.payments[0].token, 'APP_USR-access-old');
  assert.deepEqual(mp.calls.orders, [{ token: 'APP_USR-access-old', url: 'https://api.mercadopago.com/merchant_orders/777001' }]);
  assert.deepEqual(db.recorded, [{ name: 'record_mercado_pago_payment', args: { p_intent: 'intent-1', p_preference: 'pref-1', p_payment_id: '123456', p_event_id: 'webhook:1', p_status: 'approved', p_amount_minor: 2500000, p_currency: 'ARS' } }]);
});

test('webhook: the same notification twice changes the payment once', async () => {
  const store = memoryStore(stored()); const db = paymentsDb(); const mp = mercadoPago({ payment: () => paymentAnswer() });
  await notify(store, mp, db, 'webhook:1');
  await notify(store, mp, db, 'webhook:1-again');
  assert.equal(db.recorded.length, 1);
});

test('webhook: with an expired token the payment is still verified, after renewing', async () => {
  const store = memoryStore(stored({ expiresAt: at(-day) })); const db = paymentsDb(); const mp = mercadoPago({ payment: () => paymentAnswer() });
  await notify(store, mp, db);
  assert.equal(mp.calls.refresh.length, 1);
  assert.equal(mp.calls.payments[0].token, 'APP_USR-access-new');
  assert.equal(db.recorded.length, 1);
});

test('webhook: a payment for another amount, another seller or another request is never recorded', async () => {
  for (const [extra, orderExtra] of [[{ transaction_amount: 1 }], [{ collector_id: 111 }, { collector: { id: 111 } }],
    [{ external_reference: 'intent-9' }, { external_reference: 'intent-9' }], [{}, { preference_id: 'pref-9' }], [{ currency_id: 'USD' }]]) {
    const store = memoryStore(stored()); const db = paymentsDb();
    await assert.rejects(() => notify(store, mercadoPago({ payment: () => paymentAnswer(extra), order: () => orderAnswer(orderExtra) }), db), /payment_verification_mismatch/);
    assert.equal(db.recorded.length, 0);
  }
});

test('webhook: without a usable account nothing is read or recorded', async () => {
  const db = paymentsDb(); const mp = mercadoPago({ payment: () => paymentAnswer() });
  const disconnected = memoryStore(stored()); disconnected.status = 'disconnected';
  await assert.rejects(() => notify(disconnected, mp, db), /mercado_pago_not_connected/);
  const revoked = memoryStore(stored());
  await assert.rejects(() => notify(revoked, mercadoPago({ payment: () => new Response('{}', { status: 401 }) }), db), /mercado_pago_token_rejected/);
  assert.equal(revoked.status, 'error');
  assert.equal(mp.calls.payments.length, 0);
  assert.equal(db.recorded.length, 0);
});
