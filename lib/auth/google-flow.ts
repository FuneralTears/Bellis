/**
 * Sign-in with Google (H3.1A.1): identity only. The rules of the flow, with no browser and no Supabase in them, so they
 * are tested directly. Connecting Google Calendar is a separate consent, in Integraciones: nothing here asks for its scopes.
 */

/** Where Supabase sends the person back. Always this fixed path of the current origin: no `next`, nothing from the URL. */
export const googleCallbackPath = "/auth/callback";
export const googleCallbackUrl = (origin: string) => `${origin}${googleCallbackPath}`;

/**
 * The options of supabase.auth.signInWithOAuth. No `scopes`: Supabase asks Google for openid, email and profile, which
 * is all sign-in needs. Calendar scopes are never added here. `select_account` lets the person choose the account.
 */
export function googleSignInOptions(origin: string) {
  return { provider: "google" as const, options: { redirectTo: googleCallbackUrl(origin), queryParams: { prompt: "select_account" } } };
}

export type GoogleCallback = { kind: "code"; code: string } | { kind: "cancelled" } | { kind: "error" } | { kind: "invalid" };
/** What came back in the callback's query. Only the code is kept; any provider message is dropped. */
export function parseGoogleCallback(query: URLSearchParams): GoogleCallback {
  const error = query.get("error");
  if (error) return error === "access_denied" ? { kind: "cancelled" } : { kind: "error" };
  const code = query.get("code");
  return code && /^[A-Za-z0-9._~-]{8,512}$/.test(code) ? { kind: "code", code } : { kind: "invalid" };
}

/** Short codes the login page turns into a sentence (/ingresar?google=<code>). Nothing of Google or Supabase is shown. */
export type GoogleSignInProblem = "cancelled" | "error" | "invalid" | "unverified" | "unavailable" | "network";
const messages: Record<GoogleSignInProblem, { tone: "info" | "error"; text: string }> = {
  cancelled: { tone: "info", text: "No se inició sesión con Google. Podés intentarlo de nuevo o ingresar con tu email." },
  error: { tone: "error", text: "No pudimos iniciar sesión con Google. Intentá nuevamente." },
  invalid: { tone: "error", text: "El inicio de sesión con Google no se completó. Empezá de nuevo desde acá." },
  unverified: { tone: "error", text: "Tu cuenta de Google no tiene el email verificado. Verificalo en Google o ingresá con tu email y contraseña." },
  unavailable: { tone: "error", text: "Iniciar sesión con Google no está disponible en este momento. Ingresá con tu email y contraseña." },
  network: { tone: "error", text: "No pudimos conectarnos. Revisá tu conexión e intentá de nuevo." },
};
export function googleSignInMessage(code: string | null): { tone: "info" | "error"; text: string } | null {
  return code && Object.hasOwn(messages, code) ? messages[code as GoogleSignInProblem] : null;
}

type OAuthReturnEventTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;
export type OAuthReturnWatcher = { arm(): void; disarm(): void; cleanup(): void };

/**
 * Notices that an OAuth attempt left this page and later returned to it without a callback. There is deliberately no
 * timer: a slow OAuth can stay away for as long as it needs. A focus/visible event only resets the UI after an earlier
 * blur/hidden/pagehide event, so an incidental focus while the request starts cannot enable a second attempt.
 */
export function watchOAuthReturn({ windowTarget, documentTarget, isVisible, onReturn }: {
  windowTarget: OAuthReturnEventTarget;
  documentTarget: OAuthReturnEventTarget;
  isVisible(): boolean;
  onReturn(): void;
}): OAuthReturnWatcher {
  let armed = false;
  let wasAway = false;
  const markAway = () => { if (armed) wasAway = true; };
  const returnIfReady = () => {
    if (!armed || !wasAway || !isVisible()) return;
    armed = false;
    wasAway = false;
    onReturn();
  };
  const visibilityChanged = () => { if (isVisible()) returnIfReady(); else markAway(); };

  windowTarget.addEventListener("blur", markAway);
  windowTarget.addEventListener("pagehide", markAway);
  windowTarget.addEventListener("focus", returnIfReady);
  windowTarget.addEventListener("pageshow", returnIfReady);
  documentTarget.addEventListener("visibilitychange", visibilityChanged);

  return {
    arm: () => { armed = true; wasAway = false; },
    disarm: () => { armed = false; wasAway = false; },
    cleanup: () => {
      armed = false;
      wasAway = false;
      windowTarget.removeEventListener("blur", markAway);
      windowTarget.removeEventListener("pagehide", markAway);
      windowTarget.removeEventListener("focus", returnIfReady);
      windowTarget.removeEventListener("pageshow", returnIfReady);
      documentTarget.removeEventListener("visibilitychange", visibilityChanged);
    },
  };
}

type User = { id: string; email_confirmed_at?: string | null };
type Session = { access_token: string; refresh_token: string; user: User };
export type FinishDeps = {
  /** Exchanges the code for a session (PKCE, with the verifier this browser kept). Throws when it cannot. */
  exchange(code: string): Promise<Session>;
  /** The person already signed in on Bellis's own client, if any. */
  currentUser(): Promise<User | null>;
  /** Hands the session to Bellis's own client, where every page reads it. */
  adopt(session: Session): Promise<void>;
  /** Ends a session that must not be used (an unverified email). */
  discard(session: Session): Promise<void>;
  /** Where this person goes: /registro/completar, /onboarding or /dashboard. */
  landing(userId: string): Promise<string>;
};

/**
 * The callback, after its query was read. A code works once: a second callback (a refresh, a second tab) finds the
 * session already there and goes on from it instead of failing. An email Google did not verify never becomes a
 * Bellis session. Returns where to go, or a problem code; never a token, a code or a provider message.
 */
export async function finishGoogleSignIn(callback: GoogleCallback, deps: FinishDeps): Promise<{ route: string } | { problem: GoogleSignInProblem }> {
  if (callback.kind !== "code") return { problem: callback.kind };
  let session: Session;
  try { session = await deps.exchange(callback.code); }
  catch {
    const already = await deps.currentUser().catch(() => null);
    if (already?.email_confirmed_at) return { route: await deps.landing(already.id) };
    return { problem: "invalid" };
  }
  if (!session.user?.email_confirmed_at) { await deps.discard(session).catch(() => undefined); return { problem: "unverified" }; }
  await deps.adopt(session);
  return { route: await deps.landing(session.user.id) };
}
