/**
 * `bellis:check` and `bellis:staging`, end to end, against a scratch repository and the fake Supabase CLI. Nothing
 * here reaches Supabase, runs the real test suite or builds the app: the local commands are replaced too.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { main } from "../scripts/release/cli.mjs";
import { manifestProblems } from "../scripts/release/lib/manifest.mjs";
import { EXIT, ReleaseError, TargetNotConfirmed } from "../scripts/release/lib/report.mjs";
import { createState } from "../scripts/release/lib/state.mjs";
import { assertWritable } from "../scripts/release/lib/target.mjs";
import { openReleaseState, requiredStates } from "../scripts/release/stages/release-state.mjs";
import { releaseMode } from "../scripts/release/stages/staging.mjs";
import { database, releaseCli, releaseMigration, releaseProject, schemaAnswer } from "./fixtures/release-project.mjs";
import { fakeCli, forbidden, refs, releaseManifest, scratch } from "./fixtures/release-harness.mjs";

const quiet = { on() {}, off() {} };
const passing = () => ({ ok: true, summary: "fine" });
async function invoke(t, argv, { made, cli = fakeCli(t), runLocal = passing } = {}) {
  let output = ""; const steps = [];
  const code = await main(argv, { root: made.root, environment: cli.environment, home: made.home, write: (text) => { output += text; }, supabase: cli.supabase, git: made.git, signals: quiet,
    runLocal: (step, options) => { steps.push(step); return runLocal(step, options); } });
  return { code, output, cli, steps };
}
const sectionOf = (output, name) => output.split(/^## /m).find((part) => part.startsWith(`${name}\n`)) ?? "";
const statusOf = (output, name) => sectionOf(output, name).split("\n")[1];
const stateOf = (made) => JSON.parse(readFileSync(join(made.home, "Bellis-Releases", "h2-9", "release-state.json"), "utf8")).data;
const writes = (cli) => cli.state().pushes ?? 0;
const assertClean = (text) => { for (const secret of forbidden) assert.ok(!text.includes(secret), `leaked: ${secret}`); };
/** Every failure has to leave the CLI on staging, no write anywhere else, and nothing secret in what was shown or kept. */
function assertSafeEnd(made, out) {
  assert.equal(out.cli.linkedFile(), refs.staging, "the CLI ends on staging");
  assert.notEqual(out.cli.state().pushedOn, refs.production, "nothing was ever pushed to production");
  assertClean(out.output);
  const folder = join(made.home, "Bellis-Releases", "h2-9"); if (existsSync(folder)) for (const file of readdirSync(folder)) assertClean(readFileSync(join(folder, file), "utf8"));
}

test("manifest: a valid one, and every way of getting it wrong", () => {
  const good = releaseManifest({ migrations: [{ file: "20261020090000_a.sql", sha256: "a".repeat(64) }, { file: "20261021090000_b.sql", sha256: "b".repeat(64) }], branch: "feat/x", notes: "a note" });
  assert.deepEqual(manifestProblems(good, { releaseId: "h2-9", smokeGroups: ["core", "release"] }), []);
  assert.deepEqual(manifestProblems(releaseManifest(), { releaseId: "h2-9" }), [], "no migrations is a valid release");
  const broken = (change, pattern, options = { releaseId: "h2-9", smokeGroups: ["core", "release"] }) => { const manifest = JSON.parse(JSON.stringify(good)); change(manifest); assert.match(manifestProblems(manifest, options).join(" | "), pattern); };
  broken((m) => { m.extra = 1; }, /unknown field: extra/);
  broken((m) => { delete m.previewRequired; }, /missing field: previewRequired/);
  broken((m) => { m.migrations[1] = { ...m.migrations[0] }; }, /is listed twice/);
  broken((m) => { m.migrations[0].sha256 = "xyz"; }, /sha256: has to be a SHA-256/);
  broken((m) => { m.migrations.reverse(); }, /not in the order they are applied/);
  broken((m) => { m.migrations[0].file = "../evil.sql"; }, /the file name of a migration/);
  broken((m) => { m.migrations[0].path = "x"; }, /unknown field path/);
  broken((m) => { m.sourceCommit = "abc123"; }, /sourceCommit: has to be a full commit SHA/);
  broken((m) => { m.expectedMainBase = "z".repeat(40); }, /expectedMainBase: has to be a full commit SHA/);
  broken((m) => { m.releaseId = "../h2-9"; }, /releaseId: lowercase letters/);
  broken((m) => { m.releaseId = "h2-10"; }, /the file is releases\/h2-9\.json/);
  broken((m) => { m.smokeGroups = ["nope"]; }, /unknown group nope/);
  broken((m) => { m.smokeGroups = []; }, /non-empty list/);
  broken((m) => { m.previewRequired = "no"; }, /true or false/);
  broken((m) => { m.createdAt = "yesterday"; }, /ISO time/);
  broken((m) => { m.branch = "../main"; }, /not a branch name/);
  broken((m) => { m.notes = "deploy with postgres://postgres:hunter2@db.x.supabase.co/postgres"; }, /looks like a credential/);
  for (const id of ["../x", "a/b", "a..b", "X", ""]) assert.match(manifestProblems({ ...good, releaseId: id }).join(), /releaseId/, id);
});

