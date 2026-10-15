import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  GoogleOAuthError, authorizationUrl, calendarName, completeGoogleOAuth, disconnectGoogle, getValidGoogleAccessToken, googleOAuthConfigFromEnv,
  googleScopes, missingGoogleConfig, pkceChallenge, redirectProblem, sha256Hex, startGoogleOAuth,
} from '../functions/_shared/google-calendar-oauth.ts';

const appCreated = 'https://www.googleapis.com/auth/calendar.app.created';
const freeBusy = 'https://www.googleapis.com/auth/calendar.freebusy';
const allScopes = `openid ${appCreated} ${freeBusy} https://www.googleapis.com/auth/userinfo.email`;
const now = () => Date.parse('2026-10-14T12:00:00Z');
const at = (ms) => new Date(now() + ms).toISOString();
const minute = 60 * 1000;

/**
 * Google, answered locally: the token endpoint (code exchange and renewal), revocation and the two calendar calls Bellis
 * makes. `script` decides each answer; every request is recorded, with its form or JSON body.
 */
async function fakeGoogle(t, script = {}) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const type = request.headers['content-type'] ?? '';
    const body = type.includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
    const call = { method: request.method, path: request.url, body, auth: request.headers.authorization ?? null };
    calls.push(call);
    const route = request.url === '/token' ? script.token ?? (() => tokenAnswer())
      : request.url === '/revoke' ? script.revoke ?? (() => ({ status: 200, body: {} }))
      : request.method === 'POST' && request.url === '/calendar/calendars' ? script.create ?? (() => ({ status: 200, body: { id: 'new-cal@group.calendar.google.com', summary: call.body.summary, timeZone: call.body.timeZone } }))
      : request.method === 'GET' && request.url.startsWith('/calendar/calendars/') ? script.get ?? (() => ({ status: 404, body: { error: { code: 404 } } }))
      : () => ({ status: 404, body: {} });
    const answer = await route(call);
    response.writeHead(answer.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = { clientId: 'client-1.apps.googleusercontent.com', clientSecret: 'secret-1', redirectUri: 'http://localhost:5173/google-calendar/callback',
    endpoints: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: `${base}/token`, revoke: `${base}/revoke`, calendar: `${base}/calendar` } };
  return { calls, config, of: (path) => calls.filter((call) => call.path === path || call.path.startsWith(`${path}/`)) };
}
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const idToken = (claims = {}) => `${b64({ alg: 'RS256' })}.${b64({ iss: 'https://accounts.google.com', aud: 'client-1.apps.googleusercontent.com', sub: '1098765', email: 'qa@example.test', email_verified: true, exp: now() / 1000 + 3600, ...claims })}.signature`;
function tokenAnswer({ refresh = 'refresh-token-new-0001', scope = allScopes, claims, idTokenValue } = {}) {
  return { status: 200, body: { access_token: 'access-token-new-0001', expires_in: 3599, token_type: 'Bearer', scope, ...(refresh ? { refresh_token: refresh } : {}), id_token: idTokenValue ?? idToken(claims) } };
}

