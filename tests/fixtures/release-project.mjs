/**
 * A whole release, in scratch folders, for the tests of `check` and `staging`: a git repository with main, a
 * feature branch, the code commit and the manifest commit on top; the files the tooling reads (smokes, snapshot
 * configuration, migrations); and a fake Supabase CLI whose staging and production answer like the real ones would.
 * Nothing here reaches Supabase.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createGit } from "../../scripts/release/lib/git.mjs";
import { sqlHash } from "../../scripts/release/smoke/runner.mjs";
import { fakeCli, gitRepo, refs, releaseManifest, scratch } from "./release-harness.mjs";

export const baseMigration = "20261017090000_base.sql";
export const releaseMigration = "20261020090000_add_flag.sql";
export const migrationText = { [baseMigration]: "create table public.patients(id uuid primary key);\n", [releaseMigration]: "alter table public.patients add column flagged boolean not null default false;\n", "20261021090000_second.sql": "create index patients_flagged on public.patients(flagged);\n" };

/** What the catalogs say: a small schema, before and after the release's migration. */
export function schemaAnswer({ migrated = false, extraTable = false, applied } = {}) {
  const column = (name, type) => ({ name, type, not_null: true, default: null, identity: "", generated: "", collation: null, grants: [] });
  const tables = [{ id: "public.patients", owner: "postgres", kind: "r", rls: true, rls_forced: false, options: [], grants: ["authenticated:SELECT"], columns: [column("id", "uuid"), ...(migrated ? [column("flagged", "boolean")] : [])] }];
  if (extraTable) tables.push({ ...tables[0], id: "public.scratch", columns: [column("id", "uuid")] });
  return { database_time: "2026-10-14T00:00:00Z", server_version: "170011", applied_migrations: applied ?? (migrated ? ["20261017090000", "20261020090000"] : ["20261017090000"]), other_cron_jobs: 0,
    schemas: [{ id: "public", owner: "pg_database_owner", unknown: false, grants: ["anon:USAGE"] }], tables, constraints: [], indexes: [], policies: [], functions: [], views: [], triggers: [], types: [], sequences: [], default_privileges: [], extensions: [], cron: [] };
}
export const snapshotConfig = { version: 1, schemas: ["public"], tables: [{ table: "public.patients", mode: "fingerprint", key: ["id"] }, { table: "auth.users", mode: "count" }], ignored: [] };
export const database = () => ({ "public.patients": { columns: ["id", "first_name"], primaryKey: ["id"], rows: [{ id: "p1", first_name: "Ana" }, { id: "p2", first_name: "Zulema" }] }, "auth.users": { columns: ["id"], primaryKey: ["id"], rows: [{ id: "u1" }] } });

/**
 * Builds the release. `migrations` are the release's own files (default: one); `extraLocal` are more local files
 * that are not in the release; `manifest` overrides fields of the manifest.
 */
export function releaseProject(t, { migrations = [releaseMigration], extraLocal = [], manifest = {}, dirty = false } = {}) {
  const repo = gitRepo(t); const root = repo.dir;
  const put = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  put("lib/supabase-target.ts", `export const productionProjectRef = "${refs.production}";\n`);
  put("supabase/tests/a_one_smoke.sql", "begin;\nselect 1;\nrollback;\n");
  put("scripts/release/smoke/manifest.json", JSON.stringify({ version: 1, contract: { name: "bellis_smoke_v1", pass: "PASS" }, defaults: { timeoutSeconds: 60 }, groups: { core: "core", release: "release" },
    smokes: [{ id: "a_one", file: "supabase/tests/a_one_smoke.sql", groups: ["core", "release"], expect: { result: "PASS" } }] }));
  put("scripts/release/snapshot/tables.json", JSON.stringify(snapshotConfig));
  put(`supabase/migrations/${baseMigration}`, migrationText[baseMigration]);
  const mainBase = repo.commit("main");
  repo.git("checkout", "-q", "-b", "feat/release");
  for (const file of [...migrations, ...extraLocal]) put(`supabase/migrations/${file}`, migrationText[file] ?? `create table public.t_${file.slice(0, 14)}(id int);\n`);
  put("app.txt", "the code of the release\n");
  const source = repo.commit("code");
  const body = releaseManifest({ sourceCommit: source, expectedMainBase: mainBase, smokeGroups: ["release"], migrations: migrations.map((file) => ({ file, sha256: sqlHash(migrationText[file] ?? `create table public.t_${file.slice(0, 14)}(id int);\n`) })), ...manifest });
  put("releases/h2-9.json", JSON.stringify(body, null, 2) + "\n");
  const head = repo.commit("manifest");
  if (dirty) put("notes.txt", "uncommitted\n");
  return { root, repo, mainBase, source, head, manifest: body, home: scratch(t, "bellis-home-"), git: createGit({ cwd: root }) };
}

/** A fake CLI whose staging has the base applied and the release pending, and whose production is the base. */
export function releaseCli(t, { applied = ["20261017090000"], pending = [releaseMigration], ...behaviour } = {}) {
  return fakeCli(t, { applied, pushable: pending, schema: schemaAnswer(), schemaRehearsed: schemaAnswer({ migrated: true }), schemaAfterPush: schemaAnswer({ migrated: true }),
    schemaByRef: { [refs.production]: schemaAnswer() }, db: database(), snapshotConfig, ...behaviour });
}
