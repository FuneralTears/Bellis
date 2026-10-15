/**
 * Google Calendar for one professional (H3.1A): authorization with PKCE, the "Turnos Bellis" calendar, token
 * renewal and disconnection. Server-side only. Nothing here is imported by the web app, and no token, code,
 * state or verifier is ever logged or returned to a browser.
 * Storage goes through `GoogleConnectionStore`, so the flow can be tested without a database, against a fake Google.
 */

export const calendarAppCreatedScope = "https://www.googleapis.com/auth/calendar.app.created";
export const calendarFreeBusyScope = "https://www.googleapis.com/auth/calendar.freebusy";
/** Exactly what Bellis asks for. Not profile, not calendar, not calendar.events, not calendar.readonly. */
export const googleScopes = Object.freeze(["openid", "email", calendarAppCreatedScope, calendarFreeBusyScope]);
/** Without both, Bellis cannot do its job: the connection is refused. */
export const requiredCalendarScopes = Object.freeze([calendarAppCreatedScope, calendarFreeBusyScope]);
export const calendarName = "Turnos Bellis";
export const calendarDescription = "Turnos agendados en Bellis. Bellis crea y actualiza este calendario; no lee tus otros calendarios.";
/** The time zone a new calendar is created with when nothing better is known. */
export const defaultCalendarTimeZone = "America/Argentina/Buenos_Aires";
export const callbackPath = "/google-calendar/callback";

export type GoogleEndpoints = { authorize: string; token: string; revoke: string; calendar: string; jwks: string };
/** Google's own addresses. Tests point a config at a local fake instead; the environment can never change them. */
export const googleEndpoints: GoogleEndpoints = Object.freeze({
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  calendar: "https://www.googleapis.com/calendar/v3",
  // Google's current signing keys for ID tokens (the jwks_uri of https://accounts.google.com/.well-known/openid-configuration).
  jwks: "https://www.googleapis.com/oauth2/v3/certs",
});
export type GoogleOAuthConfig = { clientId: string; clientSecret: string; redirectUri: string; endpoints: GoogleEndpoints };

export type GoogleTokenSet = { accessToken: string; refreshToken: string | null; expiresAt: string; scopes: string[]; idToken: string | null };
export type GoogleIdentity = { subject: string; email: string | null };
export type OAuthAttempt = { workspaceId: string; professionalId: string; codeVerifier: string };
export type PreviousConnection = { googleSubject: string; calendarId: string | null; status: string; hasRefreshToken: boolean };
export type StoredGoogleCredentials = { googleSubject: string; status: string; accessToken: string; refreshToken: string | null; expiresAt: string | null; calendarId: string | null };
export type GoogleConnection = { subject: string; email: string | null; tokens: GoogleTokenSet; calendarId: string; calendarTimeZone: string | null };
export type GoogleConnectionStore = {
  /** Records a new attempt for the person's own professional profile. Throws 'not_authorized', 'pro_access_required' or 'feature_not_enabled'. */
  createState(userId: string, stateHash: string, codeVerifier: string): Promise<{ hasRefreshToken: boolean }>;
  /** The live attempt started by `userId`, used up. Anything else is null. */
  consumeState(stateHash: string, userId: string): Promise<OAuthAttempt | null>;
  previous(professionalId: string): Promise<PreviousConnection | null>;
  credentials(professionalId: string): Promise<StoredGoogleCredentials | null>;
  saveConnection(professionalId: string, userId: string, connection: GoogleConnection): Promise<void>;
  claimRefresh(professionalId: string): Promise<boolean>;
  rotate(professionalId: string, tokens: GoogleTokenSet): Promise<void>;
  failRefresh(professionalId: string, permanent: boolean, errorCode: string): Promise<void>;
  /** The professional profile of a person, for disconnecting. Null when they have none. */
  professionalOf(userId: string): Promise<string | null>;
  disconnect(userId: string, revoked: boolean): Promise<void>;
};
export type CompletionOutcome = "connected" | "invalid_state" | "error" | "plan_required" | "not_enabled" | "scopes_missing";