/** The database's rules, in memory: a state belongs to the person who started it, works once, and expires. */
function memoryStore({ account = null, available = 'yes' } = {}) {
  const store = {
    professionals: { 'user-a': 'pro-a', 'user-b': 'pro-b' }, states: new Map(), account, saved: [], rotated: [], failures: [], disconnects: [], lease: false, claims: 0,
    async createState(userId, stateHash, codeVerifier) {
      const professionalId = this.professionals[userId];
      if (!professionalId) throw new Error('not_authorized');
      if (available !== 'yes') throw new Error(available);
      this.states.set(stateHash, { professionalId, userId, codeVerifier, expiresAt: now() + 10 * minute, consumed: false });
      return { hasRefreshToken: this.account?.status === 'connected' && !!this.account.refreshToken };
    },
    async consumeState(stateHash, userId) {
      const flow = this.states.get(stateHash);
      if (!flow || flow.consumed || flow.expiresAt <= now()) return null;
      flow.consumed = true; const verifier = flow.codeVerifier; flow.codeVerifier = null;
      return flow.userId === userId ? { workspaceId: 'ws-a', professionalId: flow.professionalId, codeVerifier: verifier } : null;
    },
    async previous() { return this.account ? { googleSubject: this.account.googleSubject, calendarId: this.account.calendarId, status: this.account.status, hasRefreshToken: !!this.account.refreshToken } : null; },
    async credentials() { return this.account?.accessToken ? { ...this.account } : null; },
    async saveConnection(professionalId, userId, connection) {
      if (this.professionals[userId] !== professionalId) throw new Error('not_authorized');
      if (available !== 'yes') throw new Error(available);
      const same = this.account?.googleSubject === connection.subject;
      if (!connection.tokens.refreshToken && !(same && this.account?.refreshToken)) throw new Error('google_refresh_token_missing');
      this.saved.push(connection);
      this.account = { googleSubject: connection.subject, status: 'connected', accessToken: connection.tokens.accessToken,
        refreshToken: connection.tokens.refreshToken ?? this.account.refreshToken, expiresAt: connection.tokens.expiresAt, calendarId: connection.calendarId };
    },
    async claimRefresh() { this.claims++; if (this.lease) return false; this.lease = true; return true; },
    async rotate(_id, tokens) { this.rotated.push(tokens); this.account = { ...this.account, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? this.account.refreshToken, expiresAt: tokens.expiresAt }; this.lease = false; },
    async failRefresh(_id, permanent, code) { this.failures.push({ permanent, code }); this.lease = false; if (permanent) this.account = { ...this.account, status: 'needs_reconnect', accessToken: null, refreshToken: null }; },
    async professionalOf(userId) { return this.professionals[userId] ?? null; },
    async disconnect(userId, revoked) { this.disconnects.push({ userId, revoked }); this.account = this.account && { ...this.account, status: 'disconnected', accessToken: null, refreshToken: null }; },
  };
  return store;
}
const connected = (extra = {}) => ({ googleSubject: '1098765', status: 'connected', accessToken: 'access-token-old-0001', refreshToken: 'refresh-token-old-0001', expiresAt: at(50 * minute), calendarId: 'old-cal@group.calendar.google.com', ...extra });
const stateOf = (url) => new URL(url).searchParams.get('state');
async function startAndReturn(store, config, userId = 'user-a') { return stateOf(await startGoogleOAuth(store, config, userId)); }
const finish = (store, config, state, clock = {}, userId = 'user-a') => completeGoogleOAuth(store, config, { userId, code: '4/0Acode', state }, { now, ...clock });

test('start: exactly the four scopes, offline, PKCE S256, a random state stored only as its hash, and consent when Bellis holds no refresh token', async (t) => {
  const { config } = await fakeGoogle(t);
  const store = memoryStore();
  const url = new URL(await startGoogleOAuth(store, config, 'user-a'));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual(url.searchParams.get('scope').split(' '), ['openid', 'email', appCreated, freeBusy]);
  assert.deepEqual([...googleScopes], ['openid', 'email', appCreated, freeBusy]);
  assert.doesNotMatch(url.searchParams.get('scope'), /profile|auth\/calendar(\s|$)|calendar\.events|calendar\.readonly/);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('prompt'), 'select_account consent');
  assert.equal(url.searchParams.get('include_granted_scopes'), null);
  const state = url.searchParams.get('state');
  assert.match(state, /^[a-f0-9]{64}$/);
  const [[hash, flow]] = [...store.states];
  assert.equal(hash, await sha256Hex(state));
  assert.match(flow.codeVerifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(url.searchParams.get('code_challenge'), await pkceChallenge(flow.codeVerifier));
  assert.ok(!url.toString().includes('secret-1') && !url.toString().includes(flow.codeVerifier));
  assert.notEqual(state, await startAndReturn(store, config));
  // A working refresh token is already stored: Google is not asked for consent again.
  const again = memoryStore({ account: connected() });
  assert.equal(new URL(await startGoogleOAuth(again, config, 'user-a')).searchParams.get('prompt'), 'select_account');
  assert.equal(new URL(authorizationUrl(config, state, 'challenge', { consent: true })).searchParams.get('prompt'), 'select_account consent');
});

