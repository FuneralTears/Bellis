import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GoogleCalendarSyncError, googleEventId, googleEventPayload, maxEventGeneration,
  processGoogleCalendarSyncJobs, syncGoogleCalendarEvent,
} from '../functions/_shared/google-calendar-events.ts';

const appointmentId = '123e4567-e89b-12d3-a456-426614174000';
const calendarId = 'turnos@group.calendar.google.com';
const baseJob = (changes = {}) => ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', appointmentId,
  professionalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', calendarId, eventId: null, generation: 0,
  desiredAction: 'upsert', desiredRevision: 1, startsAt: '2026-11-03T13:00:00.000Z',
  endsAt: '2026-11-03T14:00:00.000Z', timeZone: 'America/Argentina/Buenos_Aires', ...changes });
const config = { clientId: 'client', clientSecret: 'secret', redirectUri: 'https://staging.example/google-calendar/callback',
  endpoints: { authorize: 'https://google.test/auth', token: 'https://google.test/token', revoke: 'https://google.test/revoke',
    calendar: 'https://google.test/calendar/v3', jwks: 'https://google.test/jwks' } };
const response = (status, body = {}) => new Response(status === 204 ? null : JSON.stringify(body),
  { status, headers: status === 204 ? {} : { 'content-type': 'application/json' } });
const event = (id, status = 'confirmed') => ({ id, status });
function script(answers) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    let body = null;
    if (init.body) { try { body = JSON.parse(init.body); } catch { body = String(init.body); } }
    calls.push({ url: String(url), method: init.method ?? 'GET', body,
      authorization: init.headers?.Authorization });
    const answer = answers.shift();
    if (!answer) throw new Error('unexpected_call');
    if (answer instanceof Error) throw answer;
    return response(answer.status, typeof answer.body === 'function' ? answer.body(calls.at(-1)) : answer.body);
  };
  return { calls, fetch };
}

test('deterministic ids normalize the appointment UUID and include the generation', () => {
  assert.equal(googleEventId(appointmentId, 0), 'bellis123e4567e89b12d3a456426614174000g0');
  assert.equal(googleEventId(appointmentId.toUpperCase(), 8), 'bellis123e4567e89b12d3a456426614174000g8');
  assert.throws(() => googleEventId('not-a-uuid', 0), /invalid_event_identity/);
});

test('payload is private, timezone-aware and contains no patient fields, names, contact data, reason or notes', () => {
  const payload = googleEventPayload(baseJob(), googleEventId(appointmentId, 0));
  assert.deepEqual({ summary: payload.summary, description: payload.description, location: payload.location,
    attendees: payload.attendees, reminders: payload.reminders, visibility: payload.visibility },
  { summary: 'Turno Bellis', description: '', location: '', attendees: [], reminders: { useDefault: false }, visibility: 'private' });
  assert.equal(payload.start.timeZone, 'America/Argentina/Buenos_Aires');
  assert.equal(payload.start.dateTime, '2026-11-03T13:00:00.000Z');
  const serialized = JSON.stringify(payload).toLowerCase();
  for (const forbidden of ['patient', 'paciente', 'email', 'phone', 'reason', 'notes', 'motivo']) assert.doesNotMatch(serialized, new RegExp(forbidden));
});

test('404 then INSERT creates one event with the deterministic id', async () => {
  const id = googleEventId(appointmentId, 0), fake = script([{ status: 404 }, { status: 200, body: event(id) }]);
  const result = await syncGoogleCalendarEvent(config, baseJob(), 'access-token-valid', { fetch: fake.fetch });
  assert.deepEqual(result, { outcome: 'created', eventId: id, generation: 0 });
  assert.deepEqual(fake.calls.map((call) => call.method), ['GET', 'POST']);
  assert.equal(fake.calls[1].body.id, id);
});

test('an existing active event is updated instead of duplicated', async () => {
  const id = googleEventId(appointmentId, 0), fake = script([{ status: 200, body: event(id) }, { status: 200, body: event(id) }]);
  const result = await syncGoogleCalendarEvent(config, baseJob({ eventId: id }), 'access-token-valid', { fetch: fake.fetch });
  assert.deepEqual(result, { outcome: 'updated', eventId: id, generation: 0 });
  assert.deepEqual(fake.calls.map((call) => call.method), ['GET', 'PUT']);
});