type Fetch = typeof fetch;
/** `report` receives the short internal reason of a failure, for the log. Never a token or a code. */
export type Clock = { fetch?: Fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; report?: (reason: string) => void;
  /** Checks an ID token's signature and claims (googleIdTokenVerifier). Completing a connection without one is refused. */
  verifyIdToken?: IdTokenVerifier;
  /** Renew even though the stored token looks valid: Google has just rejected it (401). It is then treated as expired. */
  force?: boolean;
  /** How long one call to Google may take before it counts as a failure (ms). */
  timeoutMs?: number };

/** `permanent`: Google rejected the grant itself (invalid_grant). Retrying will not help; the professional has to reconnect. */
export class GoogleOAuthError extends Error {
  permanent: boolean;
  constructor(code: string, permanent: boolean) { super(code); this.permanent = permanent; }
}

/**
 * Why a redirect address cannot be used, or null. Google compares it exactly, so it has to be one fixed address per
 * environment: https (or http on localhost for development), on Bellis's callback path, never a Vercel preview whose
 * address changes with every deployment.
 */
export function redirectProblem(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return "not_a_url"; }
  const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !local) return "not_https";
  if (url.pathname !== callbackPath || url.search || url.hash || url.username || url.password) return "not_the_callback";
  // Vercel's per-deployment and per-branch addresses: <project>-<hash>-<team>.vercel.app, <project>-git-<branch>-<team>.vercel.app.
  if (/\.vercel\.app$/i.test(url.hostname) && (/-git-/i.test(url.hostname) || /-[a-z0-9]{9}-[a-z0-9-]+\.vercel\.app$/i.test(url.hostname))) return "preview_url";
  return null;
}

/** The application's settings, read the same way by every function that may need Google. */
export function googleOAuthConfigFromEnv(read: (name: string) => string | undefined, siteOrigin: string): GoogleOAuthConfig {
  return {
    clientId: read("GOOGLE_CLIENT_ID") ?? "",
    clientSecret: read("GOOGLE_CLIENT_SECRET") ?? "",
    // Google returns the person to a page of Bellis, where their session is.
    redirectUri: read("GOOGLE_REDIRECT_URI") || (siteOrigin ? `${siteOrigin}${callbackPath}` : ""),
    endpoints: googleEndpoints,
  };
}
/** What is missing for connecting, as names only (never values). Empty when everything is there. */
export function missingGoogleConfig(config: GoogleOAuthConfig): string[] {
  const missing = [];
  if (!config.clientId) missing.push("GOOGLE_CLIENT_ID");
  if (!config.clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
  if (!config.redirectUri) missing.push("GOOGLE_REDIRECT_URI");
  else if (redirectProblem(config.redirectUri)) missing.push(`GOOGLE_REDIRECT_URI (${redirectProblem(config.redirectUri)})`);
  return missing;
}

const statePattern = /^[a-f0-9]{64}$/;
// Google's access tokens last an hour: renew five minutes ahead.
const refreshMarginMs = 5 * 60 * 1000;

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export async function sha256Hex(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
/** RFC 7636: S256 challenge of a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/**
 * `consent`: Google is asked to show the consent screen again, which is what makes it hand out a refresh token.
 * Needed whenever Bellis does not already hold a working one. `select_account` lets the person choose the account.
 */
export function authorizationUrl(config: GoogleOAuthConfig, state: string, challenge: string, { consent }: { consent: boolean }): string {
  const url = new URL(config.endpoints.authorize);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", googleScopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", consent ? "select_account consent" : "select_account");
  return url.toString();
}

async function tokenRequest(config: GoogleOAuthConfig, grant: Record<string, string>, now: number, fetchImpl: Fetch): Promise<GoogleTokenSet> {
  const response = await fetchImpl(config.endpoints.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...grant }).toString(),
  });
  if (!response.ok) {
    // Only the short `error` code is looked at, against a fixed list. The rest can echo what was sent.
    const refused = response.status === 400 || response.status === 401
      ? String(((await response.json().catch(() => null)) as { error?: unknown } | null)?.error ?? "") : "";
    // The grant itself is gone (revoked, expired, password changed): reconnecting is the only way out.
    if (refused === "invalid_grant") throw new GoogleOAuthError("google_invalid_grant", true);
    // Google refusing Bellis's own credentials says nothing about the professional's authorization: never permanent.
    if (refused === "invalid_client" || refused === "unauthorized_client") throw new GoogleOAuthError("google_oauth_invalid_client", false);
    throw new GoogleOAuthError(`google_oauth_http_${response.status}`, false);
  }
  const body = await response.json().catch(() => null) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; id_token?: unknown } | null;
  if (typeof body?.access_token !== "string" || body.access_token.length < 10 || body.access_token.length > 4096)
    throw new GoogleOAuthError("invalid_google_oauth_response", false);
  const lifetime = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token.length >= 10 && body.refresh_token.length <= 4096 ? body.refresh_token : null,
    expiresAt: new Date(now + lifetime * 1000).toISOString(),
    scopes: typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : [],
    idToken: typeof body.id_token === "string" ? body.id_token : null,
  };
}
export const hasCalendarScopes = (scopes: readonly string[]) => requiredCalendarScopes.every((scope) => scopes.includes(scope));