test("state machine: no skipping, re-runs are written down, and a state of another manifest is refused", (t) => {
  const state = createState({ repository: scratch(t), environment: {}, home: scratch(t) });
  const manifest = releaseManifest({ migrations: [{ file: "20261020090000_a.sql", sha256: "a".repeat(64) }], previewRequired: true });
  assert.deepEqual(requiredStates(manifest), ["CHECKED", "REHEARSED", "STAGING_APPLIED", "STAGING_VERIFIED", "PREVIEW_PENDING", "STAGING_COMPLETE", "PROD_PRECHECK_COMPLETE",
    "PROD_APPLIED", "PROD_VERIFIED", "MAIN_ADVANCED", "DEPLOY_PROD_VERIFIED", "RELEASE_COMPLETE"]);
  assert.deepEqual(requiredStates(releaseManifest()), ["CHECKED", "STAGING_VERIFIED", "STAGING_COMPLETE", "PROD_PRECHECK_COMPLETE", "PROD_VERIFIED", "MAIN_ADVANCED", "DEPLOY_PROD_VERIFIED", "RELEASE_COMPLETE"]);
  const progress = openReleaseState(state, "h2-9", { manifest, manifestHash: "h1" });
  assert.throws(() => progress.advance("REHEARSED"), /CHECKED comes first/);
  progress.advance("CHECKED", { commit: "c1" }); assert.throws(() => progress.advance("STAGING_APPLIED"), /REHEARSED comes first/);
  progress.advance("REHEARSED"); progress.advance("CHECKED", { commit: "c1" });
  assert.equal(progress.state, "REHEARSED", "a check run again does not move the release back"); assert.equal(progress.history.at(-1).rerun, true);
  assert.throws(() => openReleaseState(state, "h2-9", { manifest, manifestHash: "h2" }), /another version of its manifest/);
  assert.equal(openReleaseState(state, "h2-9", { manifest, manifestHash: "h1" }).state, "REHEARSED", "it is picked up again");
  assert.throws(() => openReleaseState(state, "h2-9", { manifest: releaseManifest(), manifestHash: "h1" }).advance("REHEARSED"), /not a state this release goes through|another version/);
  assert.equal(releaseMode([], []), "empty"); assert.equal(releaseMode(["20261020090000"], ["20261020090000_a.sql"]), "all");
  assert.equal(releaseMode([], ["20261020090000_a.sql"]), "apply"); assert.equal(releaseMode(["20261020090000"], ["20261020090000_a.sql", "20261021090000_b.sql"]), "partial");
});

