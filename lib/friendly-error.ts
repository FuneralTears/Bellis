/**
 * What a person reads when something fails. Messages Bellis wrote itself are kept; anything that comes straight
 * from the database, the network or a library (codes, English, SQL) is replaced by `fallback`, which says what to do.
 */
export function friendlyError(caught: unknown, fallback = "No pudimos completar la acción. Intentá de nuevo."): string {
  const message = caught instanceof Error ? caught.message : typeof caught === "string" ? caught
    : typeof (caught as { message?: unknown } | null)?.message === "string" ? (caught as { message: string }).message : "";
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) return "No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.";
  if (/\bJWT\b|authentication_required|not authenticated|invalid claim|session.*(missing|expired)/i.test(message)) return "Tu sesión venció. Volvé a ingresar.";
  if (/not_authorized|permission denied|row-level security/i.test(message)) return "No tenés permiso para hacer esto.";
  if (/pro_access_required/.test(message)) return "Esta función es parte de Bellis Pro.";
  return isOwnMessage(message) ? message : fallback;
}

/** A sentence written for people: starts like one, ends like one, and carries no code or database wording. */
function isOwnMessage(message: string): boolean {
  if (!/^[A-ZÁÉÍÓÚÑ¿¡]/.test(message) || !/[.!?…]$/.test(message)) return false;
  if (/[a-z0-9]_[a-z0-9]|[{}<>;=]|\b(null|undefined|violates|constraint|relation|column|schema|function|duplicate key|syntax|unexpected|timeout|PGRST\d*|SQLSTATE|TypeError|fetch)\b/i.test(message)) return false;
  return true;
}