/** The two issuers Google uses in ID tokens. */
export const googleIssuers = Object.freeze(["https://accounts.google.com", "accounts.google.com"]);
export type IdTokenVerifier = (idToken: string | null, now: number) => Promise<GoogleIdentity>;
/** The part of the `jose` library this needs. The Edge Function passes npm:jose, the tests the same package from node_modules. */
export type JoseLike = {
  createRemoteJWKSet: (url: URL, options?: { cooldownDuration?: number; cacheMaxAge?: number; timeoutDuration?: number }) => unknown;
  jwtVerify: (jwt: string, key: never, options: { issuer: string[]; audience: string; algorithms: string[]; requiredClaims: string[]; currentDate: Date; clockTolerance: number }) => Promise<{ payload: Record<string, unknown> }>;
};

/**
 * Who authorized, from Google's ID token, checked the way Google documents it: the signature against Google's
 * published keys (JWKS, fetched and cached by jose, which fetches again when a token names a key it does not know,
 * so key rotation needs nothing here), RS256 only, `aud` = this application's client id, `iss` = Google, `exp` in
 * the future (with 30 s of clock tolerance) and `sub` present. `sub` is the stable identity of the Google account;
 * the email is only an attribute shown to the professional, never used to tell accounts apart.
 * Any failure is the same short code: nothing of the token, the keys or the network error is reported.
 * Create it once per process so the key cache lives across requests.
 */
export function googleIdTokenVerifier(jose: JoseLike, { clientId, jwksUrl = googleEndpoints.jwks, cooldownMs, cacheMaxAgeMs }: { clientId: string; jwksUrl?: string; cooldownMs?: number; cacheMaxAgeMs?: number }): IdTokenVerifier {
  const keys = jose.createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: 5000, ...(cooldownMs !== undefined ? { cooldownDuration: cooldownMs } : {}), ...(cacheMaxAgeMs !== undefined ? { cacheMaxAge: cacheMaxAgeMs } : {}) });
  return async (idToken, now) => {
    if (!clientId || typeof idToken !== "string" || idToken.length > 8192) throw new GoogleOAuthError("invalid_google_id_token", false);
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jose.jwtVerify(idToken, keys as never, { issuer: [...googleIssuers], audience: clientId, algorithms: ["RS256"], requiredClaims: ["sub", "exp", "iat"], currentDate: new Date(now), clockTolerance: 30 }));
    } catch (caught) {
      // A problem of the token itself (signature, claims, format, algorithm, unknown key) is an invalid token. Anything
      // else (network, timeout, a bad answer from Google's key endpoint) means the keys could not be read: said apart.
      const code = String((caught as { code?: unknown } | null)?.code ?? "");
      const tokenProblem = /^ERR_(JWT_|JWS_|JOSE_ALG_NOT_ALLOWED|JOSE_NOT_SUPPORTED|JWKS_NO_MATCHING_KEY|JWKS_MULTIPLE_MATCHING_KEYS)/.test(code);
      throw new GoogleOAuthError(tokenProblem ? "invalid_google_id_token" : "google_jwks_unavailable", false);
    }
    if (typeof payload.sub !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(payload.sub)) throw new GoogleOAuthError("invalid_google_id_token", false);
    const email = typeof payload.email === "string" && payload.email.length <= 320 && payload.email.includes("@") && payload.email_verified !== false ? payload.email : null;
    return { subject: payload.sub, email };
  };
}

