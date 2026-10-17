/** Explicit, one-level stacked releases. Every case uses scratch git/state and a fake Supabase CLI. */
import assert from "node:assert/strict";
import test from "node:test";
import { buildCapture } from "../scripts/release/drift/capture.mjs";
import { loadReleaseManifest } from "../scripts/release/lib/manifest.mjs";
import { EXIT } from "../scripts/release/lib/report.mjs";
import { createState } from "../scripts/release/lib/state.mjs";
import { main } from "../scripts/release/cli.mjs";
import { loadPredecessorEvidence } from "../scripts/release/stages/stacked-release.mjs";
import { baseMigration, releaseMigration, schemaAnswer, stackedReleaseCli, stackedReleaseProject, successorMigration } from "./fixtures/release-project.mjs";
import { refs } from "./fixtures/release-harness.mjs";

const quiet = { on() {}, off() {} };
const passing = () => ({ ok: true, summary: "fine" });
const versions = { base: baseMigration.slice(0, 14), predecessor: releaseMigration.slice(0, 14), successor: successorMigration.slice(0, 14) };
async function invoke(argv, { made, cli }) {
  let output = "";
  const code = await main(argv, { root: made.root, environment: cli.environment, home: made.home, write: (text) => { output += text; }, supabase: cli.supabase, git: made.git, signals: quiet, runLocal: passing });
  return { code, output, cli };
}

function capture(raw, { environment = "staging", label, commit, release = "h2-8", rehearsed = [] }) {
  return buildCapture(raw, { environment, label, capturedAt: "2026-10-17T00:00:00Z", gitCommit: commit, release, rehearsed });
}

function savePredecessor(made, mutate = () => {}) {
  const state = createState({ repository: made.root, environment: {}, home: made.home });
  const loaded = loadReleaseManifest(made.root, "h2-8");
  const own = loaded.manifest.migrations.map(({ file, sha256 }) => ({ file, sha256 }));
  const data = {
    releaseState: { releaseId: "h2-8", manifestHash: loaded.hash, sourceCommit: loaded.manifest.sourceCommit, state: "PREVIEW_PENDING", history: [
      { state: "CHECKED", at: "2026-10-17T00:00:00Z", commit: made.predecessorHead, environment: "local", result: "PASS", detail: "checked" },
      { state: "REHEARSED", at: "2026-10-17T00:00:01Z", commit: made.predecessorHead, environment: "staging", result: "PASS", detail: "rehearsed" },
      { state: "STAGING_APPLIED", at: "2026-10-17T00:00:02Z", commit: made.predecessorHead, environment: "staging", result: "PASS", detail: "applied" },
      { state: "STAGING_VERIFIED", at: "2026-10-17T00:00:03Z", commit: made.predecessorHead, environment: "staging", result: "PASS", detail: "verified" },
      { state: "PREVIEW_PENDING", at: "2026-10-17T00:00:04Z", commit: made.predecessorHead, environment: "vercel", result: "PASS", detail: "pending" },
    ] },
    base: capture(schemaAnswer({ applied: [versions.base] }), { label: "base", commit: made.predecessorHead }),
    expected: capture(schemaAnswer({ migrated: true, applied: [versions.base] }), { label: "expected", commit: made.predecessorHead, rehearsed: own }),
    staging: capture(schemaAnswer({ migrated: true, applied: [versions.base, versions.predecessor] }), { label: "staging", commit: made.predecessorHead }),
    production: capture(schemaAnswer({ applied: [versions.base] }), { environment: "production", label: "production", commit: made.predecessorHead }),
  };
  mutate(data);
  state.save("h2-8", "release-state", data.releaseState);
  state.save("h2-8", "schema-base", data.base);
  state.save("h2-8", "schema-expected", data.expected);
  state.save("h2-8", "schema-staging", data.staging);
  state.save("h2-8", "schema-production", data.production);
  return state;
}

test("stacked staging PASS: only the declared predecessor separates production from the successor base", async (t) => {
  const made = stackedReleaseProject(t); savePredecessor(made); const cli = stackedReleaseCli(t);
  const out = await invoke(["staging", "--release", "h2-9"], { made, cli });
  assert.equal(out.code, EXIT.PASS, out.output);
  assert.match(out.output, /explicit predecessor: h2-8/);
  assert.match(out.output, /STACKED: production \+ exactly h2-8 = successor base/);
  assert.match(out.output, /STACKED: production \+ h2-8 \+ h2-9 = staging/);
  assert.equal(cli.state().pushes, 1); assert.equal(cli.state().pushedOn, refs.staging); assert.equal(cli.linkedFile(), refs.staging);
});