test('start: the database decides who may connect; nothing reaches Google when it refuses', async (t) => {
  const google = await fakeGoogle(t);
  await assert.rejects(startGoogleOAuth(memoryStore(), google.config, 'nobody'), /not_authorized/);
  await assert.rejects(startGoogleOAuth(memoryStore({ available: 'pro_access_required' }), google.config, 'user-a'), /pro_access_required/);
  await assert.rejects(startGoogleOAuth(memoryStore({ available: 'feature_not_enabled' }), google.config, 'user-a'), /feature_not_enabled/);
  assert.equal(google.calls.length, 0);
});

test('complete, first connection: the code is exchanged with the verifier, "Turnos Bellis" is created and everything is saved', async (t) => {
  const google = await fakeGoogle(t);
  const store = memoryStore();
  const state = await startAndReturn(store, google.config);
  const verifier = [...store.states.values()][0].codeVerifier;
  assert.equal(await finish(store, google.config, state), 'connected');
  const [exchange] = google.of('/token');
  assert.deepEqual(exchange.body, { client_id: google.config.clientId, client_secret: 'secret-1', grant_type: 'authorization_code', code: '4/0Acode', redirect_uri: google.config.redirectUri, code_verifier: verifier });
  // Bellis never lists calendars: nothing was stored, so it creates one.
  assert.equal(google.calls.filter((call) => call.method === 'GET').length, 0);
  const [create] = google.of('/calendar/calendars');
  assert.equal(create.method, 'POST'); assert.equal(create.auth, 'Bearer access-token-new-0001');
  assert.equal(create.body.summary, calendarName); assert.equal(calendarName, 'Turnos Bellis'); assert.equal(create.body.timeZone, 'America/Argentina/Buenos_Aires');
  const [saved] = store.saved;
  assert.equal(saved.subject, '1098765'); assert.equal(saved.email, 'qa@example.test');
  assert.equal(saved.calendarId, 'new-cal@group.calendar.google.com'); assert.equal(saved.calendarTimeZone, 'America/Argentina/Buenos_Aires');
  assert.equal(saved.tokens.refreshToken, 'refresh-token-new-0001'); assert.ok(saved.tokens.scopes.includes(appCreated) && saved.tokens.scopes.includes(freeBusy));
  assert.equal(saved.tokens.expiresAt, at(3599 * 1000));
  assert.equal(google.of('/revoke').length, 0);
  // The verifier is gone with the state: the same return cannot be replayed.
  assert.equal([...store.states.values()][0].codeVerifier, null);
  assert.equal(await finish(store, google.config, state), 'invalid_state');
});

test('complete, reconnecting the same Google account: its stored calendar is reused, and the stored refresh token is kept when Google sends none', async (t) => {
  const google = await fakeGoogle(t, { token: () => tokenAnswer({ refresh: null }), get: (call) => ({ status: 200, body: { id: decodeURIComponent(call.path.split('/').pop()), timeZone: 'America/Argentina/Cordoba' } }) });
  const store = memoryStore({ account: connected() });
  assert.equal(await finish(store, google.config, await startAndReturn(store, google.config)), 'connected');
  assert.deepEqual(google.calls.filter((call) => call.path.startsWith('/calendar')).map((call) => `${call.method} ${decodeURIComponent(call.path)}`), ['GET /calendar/calendars/old-cal@group.calendar.google.com']);
  assert.equal(store.saved[0].calendarId, 'old-cal@group.calendar.google.com'); assert.equal(store.saved[0].calendarTimeZone, 'America/Argentina/Cordoba');
  assert.equal(store.saved[0].tokens.refreshToken, null);
  assert.equal(store.account.refreshToken, 'refresh-token-old-0001');
  assert.equal(google.of('/revoke').length, 0, 'the account stays connected: nothing is revoked');
});

