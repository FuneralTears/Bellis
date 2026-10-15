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

export function isAllowedOrigin(origin: string, origins: ReadonlySet<string>): boolean {
  return origins.has(origin) || /^http:\/\/localhost:\d+$/.test(origin);
}

export function checkoutReturnOrigin(origin: string | null, primary: string, origins: ReadonlySet<string>): string {
  return origin && origins.has(origin) ? origin : primary;
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
