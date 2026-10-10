/** What is compared to warn about a patient that may already exist. Never the name: two people can share one. */
export type DuplicateCandidate = { id: string; full_name: string; phone: string | null; email: string | null; created_at?: string | null };
/**
 * `items` are the patient records that carry this same phone and email, most recent first; `records` is how many.
 * The match itself is the most recent one.
 */
export type DuplicateMatch = DuplicateCandidate & { by: ("phone" | "email")[]; records: number; items: DuplicateCandidate[] };
/**
 * `strong` is the entry that has the same phone and the same email as the patient being created: that person is
 * already in the workspace, so no new record is made. `weak` shares only one of the two and only warns.
 */
export type DuplicateCheck = { strong: DuplicateMatch | null; weak: DuplicateMatch[] };

/**
 * The ten national digits of an Argentine mobile, whatever prefix it was saved with:
 * +54 9 11 1234 5678, +54 11 1234 5678 and 11 1234 5678 give the same key. Null when there are not enough digits.
 */
export function phoneKey(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/** Emails compare without case or surrounding spaces. Null when empty. */
export function emailKey(value: string | null | undefined): string | null {
  const email = (value ?? "").trim().toLowerCase();
  return email || null;
}

/**
 * Candidates that share the phone or the email with the patient being created. It only informs: nothing is blocked.
 * A patient is listed once, whatever number of times it arrives. The public booking saves a new record for each
 * request, so one person can have several records: those with the same phone and the same email are shown as one
 * entry, the most recent, with their count. The name takes no part in it. A record missing the phone or the email
 * is never grouped, and neither are records that share only one of the two. Nothing is merged in the database.
 */
export function findDuplicates(input: { phone: string | null; email: string | null }, candidates: DuplicateCandidate[]): DuplicateMatch[] {
  const phone = phoneKey(input.phone), email = emailKey(input.email);
  const seen = new Set<string>();
  const groups = new Map<string, DuplicateMatch>();
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    const by: DuplicateMatch["by"] = [];
    if (phone && phoneKey(candidate.phone) === phone) by.push("phone");
    if (email && emailKey(candidate.email) === email) by.push("email");
    if (!by.length) continue;
    seen.add(candidate.id);
    const samePhone = phoneKey(candidate.phone), sameEmail = emailKey(candidate.email);
    const key = samePhone && sameEmail ? `${samePhone}|${sameEmail}` : `id:${candidate.id}`;
    const group = groups.get(key);
    // A stable sort: without dates the first record that arrived stays first.
    const items = group ? [...group.items, candidate].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "")) : [candidate];
    groups.set(key, { ...items[0], by, records: items.length, items });
  }
  return [...groups.values()];
}

/**
 * Whether the patient being created can be saved. Same phone and same email, both present, is a strong match and
 * blocks: the existing records are reviewed instead. Sharing only the phone or only the email warns and allows it.
 * The name never counts. Nothing is merged or changed in the database.
 */
export function checkDuplicates(input: { phone: string | null; email: string | null }, candidates: DuplicateCandidate[]): DuplicateCheck {
  const matches = findDuplicates(input, candidates);
  return { strong: matches.find((item) => item.by.length === 2) ?? null, weak: matches.filter((item) => item.by.length < 2) };
}

/** How the match is told to the person, e.g. "mismo teléfono y email". */
export function duplicateReason(match: DuplicateMatch): string {
  return match.by.length === 2 ? "mismo teléfono y email" : match.by[0] === "phone" ? "mismo teléfono" : "mismo email";
}
