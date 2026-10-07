/**
 * Mercado Pago OAuth for one workspace: authorization URL, code exchange, token refresh.
 * Server-side only. Nothing here is imported by the web app, and no token is ever logged or returned to a browser.
 * Storage goes through `ConnectionStore`, so the flow can be tested without a database.
 */

export type OAuthConfig = { clientId: string; clientSecret: string; redirectUri: string; testToken: boolean };
export type TokenSet = {
  accessToken: string; refreshToken: string | null; expiresAt: string | null;
  sellerUserId: string; environment: "test" | "production";
};
export type StoredCredentials = TokenSet;
export type ConnectionStore = {
  createState(userId: string, stateHash: string): Promise<string>;
  /** The workspace of a live state started by `userId`, who must still own it. Anything else is null. */
  consumeState(stateHash: string, userId: string): Promise<string | null>;
  saveConnection(workspaceId: string, userId: string, tokens: TokenSet): Promise<void>;
  credentials(workspaceId: string): Promise<StoredCredentials | null>;
  claimRefresh(workspaceId: string): Promise<boolean>;
  rotate(workspaceId: string, tokens: TokenSet): Promise<void>;
  failRefresh(workspaceId: string, permanent: boolean): Promise<void>;
};
/** Same shape the checkout already uses for a seller account. */
export type ValidAccount = { seller_user_id: string; access_token: string; environment: "test" | "production" };
export type CompletionOutcome = "connected" | "invalid_state" | "error";

type Fetch = typeof fetch;
/** `report` receives the short internal reason of a failure, for the log. Never a token or a code. */
type Clock = { fetch?: Fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; report?: (reason: string) => void };

/** `permanent` means Mercado Pago rejected the grant itself: retrying will not help, the owner has to reconnect. */
export class MercadoPagoOAuthError extends Error {
  permanent: boolean;
  constructor(code: string, permanent: boolean) { super(code); this.permanent = permanent; }
}

/** The application's settings, read the same way by every function that may need to renew a token. */
export function oauthConfigFromEnv(read: (name: string) => string | undefined, siteOrigin: string): OAuthConfig {
  return {
    clientId: read("MERCADO_PAGO_CLIENT_ID") ?? "",
    clientSecret: read("MERCADO_PAGO_CLIENT_SECRET") ?? "",
    // Mercado Pago returns the person to a page of Bellis, where their session is.
    redirectUri: read("MERCADO_PAGO_REDIRECT_URI") || `${siteOrigin}/mercado-pago/callback`,
    testToken: read("MERCADO_PAGO_OAUTH_TEST_TOKEN") === "true",
  };
}

const statePattern = /^[a-f0-9]{64}$/;
// Renew a day ahead: tokens last months, and the current one keeps working while another request renews it.
const refreshMarginMs = 24 * 60 * 60 * 1000;

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function authorizationUrl(config: OAuthConfig, state: string): string {
  const url = new URL("https://auth.mercadopago.com.ar/authorization");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("platform_id", "mp");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", config.redirectUri);
  return url.toString();
}

async function requestTokens(config: OAuthConfig, grant: Record<string, string | boolean>, now: number, fetchImpl: Fetch): Promise<TokenSet> {
  const response = await fetchImpl("https://api.mercadopago.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, ...grant }),
  });
  if (!response.ok) {
    // Only the short `error` code of a failed answer is looked at, against a fixed list. The rest can echo what was sent.
    const refused = response.status === 400 || response.status === 401
      ? String(((await response.json().catch(() => null)) as { error?: unknown } | null)?.error ?? "") : "";
    // Mercado Pago refusing Bellis's own credentials says nothing about the seller's authorization: never permanent.
    if (refused === "invalid_client" || refused === "unauthorized_client")
      throw new MercadoPagoOAuthError("mercado_pago_oauth_invalid_client", false);
    throw new MercadoPagoOAuthError(`mercado_pago_oauth_http_${response.status}`, response.status === 400 || response.status === 401);
  }
  const body = await response.json() as {
    access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; user_id?: unknown; live_mode?: unknown;
  };
  const seller = String(body.user_id ?? "");
  if (typeof body.access_token !== "string" || body.access_token.length < 10 || !/^\d{1,24}$/.test(seller))
    throw new MercadoPagoOAuthError("invalid_mercado_pago_oauth_response", false);
  const lifetime = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : null;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token.length >= 10 ? body.refresh_token : null,
    expiresAt: lifetime ? new Date(now + lifetime * 1000).toISOString() : null,
    sellerUserId: seller,
    environment: body.live_mode === false || (body.live_mode === undefined && config.testToken) ? "test" : "production",
  };
}