test('complete: a stored calendar that no longer exists (404) is replaced by a new one; any other failure stops the connection', async (t) => {
  const google = await fakeGoogle(t, { get: () => ({ status: 404, body: { error: { code: 404 } } }) });
  const store = memoryStore({ account: { ...connected(), status: 'disconnected', accessToken: null, refreshToken: null } });
  assert.equal(await finish(store, google.config, await startAndReturn(store, google.config)), 'connected');
  assert.deepEqual(google.calls.filter((call) => call.path.startsWith('/calendar')).map((call) => call.method), ['GET', 'POST']);
  assert.equal(store.saved[0].calendarId, 'new-cal@group.calendar.google.com');

  const failing = await fakeGoogle(t, { get: () => ({ status: 500, body: {} }) });
  const other = memoryStore({ account: { ...connected(), status: 'disconnected', accessToken: null, refreshToken: null } });
  let reason = '';
  assert.equal(await finish(other, failing.config, await startAndReturn(other, failing.config), { report: (value) => { reason = value; } }), 'error');
  assert.equal(reason, 'google_calendar_http_500');
  assert.equal(other.saved.length, 0); assert.equal(failing.of('/calendar/calendars').filter((call) => call.method === 'POST').length, 0);
  assert.equal(failing.of('/revoke').length, 1, 'the new grant is handed back');
});

test('complete, another Google account: a new calendar is created (the old id belongs to the other account) and the old authorization is revoked', async (t) => {
  const google = await fakeGoogle(t, { token: () => tokenAnswer({ claims: { sub: '2222222', email: 'otra@example.test' } }) });
  const store = memoryStore({ account: connected() });
  assert.equal(await finish(store, google.config, await startAndReturn(store, google.config)), 'connected');
  assert.equal(google.calls.filter((call) => call.method === 'GET').length, 0);
  assert.equal(store.saved[0].subject, '2222222'); assert.equal(store.saved[0].calendarId, 'new-cal@group.calendar.google.com');
  assert.deepEqual(google.of('/revoke').map((call) => call.body.token), ['refresh-token-old-0001']);
});

test('complete: without both calendar scopes nothing is saved and the new grant is revoked', async (t) => {
  for (const scope of [`openid ${appCreated}`, `openid ${freeBusy}`, 'openid']) {
    const google = await fakeGoogle(t, { token: () => tokenAnswer({ scope }) });
    const store = memoryStore();
    assert.equal(await finish(store, google.config, await startAndReturn(store, google.config)), 'scopes_missing');
    assert.equal(store.saved.length, 0);
    assert.equal(google.of('/calendar').length + google.calls.filter((call) => call.path.startsWith('/calendar')).length, 0);
    assert.deepEqual(google.of('/revoke').map((call) => call.body.token), ['refresh-token-new-0001']);
  }
  // The same account is still connected with its earlier grant: revoking would cut that one too, so it is left alone.
  const google = await fakeGoogle(t, { token: () => tokenAnswer({ scope: 'openid', refresh: null }) });
  const store = memoryStore({ account: connected() });
  assert.equal(await finish(store, google.config, await startAndReturn(store, google.config)), 'scopes_missing');
  assert.equal(google.of('/revoke').length, 0);
});

test('complete: no refresh token from Google and none stored for that account is an error, never a half connection', async (t) => {
  const google = await fakeGoogle(t, { token: () => tokenAnswer({ refresh: null }) });
  const store = memoryStore({ account: connected({ googleSubject: '999', status: 'needs_reconnect', refreshToken: null, accessToken: null }) });
  let reason = '';
  assert.equal(await finish(store, google.config, await startAndReturn(store, google.config), { report: (value) => { reason = value; } }), 'error');
  assert.equal(reason, 'google_refresh_token_missing');
  assert.equal(store.saved.length, 0);
  assert.equal(google.calls.filter((call) => call.path.startsWith('/calendar')).length, 0);
  assert.deepEqual(google.of('/revoke').map((call) => call.body.token), ['access-token-new-0001']);
});

