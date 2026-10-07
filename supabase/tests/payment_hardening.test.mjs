import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { answerNotification } from '../functions/_shared/bellis-webhook.ts';
import { recordVerifiedPayment, withSellerAccount } from '../functions/_shared/bellis-payment.ts';
import { bookingAnswer, resumeAnswer } from '../functions/_shared/bellis-return.ts';
import { MercadoPagoArgentinaProvider } from '../functions/_shared/mercado-pago.ts';
import { MercadoPagoOAuthError, completeOAuth, getValidMercadoPagoAccessToken, oauthConfigFromEnv, startOAuth } from '../functions/_shared/mercado-pago-oauth.ts';
import { isPermanentPaymentError, logEntry, patientMessage, paymentErrorCode } from '../functions/_shared/payment-errors.ts';
import { checkoutReturnOrigin, configuredOrigins, isAllowedOrigin } from '../functions/_shared/origin-policy.ts';

// G7A: what happens when things go wrong around a payment. Mercado Pago and the database are stand-ins.
const secret = 'webhook-secret-1';
const intentId = '11111111-1111-4111-8111-111111111111';
const intent = { id: intentId, workspace_id: 'ws-1', price_minor: 2500000, currency_code: 'ARS' };
const account = { seller_user_id: '99912345', access_token: 'APP_USR-access-1', environment: 'production' };
const paid = (extra = {}) => ({ id: '555', preferenceId: 'pref-1', intentId, sellerUserId: '99912345', amountMinor: 2500000, currency: 'ARS', status: 'approved', ...extra });
const nowSeconds = () => String(Math.floor(Date.now() / 1000));

/** A notification as Mercado Pago sends it: signed over the data id, the request id and the timestamp. */
function notification({ dataId = '555', type = 'payment', body, ts = nowSeconds(), key = secret, intentParam = intentId, signature, requestId = 'req-1' } = {}) {
  const v1 = signature ?? createHmac('sha256', key).update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex');
  const url = new URL('https://supabase.example/functions/v1/bellis-mp-webhook');
  if (intentParam) url.searchParams.set('intent', intentParam);
  url.searchParams.set('data.id', dataId); url.searchParams.set('type', type);
  return new Request(url, { method: 'POST', headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body ?? { id: 9001, type, action: 'payment.updated', data: { id: dataId } }) });
}
/** The database and Mercado Pago behind the webhook. Counts what was read and written. */
function world({ payment = paid(), connected = true, lookup, record } = {}) {
  const seen = { intents: 0, accounts: 0, lookups: 0, records: [] };
  let status = 'pending';
  return { seen, deps: {
    async findIntent(id) { seen.intents++; return id === intentId ? intent : null; },
    async account() { seen.accounts++; if (!connected) throw new MercadoPagoOAuthError('mercado_pago_not_connected', true); return account; },
    async getPayment() { seen.lookups++; if (lookup) return lookup(seen.lookups); return payment; },
    async record(_intent, _account, verified, eventId) {
      if (record) return record(verified);
      seen.records.push(eventId);
      // Same rule as the database: a status already on record changes nothing.
      if (status === verified.status) return false; status = verified.status; return true;
    },
  } };
}

test('webhook: a notification that Mercado Pago did not sign is refused with 401 and nothing is read', async () => {
  const forged = [
    notification({ key: 'another-secret' }),
    notification({ signature: 'f'.repeat(64) }),
    notification({ ts: String(Math.floor(Date.now() / 1000) - 3600) }),
    new Request(`https://supabase.example/functions/v1/bellis-mp-webhook?intent=${intentId}&data.id=555`, { method: 'POST', body: '{}' }),
  ];
  for (const request of forged) {
    const { seen, deps } = world();
    const answer = await answerNotification(request, secret, deps);
    assert.equal(answer.status, 401);
    assert.equal(answer.fields.error_code, 'mp_webhook_invalid_signature');
    assert.deepEqual(seen, { intents: 0, accounts: 0, lookups: 0, records: [] });
  }
});

