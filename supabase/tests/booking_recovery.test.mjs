import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingState, paymentCheckError, paymentCheckNote, readSavedBooking, restoreBooking, savedBookingKey, singleFlight, stepForView } from '../../lib/booking-recovery.ts';

// The patient's page after a reload and when the payment is checked: what it asks the server, and what it shows.
const access = 'a'.repeat(64); const resume = 'b'.repeat(64);
const service = { id: 'service-1', name: 'Consulta', modality: 'online', duration_minutes: 60, price_minor: 2500000, currency_code: 'ARS' };
const appointment = { starts_at: '2026-10-09T15:00:00+00:00', ends_at: '2026-10-09T16:00:00+00:00' };
const checkoutUrl = 'https://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-1';
const failure = (status, message) => Object.assign(new Error(message), { status });
/**
 * Stands in for bellis-public, with one request on record. Answers like the function does and counts what
 * would change something: a request created, an appointment created.
 */
function server(state = {}) {
  const held = { status: 'pending_payment', paymentStatus: 'pending', appointment: null, gone: false, down: false, ...state };
  const seen = { calls: [], created: 0, booked: 0 };
  const request = async (action, options = {}) => {
    seen.calls.push(action);
    if (held.down) throw new TypeError('Failed to fetch');
    if (action === 'create_intent') { seen.created++; throw new Error('a reload must never create a request'); }
    if (action === 'status') {
      if (held.gone || ![access, resume].includes(options.token)) throw failure(404, 'La solicitud venció o no existe');
      return { status: held.status, paymentStatus: held.paymentStatus };
    }
    if (action === 'book') {
      if (![access, resume].includes(options.token)) throw failure(404, 'La solicitud venció o no existe');
      if (held.status === 'scheduled') return { appointment: held.appointment };
      // Only a time the server offers creates an appointment. The page never sends one when it is only reading.
      if (Date.parse(options.body.startsAt) > Date.parse('2026-10-07T00:00:00Z')) { seen.booked++; held.status = 'scheduled'; held.appointment = appointment; return { appointment }; }
      throw failure(409, 'Ese horario ya no está disponible. Elegí otro.');
    }
    if (action === 'resume') {
      if (options.body.resume !== resume || options.body.slug !== 'ana-lopez') throw failure(404, 'No pudimos recuperar esta reserva.');
      if (held.gone) throw failure(410, 'Esta reserva venció. Empezá de nuevo para elegir un turno.');
      const step = held.status === 'scheduled' ? 'done' : held.status === 'awaiting_schedule' ? 'schedule' : 'payment';
      return { step, paymentStatus: held.paymentStatus, service, checkoutUrl: step === 'payment' ? checkoutUrl : null, appointment: held.appointment };
    }
    throw new Error(`unexpected action ${action}`);
  };
  return { held, seen, request };
}
const saved = (kind) => ({ token: kind === 'resume' ? resume : access, kind, checkoutUrl, serviceId: 'service-1' });
const scheduled = { status: 'scheduled', paymentStatus: 'approved', appointment };
const unlocked = { status: 'awaiting_schedule', paymentStatus: 'approved' };

test('reload on the confirmation: the same appointment is shown again, with either token, and nothing is created', async () => {
  for (const kind of ['access', 'resume']) {
    const { seen, request } = server(scheduled);
    const view = await restoreBooking(saved(kind), 'ana-lopez', request);
    assert.equal(view.view, 'done', kind);
    assert.deepEqual(view.appointment, appointment, kind);
    assert.equal(view.paymentStatus, 'approved', kind);
    assert.equal(stepForView(view, 0), 5, kind);
    assert.deepEqual([seen.created, seen.booked], [0, 0], kind);
  }
});

test('reload while choosing a time: back to the schedule, without an appointment', async () => {
  for (const kind of ['access', 'resume']) {
    const { held, seen, request } = server(unlocked);
    const view = await restoreBooking(saved(kind), 'ana-lopez', request);
    assert.deepEqual([view.view, view.paymentStatus, stepForView(view, 0)], ['schedule', 'approved', 4], kind);
    assert.deepEqual([seen.created, seen.booked, held.status], [0, 0, 'awaiting_schedule'], kind);
    assert.ok(!seen.calls.includes('book'), kind);
  }
});

test('reload while the payment is pending: back to the payment, still pending, with the same checkout', async () => {
  for (const kind of ['access', 'resume']) {
    const { seen, request } = server();
    const view = await restoreBooking(saved(kind), 'ana-lopez', request);
    assert.deepEqual([view.view, view.paymentStatus, view.checkoutUrl, stepForView(view, 0)], ['payment', 'pending', checkoutUrl, 3], kind);
    assert.deepEqual([seen.created, seen.booked], [0, 0], kind);
  }
});

test('reload: what the tab kept never decides the step, and a request that is gone is not shown', async () => {
  // The tab was on the confirmation, but the server no longer has an appointment for it: the server wins.
  assert.equal((await restoreBooking(saved('access'), 'ana-lopez', server().request)).view, 'payment');
  for (const status of ['cancelled', 'refunded', 'completed'])
    assert.deepEqual(await bookingState(access, server({ status }).request), { view: 'gone', reason: 'invalid' });
  assert.deepEqual(await bookingState(access, server({ gone: true }).request), { view: 'gone', reason: 'expired' });
  assert.equal((await restoreBooking(saved('resume'), 'ana-lopez', server({ gone: true }).request)).reason, 'expired');
  assert.equal((await restoreBooking(saved('resume'), 'otro-profesional', server(scheduled).request)).reason, 'invalid');
  assert.equal((await restoreBooking({ ...saved('access'), token: 'c'.repeat(64) }, 'ana-lopez', server(scheduled).request)).reason, 'expired');
  // The server cannot be asked: nothing is assumed, the page decides what to do with the failure.
  await assert.rejects(() => restoreBooking(saved('access'), 'ana-lopez', server({ down: true }).request), TypeError);
});

