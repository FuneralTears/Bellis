import test from 'node:test';
import assert from 'node:assert/strict';
import { MercadoPagoOAuthError, authorizationUrl, completeOAuth, getValidMercadoPagoAccessToken, sha256Hex, startOAuth }
  from '../functions/_shared/mercado-pago-oauth.ts';

const config = { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://bellis.example/mercado-pago/callback', testToken: false };
const day = 24 * 60 * 60 * 1000;
const now = () => Date.parse('2026-10-04T12:00:00Z');
const at = (ms) => new Date(now() + ms).toISOString();

/**
 * In-memory stand-in for the database RPCs, with the same rules: a state belongs to the person who started it
 * and to the workspace they own, works once, expires, and is burned by anyone else who presents it.
 */
function memoryStore(initial = null) {
  const store = {
    owners: { 'user-a': 'ws-a', 'user-b': 'ws-b' },
    states: new Map(), saved: [], stored: initial, lease: false, failures: [], claims: 0,
    async createState(userId, stateHash) {
      const workspaceId = this.owners[userId];
      if (!workspaceId) throw new Error('not_authorized');
      this.states.set(stateHash, { workspaceId, userId, expiresAt: now() + 10 * 60 * 1000, consumed: false });
      return workspaceId;
    },
    async consumeState(stateHash, userId) {
      const flow = this.states.get(stateHash);
      if (!flow || flow.consumed || flow.expiresAt <= now()) return null;
      flow.consumed = true;
      return flow.userId === userId && this.owners[userId] === flow.workspaceId ? flow.workspaceId : null;
    },
    async saveConnection(workspaceId, userId, tokens) {
      if (this.owners[userId] !== workspaceId) throw new Error('not_authorized');
      this.saved.push({ workspaceId, userId, tokens }); this.stored = tokens;
    },
    async credentials() { return this.stored; },
    async claimRefresh() { this.claims++; if (this.lease) return false; this.lease = true; return true; },
    async rotate(_workspaceId, tokens) { this.stored = { ...this.stored, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? this.stored.refreshToken, expiresAt: tokens.expiresAt }; this.lease = false; },
    async failRefresh(_workspaceId, permanent) { this.failures.push(permanent); this.lease = false; if (permanent) this.stored = null; },
  };
  return store;
}
const tokenAnswer = (extra = {}) => Response.json({ access_token: 'APP_USR-access-new', refresh_token: 'TG-refresh-new', expires_in: 15552000, user_id: 99912345, live_mode: true, ...extra });
const stateOf = (url) => new URL(url).searchParams.get('state');
const neverCalled = async () => { throw new Error('Mercado Pago must not be called'); };
/** Mercado Pago answering for whoever authorized: the seller id tells whose account the code belongs to. */
const exchangeFor = (seller) => { const calls = []; return { calls, fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return tokenAnswer({ user_id: seller }); } }; };

test('start builds the authorization URL around a random state and stores only its hash', async () => {
  const store = memoryStore();
  const url = new URL(await startOAuth(store, config, 'user-a'));
  assert.equal(url.origin + url.pathname, 'https://auth.mercadopago.com.ar/authorization');
  assert.equal(url.searchParams.get('client_id'), 'client-1');
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(url.searchParams.get('response_type'), 'code');
  const state = url.searchParams.get('state');
  assert.match(state, /^[a-f0-9]{64}$/);
  assert.deepEqual([...store.states.keys()], [await sha256Hex(state)]);
  assert.ok(!url.toString().includes('secret-1'));
  assert.notEqual(state, stateOf(await startOAuth(store, config, 'user-a')));
  assert.ok(!authorizationUrl(config, state).includes('ws-a'));
  await assert.rejects(() => startOAuth(store, config, 'user-without-workspace'), /not_authorized/);
});

