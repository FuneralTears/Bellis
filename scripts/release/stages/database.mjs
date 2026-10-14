/**
 * Release tooling: two small read-only questions to a database, each a read-only transaction that is rolled back.
 *   migrationHistory  which migration versions are applied (supabase_migrations.schema_migrations)
 *   residue           how much the smokes could have left behind: synthetic users, workspaces and slugs (counts)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckFailed, redact } from "../lib/report.mjs";

function ask(supabase, sql, column, { temporary = tmpdir(), what }) {
  const dir = mkdtempSync(join(temporary, "bellis-ask-"));
  try {
    const file = join(dir, "query.sql"); writeFileSync(file, sql, "utf8");
    const answer = supabase.query(file, { columns: [column], timeoutMs: 120_000 });
    if (!answer.ok) throw new CheckFailed(`The ${what} could not be read.`, { stage: what, details: [redact(answer.reason, 240)] });
    let value; try { value = JSON.parse(answer.rows[0]?.[column] ?? ""); } catch { throw new CheckFailed(`The ${what} could not be read.`, { stage: what }); }
    return value;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export const historySql = `-- Bellis migration history. Read-only.
begin transaction read only;
select coalesce(jsonb_agg(m.version order by m.version), '[]'::jsonb) as versions from supabase_migrations.schema_migrations m;
rollback;
`;
/** The applied migration versions, sorted. */
export function migrationHistory(supabase, options = {}) {
  const versions = ask(supabase, historySql, "versions", { ...options, what: "migration history" });
  if (!Array.isArray(versions) || versions.some((version) => !/^\d{14}$/.test(String(version)))) throw new CheckFailed("The migration history could not be read.", { stage: "migration history" });
  return versions.map(String).sort();
}

export const residueSql = `-- Bellis residue check. Read-only: counts only, no row is read.
begin transaction read only;
select jsonb_build_object(
  'users_example_invalid', (select count(*) from auth.users where email like '%@example.invalid'),
  'users_with_smoke_ids', (select count(*) from auth.users where id::text ~ '^f[0-9a-f]{7}-0000-4000-8000-'),
  'workspaces_with_smoke_ids', (select count(*) from public.workspaces where id::text ~ '^f[0-9a-f]{7}-0000-4000-8000-'),
  'workspaces_with_smoke_slugs', (select count(*) from public.workspaces where slug ~ '^(crm-phase|phase6-roles|patient-crm-phase|oauth-smoke|h28-)')
) as residue;
rollback;
`;
/** { counts, total }: what the smokes could have left behind. Everything has to be 0. */
export function residue(supabase, options = {}) {
  const counts = ask(supabase, residueSql, "residue", { ...options, what: "residue check" });
  const names = ["users_example_invalid", "users_with_smoke_ids", "workspaces_with_smoke_ids", "workspaces_with_smoke_slugs"];
  if (!counts || typeof counts !== "object" || names.some((name) => !Number.isSafeInteger(counts[name]))) throw new CheckFailed("The residue check could not be read.", { stage: "residue check" });
  const kept = Object.fromEntries(names.map((name) => [name, counts[name]]));
  return { counts: kept, total: Object.values(kept).reduce((sum, value) => sum + value, 0) };
}

/** How the applied versions compare with the local files and the release: { pending, remoteOnly }. */
export function compareHistory(applied, localFiles) {
  const localVersions = localFiles.map((file) => file.slice(0, 14));
  return { pending: localFiles.filter((file) => !applied.includes(file.slice(0, 14))), remoteOnly: applied.filter((version) => !localVersions.includes(version)) };
}