test('webhook: a signature for one payment cannot be replayed for another payment or another request', async () => {
  const ts = nowSeconds();
  const v1 = createHmac('sha256', secret).update(`id:555;request-id:req-1;ts:${ts};`).digest('hex');
  const { seen, deps } = world();
  assert.equal((await answerNotification(notification({ dataId: '777', ts, signature: v1 }), secret, deps)).status, 401);
  // Pointed at another request of the same seller: the payment read back from Mercado Pago does not belong to it.
  const other = world({ record: async () => { throw new Error('payment_verification_mismatch'); } });
  const answer = await answerNotification(notification({ ts, signature: v1 }), secret, other.deps);
  assert.deepEqual([answer.status, answer.event, answer.fields.error_code], [200, 'payment_refused', 'mp_payment_mismatch']);
  assert.equal(seen.lookups, 0);
});

test('config missing: without the webhook secret nothing is trusted, and Mercado Pago is asked to try again', async () => {
  const { seen, deps } = world();
  const answer = await answerNotification(notification(), '', deps);
  assert.deepEqual([answer.status, answer.level, answer.fields.error_code], [503, 'error', 'mp_config_missing']);
  assert.equal(seen.intents, 0);
});

test('webhook: the same notification sent again is answered 200 and recorded once', async () => {
  const { seen, deps } = world();
  const first = await answerNotification(notification(), secret, deps);
  const again = await answerNotification(notification(), secret, deps);
  assert.deepEqual([first.status, first.event, first.fields.changed], [200, 'payment_recorded', true]);
  assert.deepEqual([again.status, again.event, again.fields.changed], [200, 'payment_unchanged', false]);
  assert.deepEqual(seen.records, ['webhook:9001', 'webhook:9001']);
});

test('webhook retry: a passing failure answers 503, and the retry that follows records the payment', async () => {
  for (const failure of ['mercado_pago_http_500', 'mercado_pago_http_429', 'mercado_pago_http_404', 'fetch failed', 'mercado_pago_token_rejected']) {
    const { seen, deps } = world({ lookup: (attempt) => { if (attempt === 1) throw new Error(failure); return paid(); } });
    const first = await answerNotification(notification(), secret, deps);
    assert.deepEqual([first.status, first.event, first.fields.retry], [503, 'payment_deferred', true], failure);
    const retry = await answerNotification(notification(), secret, deps);
    assert.deepEqual([retry.status, retry.event], [200, 'payment_recorded'], failure);
    assert.equal(seen.records.length, 1);
  }
  // The database being down is also temporary.
  const down = world({ record: async () => { throw { message: 'connection refused', code: '08006' }; } });
  assert.equal((await answerNotification(notification(), secret, down.deps)).status, 503);
});

test('disconnect with a payment in flight: the notification is deferred, and recorded after reconnecting', async () => {
  const state = { connected: false, records: 0 };
  const deps = { ...world().deps,
    async account() { if (!state.connected) throw new MercadoPagoOAuthError('mercado_pago_not_connected', true); return account; },
    async record() { state.records++; return true; } };
  const while_ = await answerNotification(notification(), secret, deps);
  assert.deepEqual([while_.status, while_.fields.error_code, while_.fields.retry], [503, 'mp_connection_missing', true]);
  assert.equal(state.records, 0);
  state.connected = true;
  assert.equal((await answerNotification(notification(), secret, deps)).status, 200);
  assert.equal(state.records, 1);
});

test('webhook: a failure no retry can fix is acknowledged, logged and never recorded', async () => {
  for (const [failure, code] of [['payment_verification_mismatch', 'mp_payment_mismatch'], ['payment_mismatch', 'mp_payment_mismatch'],
    ['refund_mismatch', 'mp_payment_mismatch'], ['invalid_mercado_pago_payment', 'mp_payment_mismatch'], ['unsupported_payment_status', 'mp_payment_status_unsupported']]) {
    const { deps } = world({ record: async () => { throw { message: failure }; } });
    const answer = await answerNotification(notification(), secret, deps);
    assert.deepEqual([answer.status, answer.level, answer.event, answer.fields.error_code, answer.fields.retry], [200, 'error', 'payment_refused', code, false]);
  }
});

test('webhook: other topics of the application are acknowledged without touching payments', async () => {
  const { seen, deps } = world();
  const linking = await answerNotification(notification({ dataId: '99912345', type: 'mp-connect', intentParam: '',
    body: { id: 1, type: 'mp-connect', action: 'application.deauthorized', data: { id: '99912345' }, user_id: 99912345 } }), secret, deps);
  assert.deepEqual([linking.status, linking.event, linking.fields.topic, linking.fields.action], [200, 'webhook_ignored', 'mp-connect', 'application.deauthorized']);
  const order = await answerNotification(notification({ dataId: 'ORD01ABC', type: 'order', body: { type: 'order', data: { id: 'ORD01ABC' } } }), secret, deps);
  assert.deepEqual([order.status, order.event], [200, 'webhook_ignored']);
  assert.deepEqual(seen, { intents: 0, accounts: 0, lookups: 0, records: [] });
});

