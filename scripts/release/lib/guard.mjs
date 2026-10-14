/**
 * Release tooling: a read-only view of the Supabase CLI, for the commands that read production.
 *
 * Everything that would write is refused before the CLI is run: `db push` that is not a dry run, and any SQL that is
 * not a single read-only transaction that is rolled back (so no smoke, no rehearsal, no insert, update or delete, no
 * function call that writes outside such a transaction). Reading the link, the account's list of projects, linking
 * (which only changes the local link file) and dry runs go through.
 */
import { readFileSync } from "node:fs";
import { ReleaseError, EXIT } from "./report.mjs";
import { statements, validateSmokeSql } from "../smoke/sql.mjs";

export class WriteRefused extends ReleaseError {
  constructor(message) { super(message, { exitCode: EXIT.CHECK_FAILED, stage: "write guard" }); }
}

/** Whether a piece of SQL is one transaction opened READ ONLY and rolled back, with nothing outside it. */
export function isReadOnlySql(sql) {
  const shape = validateSmokeSql(sql); if (!shape.ok) return false;
  const words = statements(sql)[0].tokens.map((token) => token.value);
  return words[0] === "begin" && words.includes("read") && words.at(-1) === "only" && words.at(-2) === "read";
}

/** The CLI, unable to write. `operation` names what is running, for the refusal. */
export function readOnly(supabase, { operation = "a read-only command" } = {}) {
  return {
    source: supabase.source,
    linkedRef: () => supabase.linkedRef(),
    link: (ref) => supabase.link(ref),
    projects: () => supabase.projects(),
    version: () => supabase.version(),
    query(file, options) {
      let sql; try { sql = readFileSync(file, "utf8"); } catch { throw new WriteRefused(`Refused during ${operation}: the SQL could not be read, so it cannot be shown to be read-only.`); }
      if (!isReadOnlySql(sql)) throw new WriteRefused(`Refused during ${operation}: only a read-only transaction that is rolled back may run.`);
      return supabase.query(file, options);
    },
    push(options = {}) {
      if (options.dryRun !== true) throw new WriteRefused(`Refused during ${operation}: db push may only run as a dry run.`);
      return supabase.push({ dryRun: true });
    },
  };
}
