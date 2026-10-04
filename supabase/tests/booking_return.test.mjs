import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutReturnUrls, newResumeToken, resumeAnswer, resumeTokenPattern } from '../functions/_shared/bellis-return.ts';
import { createMercadoPagoCheckout } from '../functions/_shared/bellis-payment.ts';
import { MercadoPagoArgentinaProvider } from '../functions/_shared/mercado-pago.ts';

const now = Date.parse('2026-10-04T12:00:00Z');
const hour = 60 * 60 * 1000;
const checkoutUrl = 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-1';
/** What the server holds for a request, as the resume action reads it. */
const record = (extra = {}) => ({
  intent: { status: 'pending_payment', expires_at: new Date(now + 40 * hour).toISOString(), price_minor: 2500000, currency_code: 'ARS', duration_minutes: 60, service_id: 'service-1', ...extra.intent },
  slug: extra.slug ?? 'ana-lopez', service: { name: 'Consulta', modality: 'online' },
  payment: extra.payment === null ? null : { status: 'pending', checkout_url: checkoutUrl, ...extra.payment },
  appointment: extra.appointment ?? null,
});
const service = { id: 'service-1', name: 'Consulta', modality: 'online', duration_minutes: 60, price_minor: 2500000, currency_code: 'ARS' };

test('the return token is random, opaque and carries nothing about the request', () => {
  const a = newResumeToken(); const b = newResumeToken();
  assert.match(a, resumeTokenPattern);
  assert.notEqual(a, b);
  const urls = checkoutReturnUrls('https://bellis.example', 'ana-lopez', a);
  assert.deepEqual(urls, {
    success: `https://bellis.example/p/ana-lopez?resume=${a}&mp=success`,
    pending: `https://bellis.example/p/ana-lopez?resume=${a}&mp=pending`,
    failure: `https://bellis.example/p/ana-lopez?resume=${a}&mp=failure`,
  });
  for (const url of Object.values(urls)) assert.deepEqual([...new URL(url).searchParams.keys()], ['resume', 'mp']);
});

test('the preference sends the patient back with that token, one address per outcome', async () => {
  const realFetch = globalThis.fetch; let body;
  globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return Response.json({ id: 'pref-1', init_point: checkoutUrl }); };
  try {
    const returnUrls = checkoutReturnUrls('https://bellis.example', 'ana-lopez', 'a'.repeat(64));
    await new MercadoPagoArgentinaProvider('token').createCheckout({ intentId: 'intent-1', serviceId: 'service-1', title: 'Consulta', amountMinor: 2500000,
      currency: 'ARS', environment: 'production', returnUrl: 'https://bellis.example/p/ana-lopez', returnUrls, notificationUrl: 'https://supabase.example/hook' });
    assert.deepEqual(body.back_urls, returnUrls);
    // The request id travels to Mercado Pago as the reference, never in the address the browser comes back to.
    assert.ok(!JSON.stringify(body.back_urls).includes('intent-1'));
  } finally { globalThis.fetch = realFetch; }
});

test('valid token, payment still pending: back to the payment step with the same checkout', () => {
  assert.deepEqual(resumeAnswer(record(), 'ana-lopez', now), { ok: true, body: { step: 'payment', paymentStatus: 'pending', service, checkoutUrl, appointment: null } });
});

test('approved: the schedule opens only when the request is unlocked and the payment on record is approved', () => {
  const paid = resumeAnswer(record({ intent: { status: 'awaiting_schedule' }, payment: { status: 'approved' } }), 'ana-lopez', now);
  assert.deepEqual(paid, { ok: true, body: { step: 'schedule', paymentStatus: 'approved', service, checkoutUrl: null, appointment: null } });
  // A payment marked approved on a request that was never unlocked stays in payment.
  assert.equal(resumeAnswer(record({ payment: { status: 'approved' } }), 'ana-lopez', now).body.step, 'payment');
  // An unlocked request without an approved payment on record is not offered a schedule.
  assert.equal(resumeAnswer(record({ intent: { status: 'awaiting_schedule' }, payment: { status: 'pending' } }), 'ana-lopez', now).ok, false);
});

test('rejected, cancelled or expired payment: still the payment step, with the same checkout to try again', () => {
  for (const status of ['rejected', 'cancelled', 'expired']) {
    const answer = resumeAnswer(record({ payment: { status } }), 'ana-lopez', now);
    assert.deepEqual(answer.body, { step: 'payment', paymentStatus: status, service, checkoutUrl, appointment: null });
  }
});