test('webhook: a signed notification that is malformed or names no request never reaches a payment', async () => {
  const { seen, deps } = world();
  assert.equal((await answerNotification(notification({ body: 'not json' }), secret, deps)).status, 400);
  assert.equal((await answerNotification(notification({ body: { type: 'payment', data: { id: '556' } } }), secret, deps)).status, 400);
  for (const intentParam of ['', 'not-a-uuid', '22222222-2222-4222-8222-222222222222']) {
    const answer = await answerNotification(notification({ intentParam }), secret, deps);
    assert.deepEqual([answer.status, answer.event], [200, 'webhook_unroutable']);
  }
  assert.deepEqual([seen.lookups, seen.records.length], [0, 0]);
  assert.equal((await answerNotification(new Request('https://supabase.example/hook'), secret, deps)).status, 405);
});

test('refund: refunds, chargebacks and disputes read from Mercado Pago map to a known status', async () => {
  const realFetch = globalThis.fetch;
  const read = async (status) => {
    globalThis.fetch = async (url) => String(url).includes('/merchant_orders/')
      ? Response.json({ id: 777001, preference_id: 'pref-1', external_reference: intentId, collector: { id: 99912345 } })
      : Response.json({ id: 555, external_reference: intentId, collector_id: 99912345, order: { id: 777001, type: 'mercadopago' }, transaction_amount: 25000, currency_id: 'ARS', status, status_detail: 'partially_refunded' });
    try { return (await new MercadoPagoArgentinaProvider('token').getPayment('555')).status; } finally { globalThis.fetch = realFetch; }
  };
  assert.equal(await read('refunded'), 'refunded');
  assert.equal(await read('charged_back'), 'refunded');
  // A partial refund keeps the payment approved at Mercado Pago, and a dispute is not a refund yet.
  assert.equal(await read('approved'), 'approved');
  assert.equal(await read('in_mediation'), 'pending');
  await assert.rejects(() => read('something_new'), /unsupported_payment_status/);
});

test('refund: a refund is recorded through the same verification and never reopens the request', async () => {
  const calls = [];
  const db = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'pay-1', workspace_id: 'ws-1', provider: 'mercado_pago_ar', provider_order_id: 'pref-1', amount_minor: 2500000, currency_code: 'ARS' }, error: null }) }) }) }),
    rpc: async (name, args) => { calls.push([name, args.p_status, args.p_payment_id]); return { data: true, error: null }; },
  };
  assert.equal(await recordVerifiedPayment(db, intent, account, paid({ status: 'refunded' }), 'webhook:9002'), true);
  assert.deepEqual(calls, [['record_mercado_pago_payment', 'refunded', '555']]);
  // A refund for another seller's payment, or for another amount, is refused before the database is asked.
  await assert.rejects(() => recordVerifiedPayment(db, intent, account, paid({ status: 'refunded', sellerUserId: '1' }), 'e'), /payment_verification_mismatch/);
  await assert.rejects(() => recordVerifiedPayment(db, intent, account, paid({ status: 'refunded', amountMinor: 1 }), 'e'), /payment_verification_mismatch/);
  assert.equal(calls.length, 1);
  // And a refunded request is closed for the patient: the return link answers like one that does not exist.
  const refunded = resumeAnswer({ intent: { status: 'refunded', expires_at: new Date(Date.now() + 1e6).toISOString(), price_minor: 2500000, currency_code: 'ARS', duration_minutes: 60, service_id: 's' },
    slug: 'ana', service: { name: 'Consulta', modality: 'online' }, payment: { status: 'refunded', checkout_url: null }, appointment: { starts_at: 'a', ends_at: 'b' } }, 'ana', Date.now());
  assert.deepEqual([refunded.ok, refunded.status, refunded.body.code], [false, 404, 'booking_resume_invalid']);
});

const resumeRecord = (intentExtra, payment) => ({ intent: { status: 'pending_payment', expires_at: new Date(Date.now() + 3600e3).toISOString(), price_minor: 2500000, currency_code: 'ARS', duration_minutes: 60, service_id: 's', ...intentExtra },
  slug: 'ana', service: { name: 'Consulta', modality: 'online' }, payment, appointment: null });