test('complete: an ID token for another client, another issuer, or expired is refused', async (t) => {
  for (const claims of [{ aud: 'someone-else' }, { iss: 'https://evil.example' }, { exp: now() / 1000 - 3600 }, { sub: '' }]) {
    const google = await fakeGoogle(t, { token: () => tokenAnswer({ claims }) });
    const store = memoryStore(); let reason = '';
    assert.equal(await finish(store, google.config, await startAndReturn(store, google.config), { report: (value) => { reason = value; } }), 'error');
    assert.equal(reason, 'invalid_google_id_token'); assert.equal(store.saved.length, 0);
  }
  const google = await fakeGoogle(t, { token: () => tokenAnswer({ idTokenValue: 'not-a-jwt' }) });
  const store = memoryStore();
  assert.equal(await finish(store, google.config, await startAndReturn(store, google.config)), 'error');
});

test('complete: the state must be live, single use and presented by the person who started it; Google is not called otherwise', async (t) => {
  const google = await fakeGoogle(t);
  const store = memoryStore();
  const state = await startAndReturn(store, google.config);
  assert.equal(await finish(store, google.config, state, {}, 'user-b'), 'invalid_state', 'another person');
  assert.equal(await finish(store, google.config, state), 'invalid_state', 'burned by the other person');
  assert.equal(await finish(store, google.config, 'f'.repeat(64)), 'invalid_state', 'unknown');
  assert.equal(await finish(store, google.config, 'not-hex'), 'invalid_state', 'malformed');
  assert.equal(await completeGoogleOAuth(store, google.config, { userId: null, code: 'x', state }, { now }), 'invalid_state', 'no session');
  const expired = await startAndReturn(store, google.config);
  store.states.get(await sha256Hex(expired)).expiresAt = now() - 1;
  assert.equal(await finish(store, google.config, expired), 'invalid_state', 'expired');
  const live = await startAndReturn(store, google.config);
  assert.equal(await completeGoogleOAuth(store, google.config, { userId: 'user-a', code: 'x'.repeat(1001), state: live }, { now }), 'error', 'oversized code');
  assert.equal(store.states.get(await sha256Hex(live)).consumed, false, 'a malformed request does not use the state');
  assert.equal(google.calls.length, 0);
});

test('complete: the plan or the rollout ending meanwhile is told apart, and the grant is handed back', async (t) => {
  for (const [available, outcome] of [['pro_access_required', 'plan_required'], ['feature_not_enabled', 'not_enabled']]) {
    const google = await fakeGoogle(t);
    const store = memoryStore();
    const state = await startAndReturn(store, google.config);
    const blocked = memoryStore({ available });
    blocked.states = store.states;
    assert.equal(await finish(blocked, google.config, state), outcome);
    assert.equal(blocked.saved.length, 0);
    assert.equal(google.of('/revoke').length, 1);
  }
});

test('complete: Google refusing the code is an error that says nothing of the code or the tokens', async (t) => {
  const google = await fakeGoogle(t, { token: () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Bad Request 4/0Acode' } }) });
  const store = memoryStore(); let reason = '';
  assert.equal(await finish(store, google.config, await startAndReturn(store, google.config), { report: (value) => { reason = value; } }), 'error');
  assert.equal(reason, 'google_invalid_grant');
  assert.equal(google.of('/revoke').length, 0, 'there is nothing to revoke');
});

test('refresh: a token with time left is used as is; one about to expire is renewed under the lease and the refresh token is kept', async (t) => {
  const google = await fakeGoogle(t, { token: () => ({ status: 200, body: { access_token: 'access-token-renewed-01', expires_in: 3599, scope: `${appCreated} ${freeBusy}` } }) });
  const fresh = memoryStore({ account: connected() });
  assert.deepEqual(await getValidGoogleAccessToken(fresh, google.config, 'pro-a', { now }), { accessToken: 'access-token-old-0001', calendarId: 'old-cal@group.calendar.google.com' });
  assert.equal(google.calls.length, 0);
  const due = memoryStore({ account: connected({ expiresAt: at(2 * minute) }) });
  assert.equal((await getValidGoogleAccessToken(due, google.config, 'pro-a', { now })).accessToken, 'access-token-renewed-01');
  assert.deepEqual(google.of('/token')[0].body, { client_id: google.config.clientId, client_secret: 'secret-1', grant_type: 'refresh_token', refresh_token: 'refresh-token-old-0001' });
  assert.equal(due.account.refreshToken, 'refresh-token-old-0001'); assert.equal(due.lease, false);
});

test('refresh: two callers at once spend the refresh token once', async (t) => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const google = await fakeGoogle(t, { token: async () => { await gate; return { status: 200, body: { access_token: 'access-token-renewed-02', expires_in: 3599, scope: `${appCreated} ${freeBusy}` } }; } });
  const store = memoryStore({ account: connected({ expiresAt: at(-minute) }) });
  const sleeps = [];
  const first = getValidGoogleAccessToken(store, google.config, 'pro-a', { now });
  const second = getValidGoogleAccessToken(store, google.config, 'pro-a', { now, sleep: async (ms) => { sleeps.push(ms); release(); await new Promise((resolve) => setTimeout(resolve, 50)); } });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.accessToken, 'access-token-renewed-02'); assert.equal(b.accessToken, 'access-token-renewed-02');
  assert.equal(google.of('/token').length, 1); assert.ok(sleeps.length >= 1);
});

