import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase/browser";
import { landingRouteForUser } from "@/lib/auth/navigation";
import { finishGoogleSignIn, googleSignInOptions, parseGoogleCallback, serializeGoogleCallback, type GoogleSignInOutcome, type GoogleSignInProblem } from "@/lib/auth/google-flow";

/**
 * Browser side of sign-in with Google. The Google step runs on its own short-lived client with PKCE: the verifier
 * stays in this tab's sessionStorage, the code is exchanged here, and the resulting session is handed to Bellis's own
 * client (getSupabase), so every page reads the same session as with email and password. Bellis's own client keeps
 * its flow, so email confirmation and password recovery links behave exactly as before.
 */

type Config = { url: string; publishableKey: string };
const storageKey = "bellis-google-signin";
async function config(): Promise<Config> {
  const response = await fetch("/api/supabase-config", { cache: "no-store" });
  if (!response.ok) throw new Error("unavailable");
  return await response.json() as Config;
}
/** Only this tab, only during the round trip: the verifier and, briefly, the exchanged session. */
const tabStorage = {
  getItem: (key: string) => window.sessionStorage.getItem(key),
  setItem: (key: string, value: string) => window.sessionStorage.setItem(key, value),
  removeItem: (key: string) => window.sessionStorage.removeItem(key),
};
function signInClient({ url, publishableKey }: Config): SupabaseClient {
  return createClient(url, publishableKey, { auth: { flowType: "pkce", storage: tabStorage, storageKey, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false } });
}
const clearRoundTrip = () => { for (const key of Object.keys(window.sessionStorage)) if (key.startsWith(storageKey)) window.sessionStorage.removeItem(key); };

/** Whether this environment has Google enabled in Supabase. Asked to Supabase's public settings; false when unknown. */
export async function googleSignInAvailable(): Promise<boolean> {
  try {
    const { url, publishableKey } = await config();
    const response = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: publishableKey }, cache: "no-store" });
    if (!response.ok) return false;
    return (await response.json() as { external?: { google?: unknown } }).external?.google === true;
  } catch { return false; }
}

/** Sends the person to Google. Returns a problem code only when it cannot. */
export async function startGoogleSignIn(): Promise<GoogleSignInProblem | null> {
  try {
    const signIn = googleSignInOptions(window.location.origin);
    if (!signIn) return "unavailable";
    if (!await googleSignInAvailable()) return "unavailable";
    const client = signInClient(await config());
    const { provider, options } = signIn;
    const { error } = await client.auth.signInWithOAuth({ provider, options });
    return error ? "error" : null;
  } catch { return "network"; }
}

/** The callback page: exchanges the code, hands the session over, and says where to go. */
export async function completeGoogleSignIn(query: URLSearchParams): Promise<{ route: string } | { problem: GoogleSignInProblem }> {
  const callback = parseGoogleCallback(query);
  const requestLock = typeof navigator !== "undefined" && navigator.locks
    ? (name: string, task: () => Promise<GoogleSignInOutcome>) => new Promise<GoogleSignInOutcome>((resolve, reject) => {
      void navigator.locks.request(name, () => task().then(resolve, reject)).catch(reject);
    })
    : null;

  return serializeGoogleCallback(requestLock, async () => {
    try {
      // Created inside the lock: a second tab reads the session adopted by the first one before doing anything else.
      const bellis = await getSupabase();
      let signIn: SupabaseClient | null = null;
      const ephemeral = async () => signIn ??= signInClient(await config());
      const outcome = await finishGoogleSignIn(callback, {
        exchange: async (code) => {
          const { data, error } = await (await ephemeral()).auth.exchangeCodeForSession(code);
          if (error || !data.session) throw new Error("exchange_failed");
          return { access_token: data.session.access_token, refresh_token: data.session.refresh_token, user: data.session.user };
        },
        currentUser: async () => (await bellis.auth.getUser()).data.user,
        pendingSession: async () => {
          const { data } = await (await ephemeral()).auth.getSession();
          const session = data.session;
          return session ? { access_token: session.access_token, refresh_token: session.refresh_token, user: session.user } : null;
        },
        adopt: async (session) => {
          const { error } = await bellis.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
          if (error) throw new Error("session_not_adopted");
        },
        discard: async (session) => {
          // Revokes only this session, on a client that holds it for the moment; nothing is kept in this browser.
          const client = await ephemeral();
          await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
          await client.auth.signOut({ scope: "local" });
        },
        landing: (userId) => landingRouteForUser(bellis, userId),
      });
      // Cleanup happens only after the session handoff/landing decision completed. If the page refreshes mid-handoff,
      // the exchanged session stays recoverable in this tab's sessionStorage and the one-time code is not reused.
      clearRoundTrip();
      return outcome;
    } catch {
      // Do not sign out or clear a recoverable tab session. The callback renders a calm retry action.
      return { problem: "error" };
    }
  });
}
