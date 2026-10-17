export function configuredOrigins(primary: string, additional: string): Set<string> {
  const origins = new Set([primary]);
  for (const value of additional.split(",").map((item) => item.trim())) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && url.origin === value) origins.add(value);
    } catch { /* Ignore malformed configuration entries. */ }
  }
  return origins;
}

// Vercel's per-deployment and per-branch addresses for the Bellis project in the bellis1 team. Keep this aligned with
// the browser-side Google Sign-In policy: another project, another team, a custom port or a non-HTTPS URL fails closed.
const bellisVercelHostname = /^bellis-[a-z0-9-]+-bellis1\.vercel\.app$/;

export function isBellisVercelOrigin(origin: string): boolean {
  try {
    const candidate = new URL(origin);
    return candidate.origin === origin && candidate.protocol === "https:" && candidate.port === "" &&
      bellisVercelHostname.test(candidate.hostname);
  } catch { return false; }
}

export function isAllowedOrigin(origin: string, origins: ReadonlySet<string>): boolean {
  return origins.has(origin) || /^http:\/\/localhost:\d+$/.test(origin);
}

/**
 * Public Agenda is also rendered by Bellis branch and immutable Vercel Previews. The hostname rule is restricted
 * to this project/team; it never becomes a general Vercel wildcard.
 */
export function isPublicOriginAllowed(origin: string, origins: ReadonlySet<string>): boolean {
  return isAllowedOrigin(origin, origins) || isBellisVercelOrigin(origin);
}

/**
 * A permitted caller gets its exact Origin echoed. A rejected caller deliberately gets no ACAO at all: returning
 * another permitted origin obscures configuration mistakes and can never authorize the requesting browser.
 */
export function publicCorsHeaders(origin: string | null, origins: ReadonlySet<string>): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-bellis-intent, apikey, authorization",
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
  if (origin && isPublicOriginAllowed(origin, origins)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

/**
 * Calendar connection verification is read-only and is needed from an authenticated Bellis Preview during QA.
 * The actions that start, complete or disconnect OAuth keep the exact configured-origin policy because their
 * redirect and mutation flow belongs to the stable environment.
 */
export function isGoogleCalendarOAuthOriginAllowed(
  action: string,
  origin: string,
  origins: ReadonlySet<string>,
): boolean {
  return isAllowedOrigin(origin, origins) || (action === "check" && isBellisVercelOrigin(origin));
}

/**
 * The checkout must return to the exact Bellis page that started it. Unlike CORS, there is no useful fallback:
 * replacing an invalid or missing caller with another environment loses the patient's booking context.
 */
export function checkoutReturnOrigin(origin: string | null, origins: ReadonlySet<string>): string | null {
  return origin && isPublicOriginAllowed(origin, origins) ? origin : null;
}

/**
 * CORS headers for a function called with the person's session (Authorization). The allowed origin is echoed back
 * only when it is one of the configured ones (or local development); any other origin gets the site's own origin, so
 * the browser refuses the answer. Never "*": the requests carry a session. The same headers go on every answer
 * (preflight, success and error) so a refusal is readable by an allowed page.
 */
export function sessionCorsHeaders(origin: string | null, origins: ReadonlySet<string>, primary: string): Record<string, string> {
  const caller = origin ?? "";
  return {
    "Access-Control-Allow-Origin": isAllowedOrigin(caller, origins) ? caller : primary,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, apikey, authorization",
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
}