test('refresh: invalid_grant leaves the connection needing a reconnection; other failures do not', async (t) => {
  const revoked = await fakeGoogle(t, { token: () => ({ status: 400, body: { error: 'invalid_grant' } }) });
  const store = memoryStore({ account: connected({ expiresAt: at(2 * minute) }) });
  await assert.rejects(getValidGoogleAccessToken(store, revoked.config, 'pro-a', { now }), (error) => error instanceof GoogleOAuthError && error.permanent && error.message === 'google_invalid_grant');
  assert.deepEqual(store.failures, [{ permanent: true, code: 'google_invalid_grant' }]);
  assert.equal(store.account.status, 'needs_reconnect');
  await assert.rejects(getValidGoogleAccessToken(store, revoked.config, 'pro-a', { now }), /google_calendar_not_connected/);

  for (const answer of [{ status: 401, body: { error: 'invalid_client' } }, { status: 503, body: {} }]) {
    const google = await fakeGoogle(t, { token: () => answer });
    const passing = memoryStore({ account: connected({ expiresAt: at(2 * minute) }) });
    assert.equal((await getValidGoogleAccessToken(passing, google.config, 'pro-a', { now })).accessToken, 'access-token-old-0001', 'still valid: kept');
    assert.equal(passing.failures[0].permanent, false); assert.equal(passing.account.status, 'connected');
    const expired = memoryStore({ account: connected({ expiresAt: at(-minute) }) });
    await assert.rejects(getValidGoogleAccessToken(expired, google.config, 'pro-a', { now }), (error) => !error.permanent);
    assert.equal(expired.account.status, 'connected');
  }
  // A renewal without calendar access is as good as revoked.
  const narrowed = await fakeGoogle(t, { token: () => ({ status: 200, body: { access_token: 'access-token-renewed-03', expires_in: 3599, scope: 'openid' } }) });
  const store2 = memoryStore({ account: connected({ expiresAt: at(2 * minute) }) });
  await assert.rejects(getValidGoogleAccessToken(store2, narrowed.config, 'pro-a', { now }), /google_scopes_missing/);
  assert.equal(store2.account.status, 'needs_reconnect');
});

test('refresh: without the application settings an expiring token is used while it lasts and never marked as rejected', async (t) => {
  const google = await fakeGoogle(t);
  const config = { ...google.config, clientSecret: '' };
  const store = memoryStore({ account: connected({ expiresAt: at(2 * minute) }) });
  assert.equal((await getValidGoogleAccessToken(store, config, 'pro-a', { now })).accessToken, 'access-token-old-0001');
  store.account.expiresAt = at(-minute);
  await assert.rejects(getValidGoogleAccessToken(store, config, 'pro-a', { now }), (error) => error.message === 'google_oauth_not_configured' && !error.permanent);
  assert.equal(store.failures.length, 0); assert.equal(google.calls.length, 0);
});