test('expired request: it is not recovered, whether it is still marked pending or already closed by the cleanup', () => {
  const stale = resumeAnswer(resumeRecord({ expires_at: new Date(Date.now() - 1000).toISOString() }, { status: 'pending', checkout_url: 'https://www.mercadopago.com.ar/x' }), 'ana', Date.now());
  assert.deepEqual([stale.status, stale.body.code], [410, 'booking_resume_expired']);
  const closed = resumeAnswer(resumeRecord({ status: 'cancelled', expires_at: new Date(Date.now() - 1000).toISOString() }, { status: 'expired', checkout_url: 'https://www.mercadopago.com.ar/x' }), 'ana', Date.now());
  assert.deepEqual([closed.status, closed.body.code], [404, 'booking_resume_invalid']);
  assert.equal(JSON.stringify([stale.body, closed.body]).includes('mercadopago'), false);
});

// Late approved payment. The rule itself lives in record_mercado_pago_payment and is exercised case by case (A to E)
// in payment_hardening_smoke.sql; here, what the patient and Mercado Pago get for each state the database can leave.
const approvedPayment = { status: 'approved', checkout_url: 'https://www.mercadopago.com.ar/x' };
const past = () => new Date(Date.now() - 3600e3).toISOString();

test('late payment A: a request paid in time moves to choosing a time, never straight to an appointment', () => {
  const inTime = resumeAnswer(resumeRecord({ status: 'awaiting_schedule', expires_at: new Date(Date.now() + 30 * 86400e3).toISOString() }, approvedPayment), 'ana', Date.now());
  assert.deepEqual([inTime.body.step, inTime.body.appointment, inTime.body.checkoutUrl], ['schedule', null, null]);
  // Unlocked without an approved payment on record is not enough.
  assert.equal(resumeAnswer(resumeRecord({ status: 'awaiting_schedule' }, { status: 'pending', checkout_url: null }), 'ana', Date.now()).ok, false);
});

test('late payment B and C: an approved payment on a request that expired or was cancelled gives the patient nothing to schedule', () => {
  // B: closed for running out of time, then paid. C: cancelled for another reason, then paid.
  for (const expires_at of [past(), new Date(Date.now() + 3600e3).toISOString()]) {
    const closed = resumeAnswer(resumeRecord({ status: 'cancelled', expires_at }, approvedPayment), 'ana', Date.now());
    assert.deepEqual([closed.ok, closed.status, closed.body.code], [false, 404, 'booking_resume_invalid']);
    assert.equal('step' in closed.body || JSON.stringify(closed.body).includes('mercadopago'), false);
  }
  // Even a request the database had (wrongly) left open past its date does not reach the schedule with an approved payment.
  for (const status of ['pending_payment', 'awaiting_schedule']) {
    const stale = resumeAnswer(resumeRecord({ status, expires_at: past() }, approvedPayment), 'ana', Date.now());
    assert.deepEqual([stale.ok, stale.status, stale.body.code], [false, 410, 'booking_resume_expired']);
  }
});

test('late payment D: the webhook acknowledges a late approval once and its duplicates with 200, so Mercado Pago stops sending it', async () => {
  // The database records the late approval (true) and answers false to every repetition.
  let onRecord = false; const recorded = [];
  const { deps } = world({ record: async (verified) => { recorded.push(verified.id); if (onRecord) return false; onRecord = true; return true; } });
  const first = await answerNotification(notification(), secret, deps);
  const again = await answerNotification(notification({ requestId: 'req-2' }), secret, deps);
  assert.deepEqual([first.status, first.event, first.fields.status], [200, 'payment_recorded', 'approved']);
  assert.deepEqual([again.status, again.event, again.fields.changed], [200, 'payment_unchanged', false]);
  assert.deepEqual(recorded, ['555', '555']);
});

test('late payment E: no answer of the booking step turns a closed request into an appointment', () => {
  // schedule_paid_intent refuses a request that is not unlocked, and there is no appointment on record to hand back.
  const refused = bookingAnswer(null, { message: 'payment_not_confirmed' }, null);
  assert.deepEqual([refused.ok, refused.status, refused.code], [false, 403, 'booking_payment_pending']);
});