test('what the tab keeps: an opaque token and what is needed to draw the screen, nothing else', () => {
  assert.equal(savedBookingKey('ana-lopez'), 'bellis-intent:ana-lopez');
  assert.deepEqual(readSavedBooking(JSON.stringify(saved('resume'))), saved('resume'));
  // What an earlier version of the page wrote is still read.
  assert.deepEqual(readSavedBooking(JSON.stringify({ token: access, checkoutUrl, serviceId: 'service-1' })), saved('access'));
  // Anything else found there (a status, an appointment) is dropped.
  assert.deepEqual(readSavedBooking(JSON.stringify({ ...saved('access'), status: 'scheduled', appointment, paymentStatus: 'approved' })), saved('access'));
  for (const raw of [null, '', 'not json', 'null', '{}', JSON.stringify({ token: 'short' }), JSON.stringify({ token: 42 }), JSON.stringify([access])])
    assert.equal(readSavedBooking(raw), null, String(raw));
});

test('checking the payment while it is pending: the patient is told, and stays on the payment', async () => {
  const view = await bookingState(access, server().request);
  assert.deepEqual(view, { view: 'payment', paymentStatus: 'pending' });
  assert.equal(paymentCheckNote(view), 'El pago todavía está pendiente. Puede demorar unos instantes.');
  assert.equal(stepForView(view, 3), 3);
});

test('checking the payment once it is approved: on to the schedule, with no leftover message', async () => {
  const view = await bookingState(access, server(unlocked).request);
  assert.deepEqual(view, { view: 'schedule', paymentStatus: 'approved' });
  assert.deepEqual([stepForView(view, 3), paymentCheckNote(view)], [4, '']);
});

test('checking the payment when it failed: stays on the payment with that status, so it can be retried', async () => {
  for (const paymentStatus of ['rejected', 'cancelled', 'expired']) {
    const view = await bookingState(access, server({ paymentStatus }).request);
    assert.deepEqual(view, { view: 'payment', paymentStatus });
    // The payment screen already says why and offers to pay again: no "still pending" on top of it.
    assert.deepEqual([stepForView(view, 3), paymentCheckNote(view)], [3, '']);
  }
});

test('checking the payment when another tab already booked: on to that appointment', async () => {
  const { seen, request } = server(scheduled);
  const view = await bookingState(access, request);
  assert.deepEqual(view, { view: 'done', paymentStatus: 'approved', appointment });
  assert.deepEqual([stepForView(view, 3), seen.booked], [5, 0]);
});

test('checking the payment when it cannot be asked: a sentence for the patient, never a technical one', async () => {
  const caught = await bookingState(access, server({ down: true }).request).catch((error) => error);
  assert.equal(paymentCheckError(caught), 'No pudimos consultar el estado del pago. Revisá tu conexión e intentá nuevamente.');
  assert.equal(paymentCheckError(failure(429, 'Intentá nuevamente más tarde')), 'Intentá nuevamente más tarde');
  for (const odd of [null, undefined, 'x', {}, new Error('boom')]) assert.match(paymentCheckError(odd), /^No pudimos consultar/);
});

test('two clicks, or a click during the automatic check: one request, the same answer, then it can be asked again', async () => {
  const { held, seen, request } = server();
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const ask = singleFlight(async () => { await gate; return bookingState(access, request); });
  const first = ask(); const second = ask(); const third = ask();
  assert.equal(first, second); assert.equal(second, third);
  release();
  assert.deepEqual(await Promise.all([first, second, third]), Array(3).fill({ view: 'payment', paymentStatus: 'pending' }));
  assert.equal(seen.calls.length, 1);
  // Once answered, the next click asks again and sees the new state.
  Object.assign(held, unlocked);
  assert.equal((await ask()).view, 'schedule');
  assert.equal(seen.calls.length, 2);
  // A failed check does not leave the button stuck.
  held.down = true;
  await assert.rejects(ask);
  held.down = false;
  assert.equal((await ask()).view, 'schedule');
});

test('an answer that arrives late never takes the patient back a screen', () => {
  assert.equal(stepForView({ view: 'payment', paymentStatus: 'pending' }, 4), 4);
  assert.equal(stepForView({ view: 'schedule', paymentStatus: 'approved' }, 5), 5);
  assert.equal(stepForView({ view: 'gone', reason: 'expired' }, 3), 3);
});

test('reading the appointment back never books: the time sent can never be offered', async () => {
  // Between the status and the read the request is no longer scheduled: the read is refused and nothing is created.
  const { held, seen, request } = server(scheduled);
  const racing = async (action, options) => { const answer = await request(action, options); if (action === 'status') Object.assign(held, unlocked, { appointment: null }); return answer; };
  await assert.rejects(() => bookingState(access, racing), /Ese horario ya no está disponible/);
  assert.deepEqual([seen.booked, held.status], [0, 'awaiting_schedule']);
});
