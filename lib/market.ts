export type MarketConfig = {
  country: string;
  currency: string;
  timezone: string;
  locale: string;
  paymentProvider: string;
};

export const DEFAULT_MARKET: MarketConfig = {
  country: "AR",
  currency: "ARS",
  timezone: "America/Argentina/Buenos_Aires",
  locale: "es-AR",
  paymentProvider: "mercado_pago_ar",
};

export function formatMoney(amount: number, market: MarketConfig = DEFAULT_MARKET): string {
  const number = new Intl.NumberFormat(market.locale, { maximumFractionDigits: 0 }).format(amount);
  return `$${number} ${market.currency}`;
}

export function formatDate(isoDate: string, market: MarketConfig = DEFAULT_MARKET): string {
  return new Intl.DateTimeFormat(market.locale, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: market.timezone }).format(new Date(`${isoDate}T12:00:00Z`));
}

export function formatDateTime(instant: string | Date, market: MarketConfig = DEFAULT_MARKET): string {
  return new Intl.DateTimeFormat(market.locale, {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: market.timezone,
  }).format(typeof instant === "string" ? new Date(instant) : instant);
}

/** Best-effort normalization for Argentine mobile numbers. Keep invalid input visible for correction. */
export function normalizeArgentinePhone(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  let national = digits.startsWith("549") ? digits.slice(3) : digits.startsWith("54") ? digits.slice(2).replace(/^9/, "") : digits.replace(/^0/, "");
  // Locally written mobiles sometimes include the legacy 15 after the area code.
  if (national.length === 12 && national.slice(2, 4) === "15") national = national.slice(0, 2) + national.slice(4);
  return national.length === 10 ? `+549${national}` : null;
}