/** Mercado Pago for one request: the search lists `payments`, each one read back with its merchant order. */
function mercadoPago(payments) {
  return async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/payments/search') return Response.json({ results: Object.keys(payments).map((id) => ({ id: Number(id) })) });
    const order = /^\/merchant_orders\/(\d+)$/.exec(path);
    if (order) return Response.json({ id: Number(order[1]), preference_id: 'pref-1', external_reference: intentId, collector: { id: 99912345 } });
    const found = payments[path.split('/').pop()];
    if (typeof found === 'number') return new Response('', { status: found });
    return Response.json({ external_reference: intentId, collector_id: 99912345, transaction_amount: 25000, currency_id: 'ARS', ...found });
  };
}
async function search(payments) {
  const realFetch = globalThis.fetch; globalThis.fetch = mercadoPago(payments); const skipped = [];
  try { return { found: await new MercadoPagoArgentinaProvider('token').findPayments(intentId, (id, reason) => skipped.push([id, reason.message])), skipped }; }
  finally { globalThis.fetch = realFetch; }
}
const mpApproved = { id: 556, order: { id: 777002, type: 'mercadopago' }, status: 'approved' };

test('several payments: one that fails verification does not stop a valid approved payment of the same request', async () => {
  // A: a rejected payment Mercado Pago returns without its order. B: the approved payment that followed.
  const { found, skipped } = await search({ 555: { id: 555, status: 'rejected' }, 556: mpApproved });
  assert.deepEqual(found.map((item) => [item.id, item.status, item.preferenceId]), [['556', 'approved', 'pref-1']]);
  assert.deepEqual(skipped, [['555', 'invalid_mercado_pago_payment']]);
  // Same for a status Bellis does not know and for an amount that is not money.
  for (const broken of [{ id: 555, order: { id: 777001 }, status: 'something_new' }, { id: 555, order: { id: 777001 }, status: 'rejected', transaction_amount: 'x' }])
    assert.deepEqual((await search({ 555: broken, 556: mpApproved })).found.map((item) => item.id), ['556']);
  // And B still goes through every check before it is recorded: skipping A relaxes nothing for B.
  await assert.rejects(() => recordVerifiedPayment({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'pay-1', workspace_id: 'ws-1', provider: 'mercado_pago_ar', provider_order_id: 'pref-other', amount_minor: 2500000, currency_code: 'ARS' }, error: null }) }) }) }) },
    intent, account, found[0], 'status:556:approved'), /payment_verification_mismatch/);
});

test('several payments: a payment that cannot be read right now is not mistaken for "no approved payment"', async () => {
  // Only invalid payments: nothing to record, and nothing to retry.
  assert.deepEqual((await search({ 555: { id: 555, status: 'rejected' } })).found, []);
  // The unread payment may be the approved one: recording the rejected one would tell the patient to pay again.
  for (const status of [500, 429, 404])
    await assert.rejects(() => search({ 555: { id: 555, order: { id: 777001 }, status: 'rejected' }, 556: status }), new RegExp(`mercado_pago_http_${status}`));
  // With the approved payment verified, the unread one changes nothing.
  assert.deepEqual((await search({ 555: 500, 556: mpApproved })).found.map((item) => item.status), ['approved']);
  // A token Mercado Pago no longer accepts is about the connection: it always surfaces, so the connection is marked.
  await assert.rejects(() => search({ 555: 401, 556: mpApproved }), /mercado_pago_http_401/);
});

test('two tabs: the tab that confirms second receives the appointment that already exists', () => {
  const first = { starts_at: '2026-10-07T13:00:00Z', ends_at: '2026-10-07T14:00:00Z' };
  assert.deepEqual(bookingAnswer(first, null, null), { ok: true, appointment: first });
  // The database refused the second insert (the request is already scheduled, or the unique constraint fired).
  for (const failure of [{ message: 'payment_not_confirmed' }, { message: 'duplicate key value violates unique constraint "appointments_booking_intent_id_key"', code: '23505' }, { message: 'slot_unavailable' }])
    assert.deepEqual(bookingAnswer(null, failure, first), { ok: true, appointment: first });
});

test('two tabs: with no appointment on record, a refusal is told apart by its code and says nothing technical', () => {
  const taken = bookingAnswer(null, { message: 'conflicting key value violates exclusion constraint "appointments_no_overlap"' }, null);
  assert.deepEqual(taken, { ok: false, status: 409, code: 'booking_slot_unavailable', error: 'Ese horario ya no está disponible. Elegí otro.' });
  const unpaid = bookingAnswer(null, { message: 'payment_not_confirmed' }, null);
  assert.deepEqual([unpaid.status, unpaid.code, unpaid.error], [403, 'booking_payment_pending', 'El pago todavía no está confirmado']);
});