test('the outcome in the address is not an input: nothing the browser says moves the request forward', () => {
  // resumeAnswer takes the stored record, the page slug and the time. There is no parameter for ?mp=.
  assert.equal(resumeAnswer.length, 3);
  assert.equal(resumeAnswer(record(), 'ana-lopez', now).body.step, 'payment');
});

test('unknown token: nothing is recovered', () => {
  assert.deepEqual(resumeAnswer(null, 'ana-lopez', now), { ok: false, status: 404, body: { error: 'No pudimos recuperar esta reserva.', code: 'invalid' } });
});

test('a token used on another professional\'s page answers exactly like an unknown token', () => {
  const other = resumeAnswer(record({ slug: 'otro-profesional' }), 'ana-lopez', now);
  assert.deepEqual(other, resumeAnswer(null, 'ana-lopez', now));
  assert.ok(!JSON.stringify(other).includes('Consulta'));
  assert.ok(!JSON.stringify(other).includes('mercadopago'));
});

test('an expired request cannot be resumed, and its checkout is not handed out again', () => {
  for (const expires_at of [new Date(now - 1).toISOString(), new Date(now).toISOString(), 'not-a-date']) {
    const answer = resumeAnswer(record({ intent: { expires_at } }), 'ana-lopez', now);
    assert.deepEqual(answer, { ok: false, status: 410, body: { error: 'Esta reserva venció. Empezá de nuevo para elegir un turno.', code: 'expired' } });
  }
});

test('a closed request (cancelled, refunded, completed) is not recovered', () => {
  for (const status of ['cancelled', 'refunded', 'completed'])
    assert.deepEqual(resumeAnswer(record({ intent: { status } }), 'ana-lopez', now), resumeAnswer(null, 'ana-lopez', now));
});

test('an already booked request shows its appointment instead of offering to pay or choose again', () => {
  const appointment = { starts_at: '2026-10-07T13:00:00Z', ends_at: '2026-10-07T14:00:00Z' };
  const answer = resumeAnswer(record({ intent: { status: 'scheduled', expires_at: new Date(now - hour).toISOString() }, payment: { status: 'approved' }, appointment }), 'ana-lopez', now);
  assert.deepEqual(answer.body, { step: 'done', paymentStatus: 'approved', service, checkoutUrl: null, appointment });
});

test('what a returning patient receives has no ids of the workspace, the patient or the payment', () => {
  const body = resumeAnswer(record(), 'ana-lopez', now).body;
  assert.deepEqual(Object.keys(body).sort(), ['appointment', 'checkoutUrl', 'paymentStatus', 'service', 'step']);
  assert.deepEqual(Object.keys(body.service).sort(), ['currency_code', 'duration_minutes', 'id', 'modality', 'name', 'price_minor']);
});

const store = { failures: [], async failRefresh(_workspace, permanent) { this.failures.push(permanent); } };
const account = { seller_user_id: '99912345', access_token: 'APP_USR-access', environment: 'production' };
const order = { intentId: 'intent-1', workspaceId: 'ws-1', serviceId: 'service-1', title: 'Consulta', amountMinor: 2500000, currency: 'ARS',
  returnUrl: 'https://bellis.example/p/ana-lopez', notificationUrl: 'https://supabase.example/hook' };
async function open(answer, saveCheckout) {
  const closed = []; const realFetch = globalThis.fetch; globalThis.fetch = async () => answer();
  try { return { url: await createMercadoPagoCheckout(store, account, order, saveCheckout, async (id) => { closed.push(id); }), closed }; }
  catch (error) { return { error, closed }; } finally { globalThis.fetch = realFetch; }
}

test('a request whose checkout cannot be created is closed, not left waiting for a payment nobody can make', async () => {
  const failed = await open(() => new Response('down', { status: 502 }), async () => {});
  assert.equal(failed.error.message, 'mercado_pago_http_502');
  assert.deepEqual(failed.closed, ['intent-1']);
  // Created at Mercado Pago but not recorded by Bellis: the patient never gets that address, and the request is closed too.
  const unsaved = await open(() => Response.json({ id: 'pref-1', init_point: checkoutUrl }), async () => { throw new Error('checkout_not_saved'); });
  assert.equal(unsaved.error.message, 'checkout_not_saved');
  assert.deepEqual(unsaved.closed, ['intent-1']);
});

test('a checkout that is created and recorded leaves the request open, with its preference and address saved', async () => {
  const saved = [];
  const done = await open(() => Response.json({ id: 'pref-1', init_point: checkoutUrl }), async (preference, url) => { saved.push([preference, url]); });
  assert.equal(done.url, checkoutUrl);
  assert.deepEqual(saved, [['pref-1', checkoutUrl]]);
  assert.deepEqual(done.closed, []);
});