test("stacked staging FAIL closed: missing, wrong or nested predecessor declaration", async (t) => {
  const missing = stackedReleaseProject(t, { declared: null }); savePredecessor(missing);
  let out = await invoke(["staging", "--release", "h2-9"], { made: missing, cli: stackedReleaseCli(t) });
  assert.equal(out.code, EXIT.CHECK_FAILED); assert.match(out.output, /Production does not match the base/);

  const wrong = stackedReleaseProject(t, { declared: "h2-7" });
  out = await invoke(["check", "--release", "h2-9"], { made: wrong, cli: stackedReleaseCli(t) });
  assert.equal(out.code, EXIT.PRECONDITION_OR_USAGE); assert.match(out.output, /releases\/h2-7\.json could not be read/);

  const nested = stackedReleaseProject(t, { predecessorPredecessor: "h2-7" });
  out = await invoke(["check", "--release", "h2-9"], { made: nested, cli: stackedReleaseCli(t) });
  assert.equal(out.code, EXIT.CHECK_FAILED); assert.match(out.output, /chains longer than one predecessor/);
});

test("predecessor evidence FAIL closed: state, hash, commit and target must all be exact", (t) => {
  const cases = [
    ["invalid state", (data) => { data.releaseState.state = "CHECKED"; data.releaseState.history = data.releaseState.history.slice(0, 1); }, /before STAGING_VERIFIED|no passing STAGING_VERIFIED/],
    ["manifest hash changed", (data) => { data.releaseState.manifestHash = "0".repeat(64); }, /manifest hash differs/],
    ["verified commit inconsistent", (data, made) => { data.releaseState.history.find((item) => item.state === "STAGING_VERIFIED").commit = made.source; }, /changes files after its source commit|staging capture is not from its verified commit/],
    ["another staging target", (data) => { data.staging.meta.environment = "production"; data.staging.meta.ref = refs.production; }, /staging captures target another project/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const made = stackedReleaseProject(t); const state = savePredecessor(made, (data) => mutate(data, made));
    assert.throws(() => loadPredecessorEvidence({ root: made.root, state, git: made.git, successor: made.manifest }), (error) => pattern.test([error.message, ...(error.details ?? [])].join(" | ")), name);
  }
});

test("stacked staging FAIL closed: predecessor not applied, unknown migration, extra drift or partial production", async (t) => {
  const run = async (behaviour, pattern) => {
    const made = stackedReleaseProject(t); savePredecessor(made); const cli = stackedReleaseCli(t, behaviour);
    const out = await invoke(["staging", "--release", "h2-9"], { made, cli });
    assert.equal(out.code, EXIT.CHECK_FAILED, out.output); assert.match(out.output, pattern); assert.equal(cli.state().pushes ?? 0, 0); assert.equal(cli.linkedFile(), refs.staging);
  };
  await run({ appliedByRef: { [refs.staging]: [versions.base], [refs.production]: [versions.base] } }, /pending migrations that are not part of this release|pending, not in the release/);
  await run({ appliedByRef: { [refs.staging]: [versions.base, versions.predecessor, "20260101000000"], [refs.production]: [versions.base] } }, /not in this repository/);
  await run({ schemaByRef: { [refs.staging]: schemaAnswer({ migrated: true, extraTable: true, applied: [versions.base, versions.predecessor] }), [refs.production]: schemaAnswer({ applied: [versions.base] }) } }, /successor base is not exactly the predecessor expected schema/);
  await run({ appliedByRef: { [refs.staging]: [versions.base, versions.predecessor], [refs.production]: [versions.base, versions.predecessor] }, schemaByRef: { [refs.staging]: schemaAnswer({ migrated: true, applied: [versions.base, versions.predecessor] }), [refs.production]: schemaAnswer({ migrated: true, applied: [versions.base, versions.predecessor] }) } }, /production is not exactly the predecessor base schema|migration history differs/);
});

test("prod-precheck and prod-release are rejected before the predecessor is RELEASE_COMPLETE", async (t) => {
  const made = stackedReleaseProject(t); savePredecessor(made); const cli = stackedReleaseCli(t);
  const staged = await invoke(["staging", "--release", "h2-9"], { made, cli }); assert.equal(staged.code, EXIT.PASS, staged.output);
  const before = cli.state().pushes;
  let out = await invoke(["prod-precheck", "--release", "h2-9"], { made, cli });
  assert.equal(out.code, EXIT.HUMAN_ACTION_REQUIRED, out.output);
  assert.match(out.output, /predecessor h2-8 is PREVIEW_PENDING, not RELEASE_COMPLETE in production/);
  out = await invoke(["prod-release", "--release", "h2-9"], { made, cli });
  assert.equal(out.code, EXIT.HUMAN_ACTION_REQUIRED, out.output);
  assert.match(out.output, /predecessor h2-8 is PREVIEW_PENDING, not RELEASE_COMPLETE in production/);
  assert.equal(cli.state().pushes, before); assert.notEqual(cli.state().pushedOn, refs.production); assert.equal(cli.linkedFile(), refs.staging);
});