/** Asks Google to revoke a token (and with it the whole authorization of Bellis for that account). True when it is gone. */
export async function revokeToken(config: GoogleOAuthConfig, token: string, fetchImpl: Fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(config.endpoints.revoke, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() });
    if (response.ok) return true;
    // Already revoked or expired: it is gone all the same.
    return response.status === 400 && String(((await response.json().catch(() => null)) as { error?: unknown } | null)?.error ?? "") === "invalid_token";
  } catch { return false; }
}

/**
 * The "Turnos Bellis" calendar of this Google account. Bellis never lists calendars: it either reads the one whose id
 * it stored (same Google account) or creates a new one. A stored calendar that is gone (404) is replaced by a new one.
 */
export async function ensureCalendar(config: GoogleOAuthConfig, accessToken: string, storedCalendarId: string | null, fetchImpl: Fetch = fetch): Promise<{ id: string; timeZone: string | null; created: boolean }> {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  const read = async (response: Response) => {
    const body = await response.json().catch(() => null) as { id?: unknown; timeZone?: unknown } | null;
    if (typeof body?.id !== "string" || !body.id || body.id.length > 1024) throw new GoogleOAuthError("invalid_google_calendar_response", false);
    return { id: body.id, timeZone: typeof body.timeZone === "string" && body.timeZone.length <= 64 ? body.timeZone : null };
  };
  if (storedCalendarId) {
    const found = await fetchImpl(`${config.endpoints.calendar}/calendars/${encodeURIComponent(storedCalendarId)}`, { headers });
    if (found.ok) return { ...await read(found), created: false };
    // Deleted by the person, or no longer reachable with this app's access: a new one is made. Anything else is a failure.
    if (found.status !== 404 && found.status !== 410) throw new GoogleOAuthError(`google_calendar_http_${found.status}`, false);
  }
  const created = await fetchImpl(`${config.endpoints.calendar}/calendars`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ summary: calendarName, description: calendarDescription, timeZone: defaultCalendarTimeZone }),
  });
  if (!created.ok) throw new GoogleOAuthError(`google_calendar_http_${created.status}`, false);
  return { ...await read(created), created: true };
}

const randomHex = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)));

/** Creates the single-use state and the PKCE verifier for the caller's own professional profile; returns where to send them. */
export async function startGoogleOAuth(store: GoogleConnectionStore, config: GoogleOAuthConfig, userId: string): Promise<string> {
  const state = randomHex(32);
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const { hasRefreshToken } = await store.createState(userId, await sha256Hex(state), verifier);
  return authorizationUrl(config, state, await pkceChallenge(verifier), { consent: !hasRefreshToken });
}

const databaseCode = (caught: unknown) => String((caught as { message?: unknown } | null)?.message ?? "");

/**
 * Completes a connection for the signed-in person who came back from Google.
 * `userId` must come from a verified session, never from the request body. The code is exchanged only after the
 * state has been matched to that same person, with the verifier stored for that state.
 */
