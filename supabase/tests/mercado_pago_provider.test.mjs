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
