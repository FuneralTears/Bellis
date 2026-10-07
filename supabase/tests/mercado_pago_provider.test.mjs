import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { MercadoPagoArgentinaProvider, verifyMercadoPagoSignature } from '../functions/_shared/mercado-pago.ts';
import { recordVerifiedPayment } from '../functions/_shared/bellis-payment.ts';

test('preference uses the server amount and ARS, with no browser amount argument', async () => {
  const oldFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return Response.json({ id: 'pref-1', sandbox_init_point: 'https://sandbox.mercadopago.com/mla/checkout/pay?pref_id=pref-1' });
  };
  try {
    const provider = new MercadoPagoArgentinaProvider('test-token');
    const checkout = await provider.createCheckout({ intentId: 'intent-1', serviceId: 'service-1', title: 'Consulta',
      amountMinor: 2500000, currency: 'ARS', environment: 'test', returnUrl: 'https://bellis.example/p/test',
      notificationUrl: 'https://supabase.example/functions/v1/bellis-mp-webhook?intent=intent-1' });
    assert.equal(body.items[0].unit_price, 25000);
    assert.equal(body.items[0].currency_id, 'ARS');
    assert.equal(body.external_reference, 'intent-1');
    assert.match(checkout.redirectUrl, /^https:\/\/sandbox\.mercadopago\.com\//);
    await assert.rejects(() => provider.createCheckout({ intentId: 'x', serviceId: 'x', title: 'x',
      amountMinor: 100, currency: 'MXN', environment: 'test', returnUrl: 'https://bellis.example',
      notificationUrl: 'https://supabase.example' }));
  } finally { globalThis.fetch = oldFetch; }
});

test('webhook accepts only a valid Mercado Pago HMAC', async () => {
  const paymentId = '123456';
  const requestId = 'request-1';
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', 'test-secret')
    .update(`id:${paymentId};request-id:${requestId};ts:${ts};`).digest('hex');
  const request = new Request(`https://example.test/webhook?data.id=${paymentId}`, {
    headers: { 'x-request-id': requestId, 'x-signature': `ts=${ts},v1=${signature}` },
  });
  assert.equal(await verifyMercadoPagoSignature(request, 'test-secret'), paymentId);
  assert.equal(await verifyMercadoPagoSignature(request, 'wrong-secret'), null);
});

test('cross-workspace and altered amounts never reach the approval RPC', async () => {
  let calls = 0;
  const db = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: {
      id: 'payment-1', workspace_id: 'workspace-a', provider: 'mercado_pago_ar',
      provider_order_id: 'pref-1', amount_minor: 2500000, currency_code: 'ARS',
    } }) }) }) }),
    rpc: async () => { calls++; return { error: null }; },
  };
  const account = { seller_user_id: 'seller-a', access_token: 'test-token', environment: 'test' };
  const payment = { id: '123', intentId: 'intent-1', preferenceId: 'pref-1', sellerUserId: 'seller-a',
    amountMinor: 2500000, currency: 'ARS', status: 'approved' };
  await assert.rejects(() => recordVerifiedPayment(db, { id: 'intent-1', workspace_id: 'workspace-b',
    price_minor: 2500000, currency_code: 'ARS' }, account, payment, 'event-1'));
  await assert.rejects(() => recordVerifiedPayment(db, { id: 'intent-1', workspace_id: 'workspace-a',
    price_minor: 2500000, currency_code: 'ARS' }, account, { ...payment, amountMinor: 1 }, 'event-2'));
  assert.equal(calls, 0);
});

// A payment as Mercado Pago answers GET /v1/payments/{id}: the seller in `collector_id`, the merchant order in `order`,
// and no preference. The preference is read from GET /merchant_orders/{order.id}.
const realPayment = (extra = {}) => ({ id: 123456, status: 'approved', status_detail: 'accredited', currency_id: 'ARS',
  collector_id: 99912345, order: { id: 777001, type: 'mercadopago' }, external_reference: 'intent-1',
  transaction_amount: 25000, live_mode: false, ...extra });
const realOrder = (extra = {}) => ({ id: 777001, preference_id: 'pref-1', external_reference: 'intent-1',
  collector: { id: 99912345, nickname: 'TESTUSER' }, payments: [{ id: 123456, status: 'approved' }], is_test: true, ...extra });