export async function completeGoogleOAuth(
  store: GoogleConnectionStore, config: GoogleOAuthConfig,
  params: { userId: unknown; code: unknown; state: unknown }, clock: Clock = {},
): Promise<CompletionOutcome> {
  if (typeof params.userId !== "string" || !params.userId) return "invalid_state";
  if (typeof params.state !== "string" || !statePattern.test(params.state)) return "invalid_state";
  // A malformed request is refused before the state is touched.
  if (typeof params.code !== "string" || !params.code || params.code.length > 1000) return "error";
  const attempt = await store.consumeState(await sha256Hex(params.state), params.userId);
  if (!attempt?.codeVerifier) return "invalid_state";
  const fetchImpl = clock.fetch ?? fetch; const now = (clock.now ?? Date.now)();
  let tokens: GoogleTokenSet | null = null; let keepGrant = false;
  try {
    tokens = await tokenRequest(config, { grant_type: "authorization_code", code: params.code, redirect_uri: config.redirectUri, code_verifier: attempt.codeVerifier }, now, fetchImpl);
    // Fail closed: without a verifier the token is never trusted.
    if (!clock.verifyIdToken) throw new GoogleOAuthError("google_id_token_verifier_missing", false);
    const identity = await clock.verifyIdToken(tokens.idToken, now);
    const previous = await store.previous(attempt.professionalId);
    const sameAccount = previous?.googleSubject === identity.subject;
    // Revoking any token of an account revokes all of Bellis's access to it: never while that account stays connected.
    keepGrant = sameAccount && previous?.status === "connected" && previous.hasRefreshToken;
    if (!hasCalendarScopes(tokens.scopes)) { clock.report?.("google_scopes_missing"); return "scopes_missing"; }
    if (!tokens.refreshToken && !(sameAccount && previous?.hasRefreshToken)) throw new GoogleOAuthError("google_refresh_token_missing", false);
    // Another Google account was connected before: its authorization is revoked once the new one is saved.
    const replaced = previous && !sameAccount ? await store.credentials(attempt.professionalId) : null;
    const calendar = await ensureCalendar(config, tokens.accessToken, sameAccount ? previous?.calendarId ?? null : null, fetchImpl);
    await store.saveConnection(attempt.professionalId, params.userId, { subject: identity.subject, email: identity.email, tokens, calendarId: calendar.id, calendarTimeZone: calendar.timeZone });
    keepGrant = true;
    if (replaced) await revokeToken(config, replaced.refreshToken ?? replaced.accessToken, fetchImpl);
    return "connected";
  } catch (caught) {
    // The plan or the rollout ended between starting and coming back: the database refuses to save.
    if (!(caught instanceof GoogleOAuthError) && databaseCode(caught).includes("pro_access_required")) return "plan_required";
    if (!(caught instanceof GoogleOAuthError) && databaseCode(caught).includes("feature_not_enabled")) return "not_enabled";
    clock.report?.(caught instanceof GoogleOAuthError ? caught.message : "connection_not_saved");
    return "error";
  } finally {
    // A grant Bellis is not going to keep is handed back, so it does not linger in the person's Google account.
    if (tokens && !keepGrant) await revokeToken(config, tokens.refreshToken ?? tokens.accessToken, fetchImpl);
  }
}

/**
 * A token that is good to use for a connected professional, renewing it when it is about to expire.
 * Concurrent callers share one renewal: whoever gets the lease renews; the rest keep the current token while it is
 * valid or wait briefly. invalid_grant leaves the connection in needs_reconnect.
 */
export async function getValidGoogleAccessToken(
  store: GoogleConnectionStore, config: GoogleOAuthConfig, professionalId: string, clock: Clock = {},
): Promise<{ accessToken: string; calendarId: string | null }> {
  const now = clock.now ?? Date.now;
  const sleep = clock.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 6; attempt++) {
    const stored = await store.credentials(professionalId);
    if (!stored || stored.status !== "connected") throw new GoogleOAuthError("google_calendar_not_connected", true);
    const result = (accessToken: string) => ({ accessToken, calendarId: stored.calendarId });
    // A token Google has just rejected is as good as expired, whatever its date says.
    const remaining = clock.force ? 0 : stored.expiresAt ? Date.parse(stored.expiresAt) - now() : 0;
    if (remaining > refreshMarginMs) return result(stored.accessToken);
    if (!stored.refreshToken) throw new GoogleOAuthError("google_calendar_not_connected", true);
    // A function deployed without the application's settings must not look like a rejected account.
    if (!config.clientId || !config.clientSecret) {
      if (remaining > 0) return result(stored.accessToken);
      throw new GoogleOAuthError("google_oauth_not_configured", false);
    }
    if (await store.claimRefresh(professionalId)) {
      try {
        const tokens = await tokenRequest(config, { grant_type: "refresh_token", refresh_token: stored.refreshToken }, now(), clock.fetch ?? fetch);
        // A renewal that comes back without calendar access is as good as revoked.
        if (tokens.scopes.length && !hasCalendarScopes(tokens.scopes)) throw new GoogleOAuthError("google_scopes_missing", true);
        await store.rotate(professionalId, tokens);
        return result(tokens.accessToken);
      } catch (caught) {
        const permanent = caught instanceof GoogleOAuthError && caught.permanent;
        await store.failRefresh(professionalId, permanent, caught instanceof GoogleOAuthError ? caught.message : "google_refresh_failed").catch(() => undefined);
        if (!permanent && remaining > 0) return result(stored.accessToken);
        throw caught;
      }
    }
    if (remaining > 0) return result(stored.accessToken);
    await sleep(500);
  }
  throw new GoogleOAuthError("google_refresh_in_progress", false);
}