test('A. the person who started the connection completes it, for their own workspace', async () => {
  const store = memoryStore();
  const state = stateOf(await startOAuth(store, config, 'user-a'));
  const mp = exchangeFor(99912345);
  assert.equal(await completeOAuth(store, config, { userId: 'user-a', code: 'TG-code', state }, { now, fetch: mp.fetch }), 'connected');
  assert.equal(mp.calls[0].url, 'https://api.mercadopago.com/oauth/token');
  assert.deepEqual(mp.calls[0].body, { client_id: 'client-1', client_secret: 'secret-1', grant_type: 'authorization_code', code: 'TG-code', redirect_uri: config.redirectUri });
  assert.deepEqual(store.saved, [{ workspaceId: 'ws-a', userId: 'user-a',
    tokens: { accessToken: 'APP_USR-access-new', refreshToken: 'TG-refresh-new', expiresAt: at(15552000 * 1000), sellerUserId: '99912345', environment: 'production' } }]);
});

test('B. someone else signed in cannot complete a connection another person started', async () => {
  const store = memoryStore();
  const state = stateOf(await startOAuth(store, config, 'user-a'));
  assert.equal(await completeOAuth(store, config, { userId: 'user-b', code: 'TG-code-of-b', state }, { now, fetch: neverCalled }), 'invalid_state');
  assert.equal(store.saved.length, 0);
});

test('C. without a session there is no one to complete for', async () => {
  const store = memoryStore();
  const state = stateOf(await startOAuth(store, config, 'user-a'));
  for (const userId of ['', undefined, null])
    assert.equal(await completeOAuth(store, config, { userId, code: 'TG-code', state }, { now, fetch: neverCalled }), 'invalid_state');
  assert.equal(store.saved.length, 0);
  // Arriving signed out does not spend the state: the person who started it can still finish.
  assert.equal(await completeOAuth(store, config, { userId: 'user-a', code: 'TG-code', state }, { now, fetch: exchangeFor(1).fetch }), 'connected');
});

test('D. a shared link cannot attach the account of whoever authorizes it to the workspace of whoever started it', async () => {
  const store = memoryStore();
  // A starts the connection and sends the Mercado Pago link to B. B authorizes with B's own Mercado Pago account
  // and lands on Bellis with a code for that account plus A's state.
  const state = stateOf(await startOAuth(store, config, 'user-a'));
  const mp = exchangeFor(55500001);
  // B is signed in to Bellis as B.
  assert.equal(await completeOAuth(store, config, { userId: 'user-b', code: 'TG-code-of-b', state }, { now, fetch: mp.fetch }), 'invalid_state');
  // The code was never exchanged, and neither workspace got B's account.
  assert.equal(mp.calls.length, 0);
  assert.equal(store.saved.length, 0);
  assert.equal(store.stored, null);
  // That attempt burned the state: it cannot be completed afterwards, not even by A with B's code.
  assert.equal(await completeOAuth(store, config, { userId: 'user-a', code: 'TG-code-of-b', state }, { now, fetch: mp.fetch }), 'invalid_state');
  assert.equal(mp.calls.length, 0);
  assert.equal(store.saved.length, 0);
});

test('E. an expired state is refused', async () => {
  const store = memoryStore();
  const state = stateOf(await startOAuth(store, config, 'user-a'));
  store.states.get(await sha256Hex(state)).expiresAt = now() - 1;
  assert.equal(await completeOAuth(store, config, { userId: 'user-a', code: 'TG-code', state }, { now, fetch: neverCalled }), 'invalid_state');
  assert.equal(store.saved.length, 0);
});

test('F. a state works once: the second attempt is refused before reaching Mercado Pago', async () => {
  const store = memoryStore();
  const state = stateOf(await startOAuth(store, config, 'user-a'));
  const mp = exchangeFor(99912345);
  assert.equal(await completeOAuth(store, config, { userId: 'user-a', code: 'TG-code', state }, { now, fetch: mp.fetch }), 'connected');
  assert.equal(await completeOAuth(store, config, { userId: 'user-a', code: 'TG-code', state }, { now, fetch: mp.fetch }), 'invalid_state');
  assert.equal(mp.calls.length, 1);
  assert.equal(store.saved.length, 1);
});

test('G. someone who stopped owning the workspace after starting cannot complete', async () => {
  const store = memoryStore();
  const state = stateOf(await startOAuth(store, config, 'user-a'));
  delete store.owners['user-a'];
  assert.equal(await completeOAuth(store, config, { userId: 'user-a', code: 'TG-code', state }, { now, fetch: neverCalled }), 'invalid_state');
  assert.equal(store.saved.length, 0);
});

