/**
 * `bellis:staging --reuse-rehearsal <folder>`: an applied release whose state lost its rehearsal (the state was moved
 * aside because the source commit changed) reuses an earlier rehearsal only when every condition holds. Against a
 * scratch repository and the fake Supabase CLI; nothing reaches Supabase.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { main } from "../scripts/release/cli.mjs";
import { EXIT } from "../scripts/release/lib/report.mjs";
import { createState } from "../scripts/release/lib/state.mjs";
import { judgeRehearsalReuse, readEarlierRehearsal } from "../scripts/release/stages/rehearsal-reuse.mjs";
import { sqlHash } from "../scripts/release/smoke/runner.mjs";
import { releaseCli, releaseMigration, releaseProject, schemaAnswer } from "./fixtures/release-project.mjs";
import { forbidden, refs } from "./fixtures/release-harness.mjs";

const quiet = { on() {}, off() {} };
async function invoke(argv, { made, cli }) {
  let output = "";
  const code = await main(argv, { root: made.root, environment: cli.environment, home: made.home, write: (text) => { output += text; }, supabase: cli.supabase, git: made.git, signals: quiet, runLocal: () => ({ ok: true, summary: "fine" }) });
  return { code, output };
}
const sectionOf = (output, name) => output.split(/^## /m).find((part) => part.startsWith(`${name}\n`)) ?? "";
const statusOf = (output, name) => sectionOf(output, name).split("\n")[1];
const releases = (made) => join(made.home, "Bellis-Releases");
const fileOf = (made, folder, name) => join(releases(made), folder, `${name}.json`);
const readState = (made, folder, name) => JSON.parse(readFileSync(fileOf(made, folder, name), "utf8"));
const writeState = (made, folder, name, change) => { const document = readState(made, folder, name); change(document); writeFileSync(fileOf(made, folder, name), JSON.stringify(document, null, 2)); };
const writes = (cli) => cli.state().pushes ?? 0;
const second = "20261021090000_second.sql";

/**
 * The h3-1a situation, in small: the release goes to staging (rehearsed, applied), its state is moved aside, and the
 * source commit changes without touching any migration (a new commit, and the manifest pointed at it).
 */
async function appliedThenMovedAside(t, { migrations = [releaseMigration], changeSource = true } = {}) {
  const made = releaseProject(t, { migrations }); const cli = releaseCli(t, { pending: migrations });
  const first = await invoke(["staging", "--release", "h2-9"], { made, cli });
  assert.equal(first.code, EXIT.PASS, first.output); assert.equal(writes(cli), 1);
  renameSync(join(releases(made), "h2-9"), join(releases(made), "h2-9-archive"));
  if (changeSource) {
    writeFileSync(join(made.root, "app.txt"), "the code of the release, with a security fix\n");
    const source = made.repo.commit("security fix");
    const manifest = JSON.parse(readFileSync(join(made.root, "releases", "h2-9.json"), "utf8"));
    writeFileSync(join(made.root, "releases", "h2-9.json"), JSON.stringify({ ...manifest, sourceCommit: source }, null, 2) + "\n");
    made.repo.commit("manifest again");
  }
  return { made, cli };
}
/** Nothing was reused or saved, nothing was written to a database, and the CLI is on staging. */
function assertNothingReused(made, cli, out) {
  assert.equal(statusOf(out.output, "REHEARSAL"), "FAIL", out.output);
  for (const name of ["schema-base", "schema-expected", "rehearsal-reuse", "snapshot-staging-pre"]) assert.equal(existsSync(fileOf(made, "h2-9", name)), false, `${name} was saved`);
  assert.equal(writes(cli), 1, "nothing applied again"); assert.equal(cli.linkedFile(), refs.staging);
  assert.notEqual(cli.state().pushedOn, refs.production);
  for (const secret of forbidden) assert.ok(!out.output.includes(secret));
}