export type CheckOutcome = "connected" | "needs_reconnect" | "unverified" | "not_connected";

/**
 * Checks that a stored connection still works, for the person's own professional profile (from their session, never
 * from the request). One cheap read: calendars.get of the stored "Turnos Bellis". 200: connected. 401: the token is
 * renewed with getValidGoogleAccessToken (forced) and the read is tried once more; when Google answers invalid_grant
 * the helper itself leaves the connection in needs_reconnect and erases its tokens. Anything else (403, 404, 429,
 * 5xx, a timeout, a network error, Bellis's own client refused) is "unverified" and changes nothing: only a
 * renewal Google refused for good marks a connection. A missing calendar is not recreated here.
 * `reason` is a short code for the log; nothing of Google's answer, the token or the calendar is returned.
 */
export async function checkGoogleConnection(store: GoogleConnectionStore, config: GoogleOAuthConfig, userId: string, clock: Clock = {}): Promise<{ outcome: CheckOutcome; reason: string | null }> {
  const professionalId = await store.professionalOf(userId);
  if (!professionalId) throw new Error("not_authorized");
  const stored = await store.credentials(professionalId);
  if (!stored || stored.status !== "connected" || !stored.calendarId) {
    // A connection Google refused keeps no tokens, so its state is read where no token is needed.
    const status = stored?.status ?? (await store.previous(professionalId))?.status;
    return { outcome: status === "needs_reconnect" ? "needs_reconnect" : "not_connected", reason: null };
  }
  const fetchImpl = clock.fetch ?? fetch; const timeoutMs = clock.timeoutMs ?? 8000;
  const read = async (accessToken: string): Promise<number | string> => {
    try {
      const response = await fetchImpl(`${config.endpoints.calendar}/calendars/${encodeURIComponent(stored.calendarId as string)}`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      await response.body?.cancel().catch(() => undefined);
      return response.status;
    } catch (caught) { return (caught as { name?: string } | null)?.name === "TimeoutError" ? "google_timeout" : "google_unreachable"; }
  };
  const verdict = (answer: number | string) => answer === 200 ? { outcome: "connected" as const, reason: null } : { outcome: "unverified" as const, reason: typeof answer === "string" ? answer : `google_calendar_http_${answer}` };
  const first = await read(stored.accessToken);
  if (first !== 401) return verdict(first);
  let renewed: string;
  try { renewed = (await getValidGoogleAccessToken(store, config, professionalId, { ...clock, force: true })).accessToken; }
  catch (caught) {
    // The helper has already recorded a permanent refusal (needs_reconnect, tokens erased); anything else changed nothing.
    if (caught instanceof GoogleOAuthError && caught.permanent) return { outcome: "needs_reconnect", reason: caught.message };
    return { outcome: "unverified", reason: caught instanceof GoogleOAuthError ? caught.message : "google_refresh_failed" };
  }
  const second = await read(renewed);
  return second === 401 ? { outcome: "unverified", reason: "google_still_unauthorized" } : verdict(second);
}

/**
 * Disconnects the person's own professional profile: Google is asked to revoke Bellis's authorization, then Bellis
 * forgets the tokens. The calendar stays in Google, and google_subject and calendar_id stay in Bellis. Needs neither
 * the plan, the rollout, nor the application's settings (revoking only needs the token).
 */
export async function disconnectGoogle(store: GoogleConnectionStore, config: GoogleOAuthConfig, userId: string, clock: Clock = {}): Promise<{ revoked: boolean }> {
  const professionalId = await store.professionalOf(userId);
  if (!professionalId) throw new Error("not_authorized");
  const stored = await store.credentials(professionalId);
  const revoked = stored ? await revokeToken(config, stored.refreshToken ?? stored.accessToken, clock.fetch ?? fetch) : true;
  if (!revoked) clock.report?.("google_revoke_failed");
  await store.disconnect(userId, revoked);
  return { revoked };
}

type RpcClient = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };

/** The store backed by the service-role RPCs of the google_calendar_oauth migration. */
export function supabaseGoogleConnectionStore(db: RpcClient): GoogleConnectionStore {
  const call = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(name, args);
    // Only the short code set by the database is kept; arguments (which may hold tokens) are never attached.
    if (error) throw new Error(String((error as { message?: unknown }).message ?? "database_error").slice(0, 60));
    return data;
  };
  const first = <T>(data: unknown) => (Array.isArray(data) ? data[0] : null) as T | null;
  return {
    createState: async (userId, stateHash, codeVerifier) => {
      const row = first<{ has_refresh_token: boolean }>(await call("start_google_calendar_oauth", { p_user: userId, p_state_hash: stateHash, p_code_verifier: codeVerifier }));
      if (!row) throw new Error("not_authorized");
      return { hasRefreshToken: row.has_refresh_token === true };
    },
    consumeState: async (stateHash, userId) => {
      const row = first<{ workspace_id: string; professional_id: string; code_verifier: string | null }>(await call("consume_google_calendar_oauth_state", { p_state_hash: stateHash, p_user: userId }));
      return row?.professional_id && row.code_verifier ? { workspaceId: row.workspace_id, professionalId: row.professional_id, codeVerifier: row.code_verifier } : null;
    },
    previous: async (professionalId) => {
      const row = first<{ google_subject: string; calendar_id: string | null; status: string; has_refresh_token: boolean }>(await call("google_calendar_previous_connection", { p_professional: professionalId }));
      return row ? { googleSubject: row.google_subject, calendarId: row.calendar_id, status: row.status, hasRefreshToken: row.has_refresh_token === true } : null;
    },
    credentials: async (professionalId) => {
      const row = first<{ google_subject: string; status: string; access_token: string; refresh_token: string | null; token_expires_at: string | null; calendar_id: string | null }>(await call("google_calendar_credentials", { p_professional: professionalId }));
      return row ? { googleSubject: row.google_subject, status: row.status, accessToken: row.access_token, refreshToken: row.refresh_token, expiresAt: row.token_expires_at, calendarId: row.calendar_id } : null;
    },
    saveConnection: async (professionalId, userId, connection) => {
      await call("store_google_calendar_connection", { p_professional: professionalId, p_user: userId, p_subject: connection.subject, p_email: connection.email,
        p_access_token: connection.tokens.accessToken, p_refresh_token: connection.tokens.refreshToken, p_expires_at: connection.tokens.expiresAt,
        p_scopes: connection.tokens.scopes, p_calendar_id: connection.calendarId, p_calendar_timezone: connection.calendarTimeZone });
    },
    claimRefresh: async (professionalId) => await call("claim_google_calendar_refresh", { p_professional: professionalId }) === true,
    rotate: async (professionalId, tokens) => { await call("rotate_google_calendar_tokens", { p_professional: professionalId, p_access_token: tokens.accessToken, p_refresh_token: tokens.refreshToken, p_expires_at: tokens.expiresAt }); },
    failRefresh: async (professionalId, permanent, errorCode) => { await call("fail_google_calendar_refresh", { p_professional: professionalId, p_permanent: permanent, p_error_code: errorCode }); },
    professionalOf: async (userId) => { const id = await call("google_calendar_professional_id", { p_user: userId }); return typeof id === "string" && id ? id : null; },
    disconnect: async (userId, revoked) => { await call("disconnect_google_calendar", { p_user: userId, p_revoked: revoked }); },
  };
}