/** Creates the single-use state for the caller's own workspace and returns where to send them. */
export async function startOAuth(store: ConnectionStore, config: OAuthConfig, userId: string): Promise<string> {
  const state = [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await store.createState(userId, await sha256Hex(state));
  return authorizationUrl(config, state);
}

/**
 * Completes a connection for the signed-in person who came back from Mercado Pago.
 * `userId` must come from a verified session, never from the request body. The code is exchanged only
 * after the state has been matched to that same person, so an authorization made through someone else's
 * link cannot be attached to their workspace.
 */
export async function completeOAuth(
  store: ConnectionStore, config: OAuthConfig,
  params: { userId: unknown; code: unknown; state: unknown }, clock: Clock = {},
): Promise<CompletionOutcome> {
  // No verified person, no completion: the state is left untouched for whoever really started it.
  if (typeof params.userId !== "string" || !params.userId) return "invalid_state";
  if (typeof params.state !== "string" || !statePattern.test(params.state)) return "invalid_state";
  // A malformed request is refused before the state is touched.
  if (typeof params.code !== "string" || !params.code || params.code.length > 500) return "error";
  const workspaceId = await store.consumeState(await sha256Hex(params.state), params.userId);
  if (!workspaceId) return "invalid_state";
  try {
    const grant: Record<string, string | boolean> = { grant_type: "authorization_code", code: params.code, redirect_uri: config.redirectUri };
    if (config.testToken) grant.test_token = true;
    const tokens = await requestTokens(config, grant, (clock.now ?? Date.now)(), clock.fetch ?? fetch);
    await store.saveConnection(workspaceId, params.userId, tokens);
    return "connected";
  } catch (caught) {
    clock.report?.(caught instanceof MercadoPagoOAuthError ? caught.message : "connection_not_saved");
    return "error";
  }
}

/**
 * The seller account of a workspace with a token that is good to use, renewing it when it is about to expire.
 * Concurrent callers share one renewal: whoever gets the lease renews, the rest keep using the current token
 * while it is still valid or wait briefly for the new one.
 */
export async function getValidMercadoPagoAccessToken(
  store: ConnectionStore, config: OAuthConfig, workspaceId: string, clock: Clock = {},
): Promise<ValidAccount> {
  const now = clock.now ?? Date.now;
  const sleep = clock.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const account = (stored: StoredCredentials, accessToken = stored.accessToken): ValidAccount =>
    ({ seller_user_id: stored.sellerUserId, access_token: accessToken, environment: stored.environment });
  for (let attempt = 0; attempt < 6; attempt++) {
    const stored = await store.credentials(workspaceId);
    if (!stored) throw new MercadoPagoOAuthError("mercado_pago_not_connected", true);
    const remaining = stored.expiresAt ? Date.parse(stored.expiresAt) - now() : Infinity;
    if (remaining > refreshMarginMs) return account(stored);
    if (!stored.refreshToken) {
      if (remaining > 0) return account(stored);
      throw new MercadoPagoOAuthError("mercado_pago_token_expired", true);
    }
    // A function deployed without the application's settings must not look like a rejected account.
    if (!config.clientId || !config.clientSecret) {
      if (remaining > 0) return account(stored);
      throw new MercadoPagoOAuthError("mercado_pago_oauth_not_configured", false);
    }
    if (await store.claimRefresh(workspaceId)) {
      try {
        const tokens = await requestTokens(config, { grant_type: "refresh_token", refresh_token: stored.refreshToken }, now(), clock.fetch ?? fetch);
        // A renewal can only ever return the account that was connected.
        if (tokens.sellerUserId !== stored.sellerUserId) throw new MercadoPagoOAuthError("mercado_pago_seller_mismatch", true);
        await store.rotate(workspaceId, tokens);
        return account(stored, tokens.accessToken);
      } catch (caught) {
        const permanent = caught instanceof MercadoPagoOAuthError && caught.permanent;
        await store.failRefresh(workspaceId, permanent).catch(() => undefined);
        if (!permanent && remaining > 0) return account(stored);
        throw caught;
      }
    }
    if (remaining > 0) return account(stored);
    await sleep(500);
  }
  throw new MercadoPagoOAuthError("mercado_pago_refresh_in_progress", false);
}

type RpcClient = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };

/** The store backed by the service-role RPCs of the mercado_pago_oauth migration. */
export function supabaseConnectionStore(db: RpcClient): ConnectionStore {
  const call = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(name, args);
    // Only the short code set by the database is kept; arguments (which may hold tokens) are never attached.
    if (error) throw new Error(String((error as { message?: unknown }).message ?? "database_error").slice(0, 60));
    return data;
  };
  const tokenArgs = (tokens: TokenSet) =>
    ({ p_access_token: tokens.accessToken, p_refresh_token: tokens.refreshToken, p_expires_at: tokens.expiresAt });
  return {
    createState: async (userId, stateHash) =>
      String(await call("start_mercado_pago_oauth", { p_user: userId, p_state_hash: stateHash })),
    consumeState: async (stateHash, userId) => {
      const workspaceId = await call("consume_mercado_pago_oauth_state", { p_state_hash: stateHash, p_user: userId });
      return typeof workspaceId === "string" && workspaceId ? workspaceId : null;
    },
    saveConnection: async (workspaceId, userId, tokens) => {
      await call("store_mercado_pago_connection", { p_workspace: workspaceId, p_user: userId,
        p_seller: tokens.sellerUserId, p_environment: tokens.environment, ...tokenArgs(tokens) });
    },
    credentials: async (workspaceId) => {
      const row = (await call("mercado_pago_credentials", { p_workspace: workspaceId }) as Array<{
        seller_user_id: string; access_token: string; refresh_token: string | null;
        token_expires_at: string | null; environment: "test" | "production";
      }> | null)?.[0];
      return row ? { sellerUserId: row.seller_user_id, accessToken: row.access_token, refreshToken: row.refresh_token,
        expiresAt: row.token_expires_at, environment: row.environment } : null;
    },
    claimRefresh: async (workspaceId) => await call("claim_mercado_pago_refresh", { p_workspace: workspaceId }) === true,
    rotate: async (workspaceId, tokens) => { await call("rotate_mercado_pago_tokens", { p_workspace: workspaceId, ...tokenArgs(tokens) }); },
    failRefresh: async (workspaceId, permanent) => { await call("fail_mercado_pago_refresh", { p_workspace: workspaceId, p_permanent: permanent }); },
  };
}