test('H. a state never completes for a workspace other than the one it was started for', async () => {
  const store = memoryStore();
  const state = stateOf(await startOAuth(store, config, 'user-a'));
  // The person now owns a different workspace than the one bound to the state.
  store.owners['user-a'] = 'ws-other';
  assert.equal(await completeOAuth(store, config, { userId: 'user-a', code: 'TG-code', state }, { now, fetch: neverCalled }), 'invalid_state');
  // And nothing in the request can point the connection at another workspace: it is not even an input.
  const next = stateOf(await startOAuth(store, config, 'user-b'));
  assert.equal(await completeOAuth(store, config, { userId: 'user-b', code: 'TG-code', state: next, workspaceId: 'ws-a', workspace_id: 'ws-a' }, { now, fetch: exchangeFor(1).fetch }), 'connected');
  assert.deepEqual(store.saved.map((item) => item.workspaceId), ['ws-b']);
});

test('unknown or malformed states and missing codes never exchange anything', async () => {
  const store = memoryStore();
  for (const state of [null, undefined, '', 'short', 'g'.repeat(64), 'a'.repeat(64), 42])
    assert.equal(await completeOAuth(store, config, { userId: 'user-a', code: 'TG-code', state }, { now, fetch: neverCalled }), 'invalid_state');
  // A request without a usable code is refused without spending the state.
  const state = stateOf(await startOAuth(store, config, 'user-a'));
  for (const code of [null, undefined, '', 7, 'x'.repeat(501)])
    assert.equal(await completeOAuth(store, config, { userId: 'user-a', code, state }, { now, fetch: neverCalled }), 'error');
  assert.equal(await completeOAuth(store, config, { userId: 'user-a', code: 'TG-code', state }, { now, fetch: exchangeFor(1).fetch }), 'connected');
});

test('a failed exchange, a bad answer or a storage failure never leaves a connection', async () => {
  for (const answer of [() => new Response('{"message":"invalid_grant"}', { status: 400 }), () => new Response('down', { status: 502 }),
    () => Response.json({ access_token: 'APP_USR-access-new' }), () => { throw new Error('network'); }]) {
    const store = memoryStore();
    const state = stateOf(await startOAuth(store, config, 'user-a'));
    assert.equal(await completeOAuth(store, config, { userId: 'user-a', code: 'TG-code', state }, { now, fetch: async () => answer() }), 'error');
    assert.equal(store.saved.length, 0);
  }
  const store = memoryStore();
  store.saveConnection = async () => { throw new Error('vault_down'); };
  const state = stateOf(await startOAuth(store, config, 'user-a'));
  assert.equal(await completeOAuth(store, config, { userId: 'user-a', code: 'TG-code', state }, { now, fetch: async () => tokenAnswer() }), 'error');
  assert.equal(store.stored, null);
});

test('test credentials are requested only when configured, and marked as test', async () => {
  const store = memoryStore();
  const state = stateOf(await startOAuth(store, config, 'user-a'));
  let body;
  await completeOAuth(store, { ...config, testToken: true }, { userId: 'user-a', code: 'TG-code', state },
    { now, fetch: async (_url, init) => { body = JSON.parse(init.body); return tokenAnswer({ live_mode: false }); } });
  assert.equal(body.test_token, true);
  assert.equal(store.saved[0].tokens.environment, 'test');
});

const stored = (extra = {}) => ({ accessToken: 'APP_USR-access-old', refreshToken: 'TG-refresh-old', expiresAt: at(90 * day), sellerUserId: '99912345', environment: 'production', ...extra });

test('a token that is still valid is used as is, without calling Mercado Pago', async () => {
  const store = memoryStore(stored());
  const account = await getValidMercadoPagoAccessToken(store, config, 'ws-1', { now, fetch: async () => { throw new Error('must not be called'); } });
  assert.deepEqual(account, { seller_user_id: '99912345', access_token: 'APP_USR-access-old', environment: 'production' });
  assert.equal(store.claims, 0);
  // A manually loaded account has no expiry and no refresh token: it is used as is.
  const manual = memoryStore(stored({ expiresAt: null, refreshToken: null }));
  assert.equal((await getValidMercadoPagoAccessToken(manual, config, 'ws-1', { now })).access_token, 'APP_USR-access-old');
});