test('a second identical run is idempotent and only updates the same event', async () => {
  const id = googleEventId(appointmentId, 0), fake = script([
    { status: 404 }, { status: 200, body: event(id) }, { status: 200, body: event(id) }, { status: 200, body: event(id) },
  ]);
  const first = await syncGoogleCalendarEvent(config, baseJob(), 'access-token-valid', { fetch: fake.fetch });
  const second = await syncGoogleCalendarEvent(config, baseJob({ eventId: first.eventId }), 'access-token-valid', { fetch: fake.fetch });
  assert.equal(first.outcome, 'created'); assert.equal(second.outcome, 'updated'); assert.equal(first.eventId, second.eventId);
  assert.equal(fake.calls.filter((call) => call.method === 'POST').length, 1);
});

test('DELETE settles 204, 404 and 410 as deleted without recreating anything', async () => {
  const id = googleEventId(appointmentId, 0);
  for (const status of [204, 404, 410]) {
    const fake = script([{ status }]);
    const result = await syncGoogleCalendarEvent(config, baseJob({ desiredAction: 'delete', eventId: id }), 'access-token-valid', { fetch: fake.fetch });
    assert.equal(result.outcome, 'deleted'); assert.deepEqual(fake.calls.map((call) => call.method), ['DELETE']);
  }
});

test('delete before an event was created is a local no-op', async () => {
  const fake = script([]);
  const result = await syncGoogleCalendarEvent(config, baseJob({ desiredAction: 'delete' }), 'access-token-valid', { fetch: fake.fetch });
  assert.deepEqual(result, { outcome: 'deleted', eventId: null, generation: 0 }); assert.equal(fake.calls.length, 0);
});

test('INSERT 409 is never accepted blindly: GET and UPDATE reconcile the winner', async () => {
  const id = googleEventId(appointmentId, 0), fake = script([
    { status: 404 }, { status: 409 }, { status: 200, body: event(id) }, { status: 200, body: event(id) },
  ]);
  const result = await syncGoogleCalendarEvent(config, baseJob(), 'access-token-valid', { fetch: fake.fetch });
  assert.deepEqual(result, { outcome: 'reconciled', eventId: id, generation: 0 });
  assert.deepEqual(fake.calls.map((call) => call.method), ['GET', 'POST', 'GET', 'PUT']);
});

test('two workers racing converge after one creates and the other receives 409', async () => {
  const id = googleEventId(appointmentId, 0), shared = { exists: false, posts: 0 };
  const fetch = async (_url, init = {}) => {
    const method = init.method ?? 'GET';
    if (method === 'GET') return shared.exists ? response(200, event(id)) : response(404);
    if (method === 'POST') { shared.posts++; if (shared.exists) return response(409); shared.exists = true; return response(200, event(id)); }
    if (method === 'PUT') return response(200, event(id));
    return response(500);
  };
  const [one, two] = await Promise.all([syncGoogleCalendarEvent(config, baseJob(), 'token', { fetch }), syncGoogleCalendarEvent(config, baseJob(), 'token', { fetch })]);
  assert.equal(one.eventId, id); assert.equal(two.eventId, id); assert.equal(shared.posts >= 1, true);
});

test('a cancelled tombstone advances generation and creates a fresh id', async () => {
  const old = googleEventId(appointmentId, 0), fresh = googleEventId(appointmentId, 1), fake = script([
    { status: 200, body: event(old, 'cancelled') }, { status: 404 }, { status: 200, body: event(fresh) },
  ]);
  const result = await syncGoogleCalendarEvent(config, baseJob({ eventId: old }), 'token', { fetch: fake.fetch });
  assert.deepEqual(result, { outcome: 'created', eventId: fresh, generation: 1 });
});

test('410 is also a tombstone and advances generation before CREATE', async () => {
  const fresh = googleEventId(appointmentId, 1), fake = script([{ status: 410 }, { status: 404 }, { status: 200, body: event(fresh) }]);
  const result = await syncGoogleCalendarEvent(config, baseJob({ eventId: googleEventId(appointmentId, 0) }), 'token', { fetch: fake.fetch });
  assert.equal(result.eventId, fresh); assert.equal(result.generation, 1);
});

test('generation cap fails closed and never invents an unbounded id', async () => {
  const id = googleEventId(appointmentId, maxEventGeneration), fake = script([{ status: 200, body: event(id, 'cancelled') }]);
  await assert.rejects(syncGoogleCalendarEvent(config, baseJob({ eventId: id, generation: maxEventGeneration }), 'token', { fetch: fake.fetch }),
    (error) => error instanceof GoogleCalendarSyncError && error.message === 'google_event_generation_exhausted' && !error.retryable);
});