test('disconnect: revokes at Google, then forgets the tokens; a failed revocation still disconnects; it needs no plan and no settings', async (t) => {
  const google = await fakeGoogle(t);
  const store = memoryStore({ account: connected(), available: 'pro_access_required' });
  assert.deepEqual(await disconnectGoogle(store, { ...google.config, clientId: '', clientSecret: '' }, 'user-a'), { revoked: true });
  assert.deepEqual(google.of('/revoke').map((call) => call.body), [{ token: 'refresh-token-old-0001' }]);
  assert.deepEqual(store.disconnects, [{ userId: 'user-a', revoked: true }]);
  assert.equal(store.account.calendarId, 'old-cal@group.calendar.google.com', 'the calendar id is kept');
  assert.equal(store.account.googleSubject, '1098765');
  assert.equal(google.calls.filter((call) => call.method === 'DELETE').length, 0, 'the calendar is not deleted');

  const already = await fakeGoogle(t, { revoke: () => ({ status: 400, body: { error: 'invalid_token' } }) });
  const gone = memoryStore({ account: connected() });
  assert.deepEqual(await disconnectGoogle(gone, already.config, 'user-a'), { revoked: true });

  const down = await fakeGoogle(t, { revoke: () => ({ status: 503, body: {} }) });
  const failing = memoryStore({ account: connected() }); let reason = '';
  assert.deepEqual(await disconnectGoogle(failing, down.config, 'user-a', { report: (value) => { reason = value; } }), { revoked: false });
  assert.deepEqual(failing.disconnects, [{ userId: 'user-a', revoked: false }]); assert.equal(reason, 'google_revoke_failed');

  const nothing = memoryStore();
  assert.deepEqual(await disconnectGoogle(nothing, google.config, 'user-a'), { revoked: true });
  await assert.rejects(disconnectGoogle(nothing, google.config, 'stranger'), /not_authorized/);
});

test('redirect: one fixed address per environment, never a Vercel preview, and settings are reported by name only', () => {
  assert.equal(redirectProblem('http://localhost:5173/google-calendar/callback'), null);
  assert.equal(redirectProblem('https://bellis.example/google-calendar/callback'), null);
  assert.equal(redirectProblem('https://bellis-six.vercel.app/google-calendar/callback'), null, 'a stable alias');
  assert.equal(redirectProblem('https://bellis-git-feat-h3-1a-team.vercel.app/google-calendar/callback'), 'preview_url');
  assert.equal(redirectProblem('https://bellis-a1b2c3d4e-team.vercel.app/google-calendar/callback'), 'preview_url');
  assert.equal(redirectProblem('http://bellis.example/google-calendar/callback'), 'not_https');
  assert.equal(redirectProblem('https://bellis.example/mercado-pago/callback'), 'not_the_callback');
  assert.equal(redirectProblem('https://bellis.example/google-calendar/callback?x=1'), 'not_the_callback');
  assert.equal(redirectProblem('nope'), 'not_a_url');
  const env = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'super-secret-value' };
  const config = googleOAuthConfigFromEnv((name) => env[name], 'http://localhost:5173');
  assert.equal(config.redirectUri, 'http://localhost:5173/google-calendar/callback');
  assert.equal(config.endpoints.token, 'https://oauth2.googleapis.com/token');
  assert.deepEqual(missingGoogleConfig(config), []);
  const missing = missingGoogleConfig(googleOAuthConfigFromEnv(() => undefined, ''));
  assert.deepEqual(missing, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']);
  const preview = missingGoogleConfig(googleOAuthConfigFromEnv((name) => ({ ...env, GOOGLE_REDIRECT_URI: 'https://bellis-git-x-team.vercel.app/google-calendar/callback' })[name], ''));
  assert.deepEqual(preview, ['GOOGLE_REDIRECT_URI (preview_url)']);
  assert.ok(!JSON.stringify(preview).includes('super-secret-value'));
});

test('the module asks Google for nothing beyond what H3.1A needs: no calendar list, no events, no profile', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../functions/_shared/google-calendar-oauth.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /calendarList|\/events|userinfo|people\.googleapis|auth\/calendar\.events|auth\/calendar\.readonly/);
  const edge = await readFile(new URL('../functions/bellis-google-oauth/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(edge, /console\.(log|info|warn|error)\(/, 'logs go through the checked log line');
});