const oauth = { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://bellis.example/mercado-pago/callback', testToken: false };
const day = 86400e3; const clockNow = () => Date.parse('2026-10-06T12:00:00Z');
function connection(expiresInMs, refreshToken = 'TG-refresh-old') {
  return { status: 'connected', failures: [], lease: false,
    stored: { accessToken: 'APP_USR-access-old', refreshToken, expiresAt: new Date(clockNow() + expiresInMs).toISOString(), sellerUserId: '99912345', environment: 'production' },
    async credentials() { return this.status === 'connected' ? this.stored : null; },
    async claimRefresh() { if (this.lease) return false; this.lease = true; return true; },
    async rotate(_w, tokens) { this.stored = { ...this.stored, accessToken: tokens.accessToken }; this.lease = false; },
    async failRefresh(_w, permanent) { this.failures.push(permanent); this.lease = false; if (permanent) this.status = 'error'; } };
}
const token = (store, answer, config = oauth) => getValidMercadoPagoAccessToken(store, config, 'ws-1', { now: clockNow, fetch: answer, sleep: async () => {} });

test('connection: Mercado Pago being down or slow never marks the connection as failed', async () => {
  for (const answer of [async () => new Response('down', { status: 503 }), async () => new Response('slow down', { status: 429 }), async () => { throw new TypeError('fetch failed'); }, async () => new Response('<html>', { status: 200 })]) {
    const soon = connection(day / 2);
    assert.equal((await token(soon, answer)).access_token, 'APP_USR-access-old');
    assert.deepEqual([soon.status, soon.failures], ['connected', [false]]);
    // Already expired: this request fails, the connection stays as it was and the next request tries again.
    const gone = connection(-day);
    await assert.rejects(() => token(gone, answer));
    assert.deepEqual([gone.status, gone.failures], ['connected', [false]]);
  }
});

test('connection: Mercado Pago refusing Bellis\'s own credentials is a configuration problem, not a revoked account', async () => {
  for (const [status, error] of [[400, 'invalid_client'], [401, 'invalid_client'], [401, 'unauthorized_client']]) {
    const store = connection(-day);
    await assert.rejects(() => token(store, async () => Response.json({ error, message: 'client_secret APP_USR-echo is wrong' }, { status })),
      (caught) => caught.message === 'mercado_pago_oauth_invalid_client' && caught.permanent === false && paymentErrorCode(caught) === 'mp_config_missing');
    assert.deepEqual([store.status, store.failures], ['connected', [false]]);
  }
});

test('connection: a renewal Mercado Pago rejects for good (revoked, invalid grant) leaves the connection in error', async () => {
  for (const answer of [async () => Response.json({ error: 'invalid_grant' }, { status: 400 }), async () => new Response('', { status: 401 })]) {
    const store = connection(day / 2);
    await assert.rejects(() => token(store, answer), (caught) => caught.permanent === true && paymentErrorCode(caught) === 'mp_refresh_failed');
    assert.deepEqual([store.status, store.failures], ['error', [true]]);
    // From then on there is no usable account until the owner reconnects.
    await assert.rejects(() => token(store, answer), (caught) => paymentErrorCode(caught) === 'mp_connection_missing');
  }
});

test('connection: a token Mercado Pago no longer accepts (revoked from the seller\'s account) marks the connection, other failures do not', async () => {
  const realFetch = globalThis.fetch;
  try {
    const revoked = connection(90 * day);
    globalThis.fetch = async () => new Response('', { status: 401 });
    await assert.rejects(() => withSellerAccount(revoked, 'ws-1', account, (provider) => provider.getPayment('555')), (caught) => paymentErrorCode(caught) === 'mp_connection_revoked');
    assert.equal(revoked.status, 'error');
    for (const status of [403, 404, 429, 500]) {
      const fine = connection(90 * day);
      globalThis.fetch = async () => new Response('', { status });
      await assert.rejects(() => withSellerAccount(fine, 'ws-1', account, (provider) => provider.getPayment('555')));
      assert.deepEqual([fine.status, fine.failures], ['connected', []]);
    }
  } finally { globalThis.fetch = realFetch; }
});

test('connection: expired with nothing to renew it, or with the application settings missing, is told apart', async () => {
  await assert.rejects(() => token(connection(-day, null), async () => { throw new Error('must not be called'); }), (caught) => paymentErrorCode(caught) === 'mp_connection_expired');
  const unset = connection(-day);
  await assert.rejects(() => token(unset, async () => { throw new Error('must not be called'); }, { ...oauth, clientSecret: '' }), (caught) => paymentErrorCode(caught) === 'mp_config_missing');
  assert.deepEqual([unset.status, unset.failures], ['connected', []]);
  assert.equal((await token(connection(day / 2), async () => { throw new Error('must not be called'); }, { ...oauth, clientSecret: '' })).access_token, 'APP_USR-access-old');
});

test('connection: reconnecting reports why a failed attempt failed, without the code or a token', async () => {
  const store = { states: new Map(), saved: 0,
    async createState(userId, hash) { this.states.set(hash, userId); return 'ws-1'; },
    async consumeState(hash, userId) { const owner = this.states.get(hash); this.states.delete(hash); return owner === userId ? 'ws-1' : null; },
    async saveConnection() { this.saved++; } };
  const attempt = async (fetch) => { const reasons = []; const state = new URL(await startOAuth(store, oauth, 'user-a')).searchParams.get('state');
    return { outcome: await completeOAuth(store, oauth, { userId: 'user-a', code: 'TG-code-123456', state }, { fetch, now: clockNow, report: (reason) => reasons.push(reason) }), reasons }; };
  const failed = await attempt(async () => Response.json({ error: 'invalid_grant', message: 'TG-code-123456 already used' }, { status: 400 }));
  assert.deepEqual(failed, { outcome: 'error', reasons: ['mercado_pago_oauth_http_400'] });
  assert.equal(paymentErrorCode({ message: failed.reasons[0] }, 'mp_oauth_exchange_failed'), 'mp_refresh_failed');
  const ok = await attempt(async () => Response.json({ access_token: 'APP_USR-access-new', refresh_token: 'TG-refresh-new', expires_in: 15552000, user_id: 99912345, live_mode: true }));
  assert.deepEqual([ok.outcome, ok.reasons, store.saved], ['connected', [], 1]);
});

test('error codes: every internal failure has a code, and a patient never reads the technical one', () => {
  const cases = { mercado_pago_not_connected: 'mp_connection_missing', mercado_pago_token_expired: 'mp_connection_expired', mercado_pago_token_rejected: 'mp_connection_revoked',
    webhook_secret_missing: 'mp_config_missing', mercado_pago_http_503: 'mp_unavailable', mercado_pago_oauth_http_502: 'mp_unavailable', mercado_pago_oauth_http_400: 'mp_refresh_failed',
    checkout_not_saved: 'mp_preference_failed', payment_mismatch: 'mp_payment_mismatch', unsupported_payment_status: 'mp_payment_status_unsupported' };
  for (const [message, code] of Object.entries(cases)) assert.equal(paymentErrorCode(new Error(message)), code, message);
  assert.equal(paymentErrorCode(new Error('mercado_pago_http_400'), 'mp_preference_failed'), 'mp_preference_failed');
  assert.equal(paymentErrorCode(new Error('mercado_pago_http_404'), 'mp_payment_lookup_failed'), 'mp_payment_lookup_failed');
  assert.equal(paymentErrorCode('anything'), 'internal_error');
  assert.equal(paymentErrorCode(null), 'internal_error');
  assert.equal(isPermanentPaymentError('mp_payment_mismatch'), true);
  assert.equal(isPermanentPaymentError('mp_unavailable'), false);
  for (const code of ['mp_config_missing', 'mp_unavailable', 'mp_connection_missing', 'mp_connection_expired', 'mp_connection_revoked', 'mp_refresh_failed', 'mp_preference_failed', 'mp_payment_lookup_failed', 'mp_payment_mismatch',
    'booking_resume_invalid', 'booking_resume_expired', 'booking_intent_invalid', 'booking_payment_pending', 'booking_payment_rejected', 'booking_slot_unavailable', 'rate_limited', 'internal_error']) {
    const text = patientMessage(code);
    assert.equal(/mp_|booking_|token|oauth|Vault|webhook|[a-z]+_[a-z]+/.test(text), false, `${code}: ${text}`);
    assert.ok(text.length > 10);
  }
  assert.equal(patientMessage('mp_connection_revoked'), patientMessage('mp_unavailable'));
});

test('logs: only known fields with id-like values are written; tokens, codes and bodies never fit', () => {
  const resume = 'a'.repeat(64);
  const entry = logEntry('bellis-public', 'checkout_failed', {
    workspace_id: '11111111-1111-4111-8111-111111111111', intent_id: intentId, payment_id: '555', provider: 'mercado_pago_ar', status: 'approved',
    error_code: 'mp_preference_failed', http_status: 503, retry: true,
    // None of these may come out.
    access_token: 'APP_USR-1234567890-abcdef', refresh_token: 'TG-abcdef', client_secret: 'secret-1', code: 'TG-authorization-code', resume, body: { card: '4509' },
    action: 'APP_USR-1234567890-abcdef', topic: resume, environment: 'TG-refresh-token-value', password: 'hunter2',
  }, () => Date.parse('2026-10-06T12:00:00Z'));
  assert.deepEqual(entry, { ts: '2026-10-06T12:00:00.000Z', fn: 'bellis-public', event: 'checkout_failed',
    workspace_id: '11111111-1111-4111-8111-111111111111', intent_id: intentId, payment_id: '555', provider: 'mercado_pago_ar', status: 'approved',
    error_code: 'mp_preference_failed', http_status: 503, retry: true });
  assert.equal(/APP_USR|TG-|secret-1|hunter2|4509|a{64}/.test(JSON.stringify(entry)), false);
  assert.equal(logEntry('fn', 'an event with\nnew lines {"injected":true}').event, 'unknown');
});

test('logs: what the webhook writes for a failure carries ids and a code, never what Mercado Pago or the database said', async () => {
  const { deps } = world({ lookup: () => { throw new Error('Unexpected token < in JSON: <html>APP_USR-leak TG-leak</html>'); } });
  const answer = await answerNotification(notification(), secret, deps);
  const line = JSON.stringify(logEntry('bellis-mp-webhook', answer.event, answer.fields));
  assert.equal(/APP_USR|TG-|html|Unexpected/.test(line), false);
  assert.deepEqual(Object.keys(answer.fields).sort(), ['error_code', 'http_status', 'intent_id', 'payment_id', 'provider', 'retry', 'workspace_id']);
});

test('cross-environment: a function only trusts and returns to the site it was configured with', () => {
  const staging = 'https://bellis-staging.example'; const production = 'https://bellis.example';
  const origins = configuredOrigins(staging, '');
  assert.equal(isAllowedOrigin(production, origins), false);
  // The patient is sent back to this environment's site even when the request claims another origin.
  assert.equal(checkoutReturnOrigin(production, staging, origins), staging);
  const read = (values) => (name) => values[name];
  // The callback is derived from the same site unless set, so one environment cannot inherit another's.
  assert.equal(oauthConfigFromEnv(read({}), staging).redirectUri, `${staging}/mercado-pago/callback`);
  assert.equal(oauthConfigFromEnv(read({ MERCADO_PAGO_REDIRECT_URI: `${staging}/mercado-pago/callback` }), production).redirectUri.startsWith(staging), true);
  // Test credentials are asked for only when the flag is exactly "true".
  for (const value of [undefined, '', 'false', 'TRUE', '1']) assert.equal(oauthConfigFromEnv(read({ MERCADO_PAGO_OAUTH_TEST_TOKEN: value }), production).testToken, false);
  assert.equal(oauthConfigFromEnv(read({ MERCADO_PAGO_OAUTH_TEST_TOKEN: 'true' }), staging).testToken, true);
});

test('cross-environment: a test connection gets the sandbox checkout and a live one the real checkout, never the other', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id: 'pref-1', init_point: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=1', sandbox_init_point: 'https://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=1' });
  try {
    const open = (environment) => new MercadoPagoArgentinaProvider('token').createCheckout({ intentId: 'i', serviceId: 's', title: 'Consulta', amountMinor: 100, currency: 'ARS', environment, returnUrl: 'https://bellis.example/p/a', notificationUrl: 'https://supabase.example/hook' });
    assert.match((await open('test')).redirectUrl, /^https:\/\/sandbox\.mercadopago\.com\.ar\//);
    assert.match((await open('production')).redirectUrl, /^https:\/\/www\.mercadopago\.com\.ar\//);
  } finally { globalThis.fetch = realFetch; }
});