for (const status of [429, 500, 503]) test(`HTTP ${status} is recoverable`, async () => {
  const fake = script([{ status, body: { error: { errors: [{ reason: status === 429 ? 'rateLimitExceeded' : 'backendError' }] } } }]);
  await assert.rejects(syncGoogleCalendarEvent(config, baseJob(), 'token', { fetch: fake.fetch }),
    (error) => error instanceof GoogleCalendarSyncError && error.retryable && error.message === `google_calendar_http_${status}`);
});

test('403 rate limit is recoverable but a permission refusal is permanent', async () => {
  const limited = script([{ status: 403, body: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } }]);
  await assert.rejects(syncGoogleCalendarEvent(config, baseJob(), 'token', { fetch: limited.fetch }), (error) => error.retryable);
  const forbidden = script([{ status: 403, body: { error: { errors: [{ reason: 'forbiddenForNonOrganizer' }] } } }]);
  await assert.rejects(syncGoogleCalendarEvent(config, baseJob(), 'token', { fetch: forbidden.fetch }), (error) => !error.retryable);
});

test('network uncertainty is recoverable and cannot be recorded as success', async () => {
  const fake = script([new TypeError('socket closed')]);
  await assert.rejects(syncGoogleCalendarEvent(config, baseJob(), 'token', { fetch: fake.fetch }),
    (error) => error.retryable && error.message === 'google_calendar_unreachable');
});

function connectionStore(changes = {}) {
  const account = { googleSubject: 'subject', status: 'connected', accessToken: 'access-token-valid', refreshToken: 'refresh-token-valid',
    expiresAt: '2026-11-03T15:00:00.000Z', calendarId, ...changes };
  return { account, failures: [], async credentials() { return this.account; }, async claimRefresh() { return true; },
    async rotate(_id, tokens) { this.account = { ...this.account, accessToken: tokens.accessToken, expiresAt: tokens.expiresAt }; },
    async failRefresh(_id, permanent, code) { this.failures.push({ permanent, code }); if (permanent) this.account = { ...this.account, status: 'needs_reconnect' }; },
    async createState() {}, async consumeState() {}, async previous() { return null; }, async saveConnection() {},
    async professionalOf() { return null; }, async disconnect() {} };
}
function resultStore() { return { completed: [], failed: [], async complete(job, result) { this.completed.push({ job, result }); },
  async fail(job, code, retryable) { this.failed.push({ job, code, retryable }); } }; }

test('401 forces one refresh and preserves the job when the renewed token works', async () => {
  const id = googleEventId(appointmentId, 0), connections = connectionStore(), results = resultStore();
  const fake = script([{ status: 401 }, { status: 200, body: { access_token: 'new-access-token-valid', expires_in: 3600,
    scope: 'https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/calendar.freebusy' } },
    { status: 404 }, { status: 200, body: event(id) }]);
  const totals = await processGoogleCalendarSyncJobs([baseJob()], results, connections, config,
    { fetch: fake.fetch, now: () => Date.parse('2026-11-03T12:00:00.000Z') });
  assert.deepEqual(totals, { completed: 1, retried: 0, failed: 0 }); assert.equal(results.completed.length, 1);
  assert.deepEqual(fake.calls.map((call) => call.method), ['GET', 'POST', 'GET', 'POST']);
});

test('invalid_grant marks needs_reconnect and blocks rather than retrying the event forever', async () => {
  const connections = connectionStore({ expiresAt: '2026-11-03T11:00:00.000Z' }), results = resultStore();
  const fake = script([{ status: 400, body: { error: 'invalid_grant' } }]);
  const totals = await processGoogleCalendarSyncJobs([baseJob()], results, connections, config,
    { fetch: fake.fetch, now: () => Date.parse('2026-11-03T12:00:00.000Z') });
  assert.deepEqual(totals, { completed: 0, retried: 0, failed: 1 });
  assert.deepEqual(connections.failures, [{ permanent: true, code: 'google_invalid_grant' }]);
  assert.deepEqual(results.failed.map(({ code, retryable }) => ({ code, retryable })), [{ code: 'google_needs_reconnect', retryable: false }]);
});

test('one failed job does not prevent the next claimed appointment from completing', async () => {
  const other = '223e4567-e89b-12d3-a456-426614174000';
  const connections = connectionStore(), results = resultStore(), fake = script([
    { status: 503 }, { status: 404 }, { status: 200, body: event(googleEventId(other, 0)) },
  ]);
  const totals = await processGoogleCalendarSyncJobs([baseJob(), baseJob({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', appointmentId: other })],
    results, connections, config, { fetch: fake.fetch, now: () => Date.parse('2026-11-03T12:00:00.000Z') });
  assert.deepEqual(totals, { completed: 1, retried: 1, failed: 0 }); assert.equal(results.completed[0].result.eventId, googleEventId(other, 0));
});