/** Reads payment 123456 against a stand-in for Mercado Pago, and says which addresses were called. */
async function readPayment(payment = realPayment(), order = realOrder()) {
  const oldFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url).replace('https://api.mercadopago.com', ''));
    if (String(url).includes('/merchant_orders/')) return order === null ? new Response('{}', { status: 404 }) : Response.json(order);
    return Response.json(payment);
  };
  try { return { payment: await new MercadoPagoArgentinaProvider('test-token').getPayment('123456'), calls }; }
  finally { globalThis.fetch = oldFetch; }
}
/** The stored payment and the recording RPC, with the transitions the database applies. */
function storedPayment() {
  const db = { status: 'pending', intentStatus: 'pending_payment', calls: 0,
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'payment-1', workspace_id: 'ws-1',
      provider: 'mercado_pago_ar', provider_order_id: 'pref-1', amount_minor: 2500000, currency_code: 'ARS' } }) }) }) }),
    rpc: async (_name, args) => {
      db.calls++;
      if (db.status === args.p_status || db.status === 'approved') return { data: false, error: null };
      db.status = args.p_status;
      if (args.p_status === 'approved') db.intentStatus = 'awaiting_schedule';
      return { data: true, error: null };
    } };
  return db;
}
const bookingIntent = { id: 'intent-1', workspace_id: 'ws-1', price_minor: 2500000, currency_code: 'ARS' };
const seller = { seller_user_id: '99912345', access_token: 'test-token', environment: 'test' };
/** Reads the payment and records it, as the webhook and the status check do. */
async function verifyAndRecord(db, payment, order) {
  const read = await readPayment(payment, order);
  await recordVerifiedPayment(db, bookingIntent, seller, read.payment, 'webhook:1');
}

test('getPayment: a payment shaped as Mercado Pago sends it is read, with the seller from collector_id', async () => {
  const { payment, calls } = await readPayment();
  assert.deepEqual(payment, { id: '123456', preferenceId: 'pref-1', intentId: 'intent-1', sellerUserId: '99912345',
    amountMinor: 2500000, currency: 'ARS', status: 'approved' });
  assert.deepEqual(calls, ['/v1/payments/123456', '/merchant_orders/777001']);
});

test('getPayment: the preference comes from the merchant order of the payment', async () => {
  assert.equal((await readPayment(realPayment(), realOrder({ preference_id: 'pref-from-order' }))).payment.preferenceId, 'pref-from-order');
  // A preference in the payment itself, which Mercado Pago does not send, is never taken instead.
  assert.equal((await readPayment(realPayment({ preference_id: 'pref-forged' }))).payment.preferenceId, 'pref-1');
});

test('getPayment: without a seller, an order or a preference the payment is not verified', async () => {
  for (const payment of [realPayment({ collector_id: undefined }), realPayment({ collector_id: null }), realPayment({ collector_id: { id: 99912345 } }),
    realPayment({ order: undefined }), realPayment({ order: {} }), realPayment({ order: { id: 'abc' } }),
    realPayment({ order: { id: 777001, type: 'mercadolibre' } }), realPayment({ external_reference: null })])
    await assert.rejects(() => readPayment(payment), /^Error: invalid_mercado_pago_payment$/);
  for (const order of [realOrder({ preference_id: undefined }), realOrder({ preference_id: null }), realOrder({ preference_id: '' }),
    realOrder({ id: 999 }), realOrder({ collector: { id: 111 } }), realOrder({ external_reference: 'intent-9' }), {}])
    await assert.rejects(() => readPayment(realPayment(), order), /^Error: invalid_mercado_pago_payment$/);
  // An order Mercado Pago does not return leaves the payment unread.
  await assert.rejects(() => readPayment(realPayment(), null), /^Error: mercado_pago_http_404$/);
});

test('verification: another seller, amount, currency, request or preference never reaches the recording', async () => {
  const cases = {
    seller: [realPayment({ collector_id: 111 }), realOrder({ collector: { id: 111 } })],
    amount: [realPayment({ transaction_amount: 1 }), realOrder()],
    currency: [realPayment({ currency_id: 'USD' }), realOrder()],
    request: [realPayment({ external_reference: 'intent-9' }), realOrder({ external_reference: 'intent-9' })],
    preference: [realPayment(), realOrder({ preference_id: 'pref-9' })],
  };
  for (const [name, [payment, order]] of Object.entries(cases)) {
    const db = storedPayment();
    await assert.rejects(() => verifyAndRecord(db, payment, order), /payment_verification_mismatch/, name);
    assert.deepEqual([db.calls, db.status, db.intentStatus], [0, 'pending', 'pending_payment'], name);
  }
  const db = storedPayment();
  await assert.rejects(() => verifyAndRecord(db, realPayment(), realOrder({ preference_id: undefined })), /invalid_mercado_pago_payment/);
  assert.deepEqual([db.calls, db.status], [0, 'pending']);
});

test('recording: approved unlocks the request, rejected is recorded as rejected, pending stays pending', async () => {
  const approved = storedPayment();
  await verifyAndRecord(approved, realPayment());
  assert.deepEqual([approved.status, approved.intentStatus], ['approved', 'awaiting_schedule']);
  const rejected = storedPayment();
  await verifyAndRecord(rejected, realPayment({ status: 'rejected', status_detail: 'cc_rejected_other_reason' }));
  assert.deepEqual([rejected.status, rejected.intentStatus], ['rejected', 'pending_payment']);
  // A first attempt rejected and a second one approved, as in the sandbox: the request is unlocked.
  await verifyAndRecord(rejected, realPayment());
  assert.deepEqual([rejected.status, rejected.intentStatus], ['approved', 'awaiting_schedule']);
  for (const status of ['pending', 'in_process', 'authorized']) {
    const pending = storedPayment();
    await verifyAndRecord(pending, realPayment({ status, status_detail: 'pending_contingency' }));
    assert.deepEqual([pending.status, pending.intentStatus], ['pending', 'pending_payment'], status);
  }
});
