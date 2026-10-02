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