test("reuse: same migration and hash, staging an exact match of the earlier expected schema: PASS, clearly recorded, nothing applied", async (t) => {
  const { made, cli } = await appliedThenMovedAside(t);
  // Without the option it still stops for a person, exactly as before.
  let out = await invoke(["staging", "--release", "h2-9"], { made, cli });
  assert.equal(out.code, EXIT.HUMAN_ACTION_REQUIRED, out.output); assert.match(out.output, /no rehearsal of this release/);
  out = await invoke(["staging", "--release", "h2-9", "--reuse-rehearsal", "h2-9-archive"], { made, cli });
  assert.equal(out.code, EXIT.PASS, out.output);
  for (const [section, status] of Object.entries({ REHEARSAL: "PASS", "STAGING APPLY": "NOT NEEDED", "EXPECTED DRIFT": "PASS", SMOKES: "PASS", SNAPSHOT: "IDENTICAL", RESIDUE: "NONE", "CLI FINAL TARGET": "STAGING", STATE: "STAGING_COMPLETE" }))
    assert.equal(statusOf(out.output, section), status, section);
  const rehearsal = sectionOf(out.output, "REHEARSAL");
  assert.match(rehearsal, /REUSED: the rehearsal of h2-9-archive/); assert.match(rehearsal, /20261020090000_add_flag\.sql: sha256 [0-9a-f]{12}, the same as rehearsed/);
  assert.match(rehearsal, /EXACT MATCH of the rehearsal's expected schema/);
  assert.equal(writes(cli), 1, "nothing applied again"); assert.equal(cli.linkedFile(), refs.staging);
  const record = readState(made, "h2-9", "rehearsal-reuse").data;
  assert.equal(record.mode, "reused"); assert.equal(record.source, "h2-9-archive"); assert.equal(record.actor, "tooling"); assert.equal(record.stagingMatch, "EXACT MATCH");
  assert.deepEqual(record.migrationHashes, [{ file: releaseMigration, sha256: sqlHash(readFileSync(join(made.root, "supabase", "migrations", releaseMigration), "utf8")) }]);
  assert.match(record.schemaExpectedHash, /^[0-9a-f]{64}$/); assert.match(record.verifiedAt, /^\d{4}-/);
  assert.equal(record.rehearsalCommit, made.head, "rehearsed at the first manifest commit");
  const all = readState(made, "h2-9", "release-state").data.history;
  assert.ok(all.some((entry) => entry.state === "rehearsal" && entry.result === "FAIL"), "the run without the option is written down as stopped");
  const history = all.filter((entry) => !entry.rerun && entry.result === "PASS");
  assert.deepEqual(history.map((entry) => entry.state), ["CHECKED", "REHEARSED", "STAGING_APPLIED", "STAGING_VERIFIED", "STAGING_COMPLETE"]);
  assert.match(history[1].detail, /^REUSED the rehearsal of h2-9-archive/);
  // The earlier state is only read.
  assert.equal(readState(made, "h2-9-archive", "release-state").data.state, "STAGING_COMPLETE");
  // Run again: it resumes from its own (reused) rehearsal, says so, and still applies nothing.
  out = await invoke(["staging", "--release", "h2-9"], { made, cli });
  assert.equal(out.code, EXIT.PASS, out.output); assert.match(sectionOf(out.output, "REHEARSAL"), /REUSED earlier: the rehearsal of h2-9-archive/); assert.equal(writes(cli), 1);
});

test("reuse: several migrations with exactly the same hashes and order: PASS; another order, one missing or one more: FAIL", async (t) => {
  // Real captures from a staging run, judged directly: the release lists two migrations and so did the rehearsal.
  const { made } = await appliedThenMovedAside(t);
  const state = createState({ repository: made.root, home: made.home });
  const earlier = readEarlierRehearsal(state, "h2-9-archive");
  const migrations = [{ file: releaseMigration, sha256: "a".repeat(64) }, { file: second, sha256: "b".repeat(64) }];
  const judged = (rehearsed, listed = migrations) => {
    const copy = JSON.parse(JSON.stringify(earlier)); copy.expected.data.meta.rehearsed = rehearsed;
    return judgeRehearsalReuse({ release: "h2-9", manifest: { migrations: listed, expectedMainBase: made.mainBase }, head: made.git.commit("HEAD"), git: made.git, earlier: copy, stagingNow: copy.expected.data });
  };
  const passed = judged(migrations);
  assert.equal(passed.ok, true, passed.problems.join("; ")); assert.deepEqual(passed.record.migrationHashes, migrations); assert.equal(passed.record.mode, "reused");
  for (const rehearsed of [[...migrations].reverse(), [migrations[0]], [...migrations, { file: "20261022090000_third.sql", sha256: "c".repeat(64) }], [migrations[0], { ...migrations[1], sha256: "d".repeat(64) }]]) {
    const failed = judged(rehearsed);
    assert.equal(failed.ok, false); assert.equal(failed.record, null); assert.match(failed.problems.join(" "), /not exactly the release's/);
  }
});

test("reuse fails closed: same file name with another hash", async (t) => {
  // The migration itself changed after the rehearsal, and the manifest was updated to its new hash.
  const { made, cli } = await appliedThenMovedAside(t);
  const changed = "alter table public.patients add column flagged boolean not null default true;\n";
  writeFileSync(join(made.root, "supabase", "migrations", releaseMigration), changed);
  const source = made.repo.commit("migration changed");
  const manifest = JSON.parse(readFileSync(join(made.root, "releases", "h2-9.json"), "utf8"));
  writeFileSync(join(made.root, "releases", "h2-9.json"), JSON.stringify({ ...manifest, sourceCommit: source, migrations: [{ file: releaseMigration, sha256: sqlHash(changed) }] }, null, 2) + "\n");
  made.repo.commit("manifest again");
  const out = await invoke(["staging", "--release", "h2-9", "--reuse-rehearsal", "h2-9-archive"], { made, cli });
  assert.equal(out.code, EXIT.CHECK_FAILED, out.output); assert.match(out.output, /not exactly the release's \(names, order and SHA-256\)/); assertNothingReused(made, cli, out);
  // The same, when only the earlier rehearsal's record of the hash differs.
  const other = await appliedThenMovedAside(t);
  writeState(other.made, "h2-9-archive", "schema-expected", (document) => { document.data.meta.rehearsed[0].sha256 = "0".repeat(64); });
  const again = await invoke(["staging", "--release", "h2-9", "--reuse-rehearsal", "h2-9-archive"], other);
  assert.equal(again.code, EXIT.CHECK_FAILED); assertNothingReused(other.made, other.cli, again);
});

test("reuse fails closed: the earlier expected schema or base is missing, or not a valid capture", async (t) => {
  for (const [name, change] of [["schema-expected", null], ["schema-base", null], ["schema-expected", (document) => { delete document.data.meta; }], ["schema-base", (document) => { document.data.objects = "nope"; }]]) {
    const { made, cli } = await appliedThenMovedAside(t);
    if (change) writeState(made, "h2-9-archive", name, change); else rmSync(fileOf(made, "h2-9-archive", name));
    const out = await invoke(["staging", "--release", "h2-9", "--reuse-rehearsal", "h2-9-archive"], { made, cli });
    assert.equal(out.code, EXIT.CHECK_FAILED, `${name}: ${out.output}`); assert.match(sectionOf(out.output, "REHEARSAL"), change ? /incomplete or not valid|not the (base|expected)/ : /capture of the rehearsal is missing/); assertNothingReused(made, cli, out);
  }
});

test("reuse fails closed: the earlier rehearsal never finished", async (t) => {
  const { made, cli } = await appliedThenMovedAside(t);
  writeState(made, "h2-9-archive", "release-state", (document) => { document.data.state = "CHECKED"; document.data.history = document.data.history.filter((entry) => entry.state === "CHECKED"); });
  const out = await invoke(["staging", "--release", "h2-9", "--reuse-rehearsal", "h2-9-archive"], { made, cli });
  assert.equal(out.code, EXIT.CHECK_FAILED); assert.match(out.output, /its rehearsal did not finish/); assertNothingReused(made, cli, out);
  const failed = await appliedThenMovedAside(t);
  writeState(failed.made, "h2-9-archive", "release-state", (document) => { for (const entry of document.data.history) if (entry.state === "REHEARSED") entry.result = "FAIL"; });
  const again = await invoke(["staging", "--release", "h2-9", "--reuse-rehearsal", "h2-9-archive"], failed);
  assert.equal(again.code, EXIT.CHECK_FAILED); assertNothingReused(failed.made, failed.cli, again);
  const nothing = await appliedThenMovedAside(t);
  const none = await invoke(["staging", "--release", "h2-9", "--reuse-rehearsal", "h2-9-nowhere"], nothing);
  assert.equal(none.code, EXIT.CHECK_FAILED); assert.match(none.output, /has no release state/); assertNothingReused(nothing.made, nothing.cli, none);
});

test("reuse fails closed: staging is not an exact match of the earlier expected schema", async (t) => {
  const { made, cli } = await appliedThenMovedAside(t);
  cli.set({ schemaAfterPush: schemaAnswer({ migrated: true, extraTable: true }), schema: schemaAnswer({ migrated: true, extraTable: true }) });
  const out = await invoke(["staging", "--release", "h2-9", "--reuse-rehearsal", "h2-9-archive"], { made, cli });
  assert.equal(out.code, EXIT.CHECK_FAILED, out.output); assert.match(out.output, /not an exact match of the rehearsal's expected schema/); assertNothingReused(made, cli, out);
});

test("reuse fails closed: a pending migration, or a migration staging has that this repository does not", async (t) => {
  const pending = await appliedThenMovedAside(t);
  writeFileSync(join(pending.made.root, "supabase", "migrations", "20261022090000_later.sql"), "create table public.later(id int);\n");
  pending.made.repo.commit("a later migration");
  const manifest = JSON.parse(readFileSync(join(pending.made.root, "releases", "h2-9.json"), "utf8"));
  writeFileSync(join(pending.made.root, "releases", "h2-9.json"), JSON.stringify({ ...manifest, sourceCommit: pending.made.git.commit("HEAD") }, null, 2) + "\n");
  pending.made.repo.commit("manifest again");
  let out = await invoke(["staging", "--release", "h2-9", "--reuse-rehearsal", "h2-9-archive"], pending);
  assert.equal(out.code, EXIT.CHECK_FAILED, out.output); assert.match(out.output, /pending migrations that are not part of this release/);
  for (const name of ["schema-expected", "rehearsal-reuse"]) assert.equal(existsSync(fileOf(pending.made, "h2-9", name)), false);
  assert.equal(writes(pending.cli), 1);
  const unknown = await appliedThenMovedAside(t);
  unknown.cli.set({ applied: [...unknown.cli.state().applied ?? ["20261017090000", "20261020090000"], "20261099090000"] });
  out = await invoke(["staging", "--release", "h2-9", "--reuse-rehearsal", "h2-9-archive"], unknown);
  assert.equal(out.code, EXIT.CHECK_FAILED, out.output); assert.match(out.output, /migrations that are not in this repository/);
  for (const name of ["schema-expected", "rehearsal-reuse"]) assert.equal(existsSync(fileOf(unknown.made, "h2-9", name)), false);
});

test("reuse fails closed: the earlier state is of another release, or was rehearsed off the release's line of commits", async (t) => {
  const cases = [
    ["release-state", (document) => { document.data.releaseId = "h2-8"; }, /state of another release/],
    ["release-state", (document) => { document.release = "h2-8"; }, /state of another release/],
    ["schema-expected", (document) => { document.data.meta.release = "h2-8"; }, /not the expected of this release/],
    ["schema-base", (document) => { document.release = "h2-8"; }, /captures belong to another release/],
    ["schema-expected", (document) => { document.data.meta.gitCommit = "f".repeat(40); }, /not captured at one known commit/],
  ];
  for (const [name, change, pattern] of cases) {
    const { made, cli } = await appliedThenMovedAside(t);
    writeState(made, "h2-9-archive", name, change);
    const out = await invoke(["staging", "--release", "h2-9", "--reuse-rehearsal", "h2-9-archive"], { made, cli });
    assert.equal(out.code, EXIT.CHECK_FAILED, out.output); assert.match(out.output, pattern); assertNothingReused(made, cli, out);
  }
  // Rehearsed at a commit that is not on the way from the main base to HEAD.
  const { made, cli } = await appliedThenMovedAside(t);
  made.repo.git("checkout", "-q", "-b", "elsewhere", made.mainBase); writeFileSync(join(made.root, "other.txt"), "x\n"); const elsewhere = made.repo.commit("elsewhere");
  made.repo.git("checkout", "-q", "feat/release");
  for (const name of ["schema-base", "schema-expected"]) writeState(made, "h2-9-archive", name, (document) => { document.data.meta.gitCommit = elsewhere; });
  const out = await invoke(["staging", "--release", "h2-9", "--reuse-rehearsal", "h2-9-archive"], { made, cli });
  assert.equal(out.code, EXIT.CHECK_FAILED, out.output); assert.match(out.output, /is not an ancestor of HEAD/); assertNothingReused(made, cli, out);
});

test("reuse is refused where it does not apply: a release not applied yet, its own folder, or with --confirm-preview", async (t) => {
  const made = releaseProject(t); const cli = releaseCli(t);
  let out = await invoke(["staging", "--release", "h2-9", "--reuse-rehearsal", "h2-9-archive"], { made, cli });
  assert.equal(out.code, EXIT.PRECONDITION_OR_USAGE, out.output); assert.match(out.output, /only for a release whose migrations are all applied/); assert.equal(writes(cli), 0);
  const moved = await appliedThenMovedAside(t);
  renameSync(join(releases(moved.made), "h2-9-archive"), join(releases(moved.made), "h2-9-old"));
  out = await invoke(["staging", "--release", "h2-9", "--reuse-rehearsal", "h2-9"], moved);
  assert.equal(out.code, EXIT.CHECK_FAILED, out.output); assert.match(out.output, /another folder than this release's own/);
  out = await invoke(["staging", "--release", "h2-9", "--reuse-rehearsal", "h2-9-old", "--confirm-preview", "h2-9"], moved);
  assert.equal(out.code, EXIT.PRECONDITION_OR_USAGE); assert.match(out.output, /cannot be combined with --confirm-preview/);
  out = await invoke(["staging", "--release", "h2-9", "--reuse-rehearsal", "../escape"], moved);
  assert.equal(out.code, EXIT.CHECK_FAILED); assert.match(out.output, /not a release folder name/);

});