test("check: a valid release passes every step and is recorded as CHECKED, without touching Supabase", async (t) => {
  const made = releaseProject(t);
  const out = await invoke(t, ["check", "--release", "h2-9"], { made });
  assert.equal(out.code, EXIT.PASS, out.output);
  for (const section of ["RELEASE", "GIT", "MIGRATIONS", "SMOKES", "TOOLING", "TESTS", "TYPESCRIPT", "LINT", "BUILD"]) assert.ok(["PASS", "INFO"].includes(statusOf(out.output, section)), section);
  assert.match(sectionOf(out.output, "GIT"), /ok · source commit: HEAD [0-9a-f]{7} is the source commit [0-9a-f]{7} plus this release's manifest/);
  assert.match(sectionOf(out.output, "MIGRATIONS"), /20261020090000_add_flag\.sql: sha256 [0-9a-f]{12} matches the manifest\n- the rehearsal is one transaction that is rolled back/);
  assert.deepEqual(out.steps, ["tests", "typescript", "lint", "build"]); assert.equal(statusOf(out.output, "STATE"), "CHECKED");
  assert.deepEqual(out.cli.calls(), ["--version"], "only the CLI's version, which is local");
  assert.equal(stateOf(made).state, "CHECKED"); assert.ok(existsSync(join(made.home, "Bellis-Releases", "h2-9", "check-report.json")));
});

test("check: a release with no migrations is valid", async (t) => {
  const made = releaseProject(t, { migrations: [] });
  const out = await invoke(t, ["check", "--release", "h2-9"], { made });
  assert.equal(out.code, EXIT.PASS, out.output); assert.match(sectionOf(out.output, "MIGRATIONS"), /this release has no migrations: nothing to rehearse or apply/);
});

test("check fails: wrong source commit, wrong main base, dirty tree, changed migration, bad manifest, failing tests", async (t) => {
  const failing = async (options, pattern, section, runLocal) => {
    const made = releaseProject(t, options); const out = await invoke(t, ["check", "--release", "h2-9"], { made, runLocal });
    assert.equal(out.code, EXIT.CHECK_FAILED, JSON.stringify(options)); assert.match(sectionOf(out.output, section), pattern); assert.deepEqual(out.cli.calls().filter((call) => call !== "--version"), []); return { made, out };
  };
  const first = releaseProject(t); writeFileSync(join(first.root, "releases", "h2-9.json"), JSON.stringify({ ...first.manifest, sourceCommit: first.mainBase }, null, 2) + "\n"); first.repo.commit("move the source");
  let out = await invoke(t, ["check", "--release", "h2-9"], { made: first }); assert.equal(out.code, EXIT.CHECK_FAILED); assert.match(sectionOf(out.output, "GIT"), /FAIL · source commit: HEAD [0-9a-f]{7} changes \d+ file\(s\) after the source commit/);
  const base = releaseProject(t); writeFileSync(join(base.root, "releases", "h2-9.json"), JSON.stringify({ ...base.manifest, expectedMainBase: base.source }, null, 2) + "\n"); base.repo.commit("wrong base");
  out = await invoke(t, ["check", "--release", "h2-9"], { made: base }); assert.equal(out.code, EXIT.CHECK_FAILED); assert.match(sectionOf(out.output, "GIT"), /FAIL · main: main is [0-9a-f]{7}, expected [0-9a-f]{7}/);
  await failing({ dirty: true }, /FAIL · working tree clean: 1 changed or untracked: notes\.txt/, "GIT");
  const changed = releaseProject(t); writeFileSync(join(changed.root, "supabase", "migrations", releaseMigration), "alter table public.patients add column other int;\n"); changed.repo.commit("edit the migration");
  out = await invoke(t, ["check", "--release", "h2-9"], { made: changed }); assert.equal(out.code, EXIT.CHECK_FAILED); assert.match(sectionOf(out.output, "MIGRATIONS"), /the hash differs/);
  const unsafe = releaseProject(t, { migrations: ["20261021090000_second.sql"] }); writeFileSync(join(unsafe.root, "supabase", "migrations", "20261021090000_second.sql"), "create index concurrently i on public.patients(id);\n");
  writeFileSync(join(unsafe.root, "releases", "h2-9.json"), JSON.stringify({ ...unsafe.manifest, migrations: [{ file: "20261021090000_second.sql", sha256: (await import("../scripts/release/smoke/runner.mjs")).sqlHash("create index concurrently i on public.patients(id);\n") }] }, null, 2) + "\n"); unsafe.repo.commit("unsafe");
  out = await invoke(t, ["check", "--release", "h2-9"], { made: unsafe }); assert.notEqual(out.code, EXIT.PASS); assert.equal(statusOf(out.output, "MIGRATIONS"), "HUMAN");
  const disorder = releaseProject(t, { migrations: [releaseMigration, "20261021090000_second.sql"] }); const reversed = { ...disorder.manifest, migrations: [...disorder.manifest.migrations].reverse() };
  writeFileSync(join(disorder.root, "releases", "h2-9.json"), JSON.stringify(reversed, null, 2) + "\n"); disorder.repo.commit("reorder");
  out = await invoke(t, ["check", "--release", "h2-9"], { made: disorder }); assert.equal(out.code, EXIT.CHECK_FAILED); assert.match(out.output, /not in the order they are applied/);
  const malformed = releaseProject(t); writeFileSync(join(malformed.root, "releases", "h2-9.json"), JSON.stringify({ ...malformed.manifest, deployTo: "production" })); malformed.repo.commit("bad");
  out = await invoke(t, ["check", "--release", "h2-9"], { made: malformed }); assert.equal(out.code, EXIT.CHECK_FAILED); assert.match(out.output, /unknown field: deployTo/);
  const tests = await failing({}, /^TESTS\nFAIL\n- 3 failed/, "TESTS", (step) => (step === "tests" ? { ok: false, summary: "3 failed" } : { ok: true, summary: "fine" }));
  assert.equal(statusOf(tests.out.output, "BUILD"), "PASS", "every local step still runs and is reported"); assert.equal(existsSync(join(tests.made.home, "Bellis-Releases", "h2-9", "release-state.json")), false);
  out = await invoke(t, ["check", "--release", "../h2-9"], { made: releaseProject(t) }); assert.equal(out.code, EXIT.PRECONDITION_OR_USAGE);
});

test("staging: a release with a migration goes through every step, and writes only to staging, once", async (t) => {
  const made = releaseProject(t); const cli = releaseCli(t);
  const out = await invoke(t, ["staging", "--release", "h2-9"], { made, cli });
  assert.equal(out.code, EXIT.PASS, out.output);
  const expected = { GIT: "PASS", MIGRATIONS: "PASS", REHEARSAL: "PASS", "DRY RUN": "PASS", "STAGING APPLY": "PASS", "EXPECTED DRIFT": "PASS", SMOKES: "PASS", SNAPSHOT: "IDENTICAL", RESIDUE: "NONE", PREVIEW: "N/A", "CLI FINAL TARGET": "STAGING", STATE: "STAGING_COMPLETE" };
  for (const [section, status] of Object.entries(expected)) assert.equal(statusOf(out.output, section), status, section);
  assert.deepEqual(Object.keys(expected).every((name) => out.output.includes(`## ${name}\n`)) && out.output.includes("## RELEASE\n") && /## RESULT\nPASS\n/.test(out.output), true);
  assert.match(sectionOf(out.output, "SMOKES"), /with the pending migrations: 1\/1 PASS[\s\S]*after the release: 1\/1 PASS/);
  assert.match(sectionOf(out.output, "DRY RUN"), /lists exactly: 20261020090000_add_flag\.sql/);
  assert.equal(writes(cli), 1); assert.equal(cli.state().pushedOn, refs.staging);
  const calls = cli.calls(); assert.ok(calls.indexOf("db push --dry-run") < calls.indexOf("db push --yes"));
  assert.ok(calls.filter((call) => call === "link production").length === 2, "production was read twice, before and after");
  assert.deepEqual(stateOf(made).history.filter((entry) => !entry.rerun).map((entry) => entry.state), ["CHECKED", "REHEARSED", "STAGING_APPLIED", "STAGING_VERIFIED", "STAGING_COMPLETE"]);
  assertSafeEnd(made, out);
});

test("staging and every query in it work when the CLI answers the way it answers a person", async (t) => {
  const made = releaseProject(t); const cli = releaseCli(t, { personMode: true });
  const out = await invoke(t, ["staging", "--release", "h2-9"], { made, cli });
  assert.equal(out.code, EXIT.PASS, out.output); assert.equal(statusOf(out.output, "STATE"), "STAGING_COMPLETE"); assert.equal(statusOf(out.output, "EXPECTED DRIFT"), "PASS");
  assertSafeEnd(made, out);
});

test("staging: a release without migrations rehearses nothing, applies nothing and needs an exact match", async (t) => {
  const made = releaseProject(t, { migrations: [] }); const cli = releaseCli(t, { pending: [], schemaAfterPush: undefined });
  const out = await invoke(t, ["staging", "--release", "h2-9"], { made, cli });
  assert.equal(out.code, EXIT.PASS, out.output);
  assert.equal(statusOf(out.output, "REHEARSAL"), "NOT NEEDED"); assert.equal(statusOf(out.output, "STAGING APPLY"), "NOT NEEDED"); assert.match(sectionOf(out.output, "DRY RUN"), /nothing to apply/);
  assert.match(sectionOf(out.output, "EXPECTED DRIFT"), /EXACT MATCH: staging and production/); assert.equal(writes(cli), 0); assert.equal(statusOf(out.output, "STATE"), "STAGING_COMPLETE");
  assert.deepEqual(stateOf(made).history.map((entry) => entry.state), ["CHECKED", "STAGING_VERIFIED", "STAGING_COMPLETE"]);
  const drifted = releaseCli(t, { pending: [], schemaByRef: { [refs.production]: schemaAnswer({ extraTable: true }) } });
  const other = await invoke(t, ["staging", "--release", "h2-9"], { made: releaseProject(t, { migrations: [] }), cli: drifted });
  assert.equal(other.code, EXIT.CHECK_FAILED); assert.match(sectionOf(other.output, "EXPECTED DRIFT"), /production is not the schema the release starts from[\s\S]*ADDED/);
});

test("staging stops before writing: wrong target, unknown or extra migrations, partial state, failed rehearsal, smokes or dry run, a moving target", async (t) => {
  const cases = [
    ["the CLI is on production", { linked: refs.production }, {}, EXIT.PASS, null],
    ["an ambiguous list of projects", { marks: "both" }, {}, EXIT.TARGET_NOT_CONFIRMED, null],
    ["a migration applied on staging that is not here", { applied: ["20261017090000", "20260101000000"] }, {}, EXIT.CHECK_FAILED, /not in this repository/],
    ["a pending migration that is not in the release", { pending: [releaseMigration, "20261021090000_second.sql"] }, { extraLocal: ["20261021090000_second.sql"] }, EXIT.CHECK_FAILED, /pending, not in the release: 20261021090000_second\.sql/],
    ["part of the release already applied", { applied: ["20261017090000", "20261020090000"] }, { migrations: [releaseMigration, "20261021090000_second.sql"] }, EXIT.CHECK_FAILED, /Only part of the release is applied/],
    ["a rehearsal that left something behind", { schemaLater: schemaAnswer({ migrated: true }) }, {}, EXIT.CHECK_FAILED, /not what it was before the rehearsal/],
    ["a smoke failing with the pending migrations", { behaviour: { a_one: "error" } }, {}, EXIT.CHECK_FAILED, /The smokes failed \(with the pending migrations\)/],
    ["a dry run with an extra migration", { dryRunExtra: ["20261021090000_second.sql"] }, {}, EXIT.CHECK_FAILED, /does not list exactly/],
    ["the link moving to production before the apply", { moveOnDryRun: refs.production }, {}, EXIT.TARGET_NOT_CONFIRMED, /no longer on staging/],
  ];
  for (const [name, behaviour, options, code, pattern] of cases) {
    const made = releaseProject(t, options); const cli = releaseCli(t, behaviour);
    const out = await invoke(t, ["staging", "--release", "h2-9"], { made, cli });
    if (code === EXIT.PASS) { assert.equal(out.code, EXIT.PASS, `${name}: withTarget links staging itself`); continue; }
    assert.equal(out.code, code, `${name}\n${out.output}`); if (pattern) assert.match(out.output, pattern, name);
    assert.equal(writes(cli), 0, `${name}: nothing was applied`); assertSafeEnd(made, out);
  }
});

test("staging fails after the apply: history, expected drift, smokes, data, residue; always back on staging", async (t) => {
  const cases = [
    ["the history does not show the release", { pushNoHistory: true }, /history is not what it should be/, "MIGRATIONS"],
    ["staging is not what was rehearsed", { schemaAfterPush: schemaAnswer({ migrated: true, extraTable: true }) }, /not what the rehearsal said/, "EXPECTED DRIFT"],
    ["a smoke failing after the release", { behaviourAfterPush: { a_one: "error" } }, /The smokes failed \(after the release\)/, "SMOKES"],
    ["the data changed", { dbAfterPush: { ...database(), "public.patients": { ...database()["public.patients"], rows: [{ id: "p1", first_name: "Ana" }] } } }, /A person has to review it/, "SNAPSHOT"],
    ["something left behind", { residue: { users_example_invalid: 1, users_with_smoke_ids: 1, workspaces_with_smoke_ids: 0, workspaces_with_smoke_slugs: 0 } }, /left something behind/, "RESIDUE"],
    ["the apply failing", { pushFails: true }, /Applying the migrations failed/, "STAGING APPLY"],
  ];
  for (const [name, behaviour, pattern, section] of cases) {
    const made = releaseProject(t); const cli = releaseCli(t, behaviour);
    const out = await invoke(t, ["staging", "--release", "h2-9"], { made, cli });
    assert.equal(out.code, EXIT.CHECK_FAILED, name); assert.match(out.output, pattern, name);
    assert.ok(["FAIL", "DIFFERENT", "FOUND"].includes(statusOf(out.output, section)), `${name}: ${section} is ${statusOf(out.output, section)}`);
    assert.equal(statusOf(out.output, "CLI FINAL TARGET"), "STAGING"); assertSafeEnd(made, out);
    assert.equal(stateOf(made).history.at(-1).result, "FAIL", "the failure is written down in the state");
  }
});

test("re-run before the apply starts over; after the apply it resumes without applying again", async (t) => {
  const made = releaseProject(t); const cli = releaseCli(t, { behaviour: { a_one: "error" } });
  let out = await invoke(t, ["staging", "--release", "h2-9"], { made, cli });
  assert.equal(out.code, EXIT.CHECK_FAILED); assert.equal(stateOf(made).state, "REHEARSED"); assert.equal(writes(cli), 0);
  cli.set({ behaviour: {} });
  out = await invoke(t, ["staging", "--release", "h2-9"], { made, cli });
  assert.equal(out.code, EXIT.PASS, out.output); assert.equal(writes(cli), 1); assert.deepEqual(out.steps, [], "the local checks of this commit were reused");
  assert.match(sectionOf(out.output, "RELEASE"), /h2-9/);
  // Something fails after the apply (a network error, say); fixed, it is run again: no second apply, and it finishes.
  const second = releaseProject(t); const flaky = releaseCli(t, { residue: { users_example_invalid: 1, users_with_smoke_ids: 0, workspaces_with_smoke_ids: 0, workspaces_with_smoke_slugs: 0 } });
  out = await invoke(t, ["staging", "--release", "h2-9"], { made: second, cli: flaky }); assert.equal(out.code, EXIT.CHECK_FAILED); assert.equal(stateOf(second).state, "STAGING_APPLIED");
  flaky.set({ residue: undefined });
  out = await invoke(t, ["staging", "--release", "h2-9"], { made: second, cli: flaky });
  assert.equal(out.code, EXIT.PASS, out.output); assert.equal(writes(flaky), 1, "not applied again");
  assert.equal(statusOf(out.output, "STAGING APPLY"), "NOT NEEDED"); assert.match(sectionOf(out.output, "REHEARSAL"), /rehearsed before the apply/); assert.equal(stateOf(second).state, "STAGING_COMPLETE");
  // And once complete, running it again only verifies.
  out = await invoke(t, ["staging", "--release", "h2-9"], { made: second, cli: flaky }); assert.equal(out.code, EXIT.PASS); assert.equal(writes(flaky), 1);
});

test("re-run after an apply nobody rehearsed asks for a person; it never rehearses after the fact", async (t) => {
  const made = releaseProject(t); const cli = releaseCli(t, { applied: ["20261017090000", "20261020090000"], pending: [], schema: schemaAnswer({ migrated: true }) });
  const out = await invoke(t, ["staging", "--release", "h2-9"], { made, cli });
  assert.equal(out.code, EXIT.HUMAN_ACTION_REQUIRED, out.output); assert.match(out.output, /## RESULT\nHUMAN ACTION REQUIRED\n/); assert.match(out.output, /no rehearsal of this release/);
  assert.equal(writes(cli), 0); assert.equal((cli.state().queries ?? []).some((sql) => sql.includes("-- pending migration:")), false, "no rehearsal was run"); assertSafeEnd(made, out);
});

test("Preview: required means waiting for a person, who confirms with the release id; not required means complete", async (t) => {
  const made = releaseProject(t, { manifest: { previewRequired: true } }); const cli = releaseCli(t);
  let out = await invoke(t, ["staging", "--release", "h2-9"], { made, cli });
  assert.equal(out.code, EXIT.HUMAN_ACTION_REQUIRED, out.output); assert.equal(statusOf(out.output, "PREVIEW"), "HUMAN VERIFICATION REQUIRED"); assert.equal(statusOf(out.output, "STATE"), "PREVIEW_PENDING");
  assert.match(sectionOf(out.output, "PREVIEW"), /--confirm-preview h2-9/);
  out = await invoke(t, ["staging", "--release", "h2-9", "--confirm-preview", "yes"], { made, cli: releaseCli(t) }); assert.equal(out.code, EXIT.PRECONDITION_OR_USAGE); assert.match(out.output, /type the release id again/);
  const before = cli.calls().length;
  out = await invoke(t, ["staging", "--release", "h2-9", "--confirm-preview", "h2-9"], { made, cli });
  assert.equal(out.code, EXIT.PASS, out.output); assert.equal(statusOf(out.output, "PREVIEW"), "PASS"); assert.match(sectionOf(out.output, "PREVIEW"), /confirmed by a person \(not verified by this tool\)/);
  assert.equal(statusOf(out.output, "STATE"), "STAGING_COMPLETE"); assert.equal(cli.calls().length, before, "confirming does not touch Supabase");
  out = await invoke(t, ["staging", "--release", "h2-9", "--confirm-preview", "h2-9"], { made, cli }); assert.equal(out.code, EXIT.PRECONDITION_OR_USAGE, "only once, and only when waiting");
  const fresh = releaseProject(t, { manifest: { previewRequired: true } });
  out = await invoke(t, ["staging", "--release", "h2-9", "--confirm-preview", "h2-9"], { made: fresh, cli: releaseCli(t) }); assert.equal(out.code, EXIT.PRECONDITION_OR_USAGE, "nothing to confirm before staging");
});

test("the write guard: a write to production is refused before anything runs", (t) => {
  const onProduction = fakeCli(t, { linked: refs.production }); const onStaging = fakeCli(t);
  assert.throws(() => assertWritable(onProduction.supabase, "production", { environment: onProduction.environment }), (error) => error instanceof ReleaseError && error.exitCode === EXIT.TARGET_NOT_CONFIRMED && /does not write to production/.test(error.message));
  assert.throws(() => assertWritable(onStaging.supabase, "production", { environment: onStaging.environment }), /does not write to production/);
  assert.throws(() => assertWritable(onProduction.supabase, "staging", { environment: onProduction.environment }), TargetNotConfirmed);
  assert.throws(() => assertWritable(onStaging.supabase, "staging", { environment: { ...onStaging.environment, SUPABASE_PROJECT_ID: refs.production } }), TargetNotConfirmed);
  assertWritable(onStaging.supabase, "staging", { environment: onStaging.environment });
  assert.deepEqual(onProduction.supabase.push({ dryRun: false }), { ok: false, reason: "a push that writes was not confirmed by the write guard" });
  assert.deepEqual(onProduction.calls(), [], "the CLI was never run");
});

test("no secret in the report or in the release's folder, whatever the CLI prints", async (t) => {
  const made = releaseProject(t); const cli = releaseCli(t, { pushFails: true });
  const out = await invoke(t, ["staging", "--release", "h2-9", "--json"], { made, cli });
  assert.equal(out.code, EXIT.CHECK_FAILED); JSON.parse(out.output); assertSafeEnd(made, out);
  assert.ok(existsSync(join(made.home, "Bellis-Releases", "h2-9", "staging-report.json")));
});