test('an expired token is renewed, and the new access and refresh tokens replace the old ones', async () => {
  const store = memoryStore(stored({ expiresAt: at(-day) }));
  let body;
  const account = await getValidMercadoPagoAccessToken(store, config, 'ws-1',
    { now, fetch: async (_url, init) => { body = JSON.parse(init.body); return tokenAnswer(); } });
  assert.deepEqual(body, { client_id: 'client-1', client_secret: 'secret-1', grant_type: 'refresh_token', refresh_token: 'TG-refresh-old' });
  assert.equal(account.access_token, 'APP_USR-access-new');
  assert.equal(store.stored.accessToken, 'APP_USR-access-new');
  assert.equal(store.stored.refreshToken, 'TG-refresh-new');
  assert.equal(store.stored.expiresAt, at(15552000 * 1000));
  assert.equal(store.lease, false);
});

test('a token close to expiry is renewed ahead of time', async () => {
  const store = memoryStore(stored({ expiresAt: at(day / 2) }));
  assert.equal((await getValidMercadoPagoAccessToken(store, config, 'ws-1', { now, fetch: async () => tokenAnswer() })).access_token, 'APP_USR-access-new');
});

test('a refresh Mercado Pago rejects marks the connection as failed and gives no token', async () => {
  const store = memoryStore(stored({ expiresAt: at(-day) }));
  await assert.rejects(() => getValidMercadoPagoAccessToken(store, config, 'ws-1', { now, fetch: async () => new Response('{}', { status: 400 }) }),
    (error) => error instanceof MercadoPagoOAuthError && error.permanent && !/TG-|APP_USR|secret/.test(error.message));
  assert.deepEqual(store.failures, [true]);
  await assert.rejects(() => getValidMercadoPagoAccessToken(store, config, 'ws-1', { now }), /mercado_pago_not_connected/);
});

test('a temporary failure keeps the connection: the current token is used while it lasts, and an expired one is not', async () => {
  const soon = memoryStore(stored({ expiresAt: at(day / 2) }));
  assert.equal((await getValidMercadoPagoAccessToken(soon, config, 'ws-1', { now, fetch: async () => new Response('down', { status: 503 }) })).access_token, 'APP_USR-access-old');
  assert.deepEqual(soon.failures, [false]);
  assert.equal(soon.lease, false);
  const expired = memoryStore(stored({ expiresAt: at(-day) }));
  await assert.rejects(() => getValidMercadoPagoAccessToken(expired, config, 'ws-1', { now, fetch: async () => new Response('down', { status: 503 }) }),
    (error) => error instanceof MercadoPagoOAuthError && !error.permanent);
  assert.deepEqual(expired.failures, [false]);
  assert.notEqual(expired.stored, null);
});

test('an expired token without a refresh token cannot be used', async () => {
  const store = memoryStore(stored({ expiresAt: at(-day), refreshToken: null }));
  await assert.rejects(() => getValidMercadoPagoAccessToken(store, config, 'ws-1', { now }), /mercado_pago_token_expired/);
});

test('a renewal that answers for another seller is refused', async () => {
  const store = memoryStore(stored({ expiresAt: at(-day) }));
  await assert.rejects(() => getValidMercadoPagoAccessToken(store, config, 'ws-1', { now, fetch: async () => tokenAnswer({ user_id: 111 }) }), /mercado_pago_seller_mismatch/);
  assert.deepEqual(store.failures, [true]);
});

test('simultaneous requests share a single renewal', async () => {
  const store = memoryStore(stored({ expiresAt: at(-day) }));
  let calls = 0;
  const clock = { now, sleep: async () => {}, fetch: async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 20)); return tokenAnswer(); } };
  const accounts = await Promise.all([1, 2, 3].map(() => getValidMercadoPagoAccessToken(store, config, 'ws-1',
    { ...clock, sleep: () => new Promise((resolve) => setTimeout(resolve, 15)) })));
  assert.equal(calls, 1);
  assert.deepEqual(accounts.map((item) => item.access_token), Array(3).fill('APP_USR-access-new'));
});
