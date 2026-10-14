/**
 * The entry point of the release tooling: what each command reports and the exit code it ends with.
 * The Supabase CLI is the fake one (tests/fixtures/fake-supabase.mjs); nothing here reaches Supabase.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { available, main, planned } from "../scripts/release/cli.mjs";
import { createGit } from "../scripts/release/lib/git.mjs";
import { EXIT, reportSections } from "../scripts/release/lib/report.mjs";
import { fakeCli, forbidden, gitRepo, refs, scratch } from "./fixtures/release-harness.mjs";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repository, "scripts", "release", "cli.mjs");
/** Runs a command in-process with the fake CLI and a temporary repository; returns the exit code and what it printed. */
async function invoke(t, argv, { cli = fakeCli(t), repo = gitRepo(t), root = repo.dir } = {}) {
  let output = "";
  const code = await main(argv, { root, environment: cli.environment, home: scratch(t), write: (text) => { output += text; }, supabase: cli.supabase, git: createGit({ cwd: repo.dir }) });
  return { code, output, cli, repo };
}
const headings = (output) => output.split("\n").filter((line) => line.startsWith("## "));
const sectionOf = (output, name) => output.split(/^## /m).find((part) => part.startsWith(`${name}\n`)) ?? "";

test("the commands that exist, and the ones that would touch production are not available yet", () => {
  assert.deepEqual([...available], ["status", "check-core", "smoke", "snapshot", "drift", "check", "staging", "backup-check", "prod-precheck", "deploy-check"]); assert.deepEqual([...planned], ["prod-release"]);
  const scripts = JSON.parse(readFileSync(join(repository, "package.json"), "utf8")).scripts;
  assert.equal(scripts["bellis:status"], "node scripts/release/cli.mjs status"); assert.equal(scripts["bellis:check-core"], "node scripts/release/cli.mjs check-core");
  assert.equal(scripts["bellis:smoke"], "node scripts/release/cli.mjs smoke");
  assert.deepEqual(Object.keys(scripts).filter((name) => name.startsWith("bellis:")).sort(), ["bellis:backup-check", "bellis:check", "bellis:check-core", "bellis:deploy-check", "bellis:drift", "bellis:prod-precheck", "bellis:smoke", "bellis:snapshot", "bellis:staging", "bellis:status"]);
  assert.equal(scripts["bellis:prod-release"], undefined, "not yet");
  assert.equal(scripts["bellis:check"], "node scripts/release/cli.mjs check"); assert.equal(scripts["bellis:staging"], "node scripts/release/cli.mjs staging");
  assert.equal(scripts["bellis:drift"], "node scripts/release/cli.mjs drift");
  assert.equal(scripts["bellis:snapshot"], "node scripts/release/cli.mjs snapshot");
  assert.equal(scripts.test, "node scripts/run-tests.mjs");
});

test("status on staging: PASS, the full report, and the CLI is not touched", async (t) => {
  const { code, output, cli } = await invoke(t, ["status"]);
  assert.equal(code, EXIT.PASS, output);
  assert.deepEqual(headings(output), [...reportSections.map((name) => `## ${name}`), "## RESULT"]);
  assert.match(sectionOf(output, "TARGET"), /^TARGET\nPASS\n- linked project: staging \(hbvmcvemrkfovzhlpgys\)\n- nothing was linked or changed by this command/);
  assert.match(sectionOf(output, "GIT"), /^GIT\nPASS\n- branch main at [0-9a-f]{7}\n- main at [0-9a-f]{7}\n- working tree clean/);
  assert.match(sectionOf(output, "CLI FINAL TARGET"), /^CLI FINAL TARGET\nPASS\n- STAGING/);
  for (const name of ["DRIFT", "SNAPSHOT", "SMOKES", "DEPLOY"]) assert.match(sectionOf(output, name), new RegExp(`^${name}\\nN/A`));
  assert.match(output, /## RESULT\nPASS\n- exit 0 \(PASS\)\n$/);
  assert.deepEqual(cli.calls(), [], "without --remote the CLI is not even run");
});

test("status --remote: one read of the account's list, and still no link", async (t) => {
  const { code, output, cli } = await invoke(t, ["status", "--remote"]);
  assert.equal(code, EXIT.PASS, output); assert.match(output, /confirmed with the account's list of projects/); assert.deepEqual(cli.calls(), ["projects list"]);
  const doubt = await invoke(t, ["status", "--remote"], { cli: fakeCli(t, { marks: "both" }) });
  assert.equal(doubt.code, EXIT.TARGET_NOT_CONFIRMED); assert.match(doubt.output, /not confirmed: more than one project is marked as linked/); assert.deepEqual(doubt.cli.calls(), ["projects list"]);
});

test("status with the CLI anywhere but staging: exit 3, and it is left as found", async (t) => {
  for (const [linked, shown, label] of [[refs.production, "linked project: production", "PROD"], ["abcdefghijklmnopqrst", "linked project: unknown", "OTHER"], [null, "the CLI is not linked to any project", "OTHER"]]) {
    const { code, output, cli } = await invoke(t, ["status"], { cli: fakeCli(t, { linked }) });
    assert.equal(code, EXIT.TARGET_NOT_CONFIRMED, output); assert.ok(output.includes(shown), shown);
    assert.match(sectionOf(output, "CLI FINAL TARGET"), new RegExp(`^CLI FINAL TARGET\\nFAIL\\n- ${label}`));
    assert.match(output, /## RESULT\nFAIL\n- exit 3 \(TARGET_NOT_CONFIRMED\)\n- failed at status: The CLI is not confirmed on staging\./);
    assert.deepEqual(cli.calls(), [], "status reports it; it does not move the link"); assert.equal(cli.linkedFile(), linked);
  }
});

test("status reads a dirty tree without failing, and fails when the link folder is tracked", async (t) => {
  const dirty = gitRepo(t); dirty.write("notes.txt");
  const first = await invoke(t, ["status"], { repo: dirty });
  assert.equal(first.code, EXIT.PASS, first.output); assert.match(first.output, /working tree has 1 change\(s\)/);
  const tracked = gitRepo(t); tracked.write("supabase/.temp/project-ref", refs.staging); tracked.git("add", "-f", "supabase/.temp/project-ref"); tracked.git("commit", "-q", "-m", "oops");
  const second = await invoke(t, ["status"], { repo: tracked });
  assert.equal(second.code, EXIT.CHECK_FAILED, second.output); assert.match(sectionOf(second.output, "GIT"), /^GIT\nFAIL/); assert.match(second.output, /FAIL · link folder not tracked/);
});

test("status counts the local migrations and says it did not read the applied ones", async (t) => {
  const repo = gitRepo(t); repo.write("supabase/migrations/20261017090000_a.sql"); repo.write("supabase/migrations/20261018090000_b.sql"); repo.write("supabase/migrations/notes.md"); repo.commit();
  const { output } = await invoke(t, ["status"], { repo });
  assert.match(sectionOf(output, "MIGRATIONS"), /^MIGRATIONS\nINFO\n- 2 local migration\(s\)\n- latest: 20261018090000_b\.sql\n- applied migrations are not read by this command/);
});

test("--json prints the same report as data", async (t) => {
  const { code, output } = await invoke(t, ["status", "--json"]); const json = JSON.parse(output);
  assert.equal(code, 0); assert.equal(json.command, "status"); assert.equal(json.result, "PASS"); assert.equal(json.exitCode, 0); assert.equal(json.exit, "PASS"); assert.equal(json.failure, null);
  assert.deepEqual(Object.keys(json.sections), [...reportSections]); assert.equal(json.sections.TARGET.status, "PASS"); assert.equal(json.sections.DRIFT.status, "N/A");
});

test("check-core: the guardrails and the rehearsal of the target guard pass, without running a single CLI command but --version", async (t) => {
  const { code, output, cli } = await invoke(t, ["check-core"], { root: repository });
  assert.equal(code, EXIT.PASS, output);
  const smokes = sectionOf(output, "SMOKES"); assert.match(smokes, /^SMOKES\nPASS\n- tooling self-test/);
  for (const name of ["project refs agree", "exit codes", "report sections", "release state outside the repository", "release state refused inside the repository", "Supabase CLI", "redaction", "nothing writes to production",
    "production runs and returns to staging", "a link that lands elsewhere stops everything", "an ambiguous list of projects stops everything", "a link that fails stops everything", "a failing step still returns to staging", "a failing way back is reported, not hidden"])
    assert.ok(smokes.includes(`- ok · ${name}:`), name);
  assert.equal(smokes.includes("FAIL ·"), false);
  assert.deepEqual(cli.calls(), ["--version"]); assert.equal(cli.linkedFile(), refs.staging);
});

test("check-core fails when a guardrail does: here, a CLI that cannot be run", async (t) => {
  const broken = fakeCli(t); const supabase = { ...broken.supabase, version: () => ({ ok: false, reason: "the CLI could not be started (ENOENT)" }) };
  let output = ""; const code = await main(["check-core"], { root: repository, environment: broken.environment, home: scratch(t), write: (text) => { output += text; }, supabase, git: createGit({ cwd: gitRepo(t).dir }) });
  assert.equal(code, EXIT.CHECK_FAILED); assert.match(output, /FAIL · Supabase CLI: could not be run/); assert.match(sectionOf(output, "SMOKES"), /^SMOKES\nFAIL/);
});

test("usage: no command, an unknown one, an unknown flag and every planned command end with exit 2 and touch nothing", async (t) => {
  for (const argv of [[], ["deploy"], ["status", "--force"], ["status", "extra"], ...planned.map((name) => [name]), ["prod-release", "--json"]]) {
    const { code, output, cli } = await invoke(t, argv);
    assert.equal(code, EXIT.PRECONDITION_OR_USAGE, argv.join(" ")); assert.deepEqual(cli.calls(), []); assert.equal(cli.linkedFile(), refs.staging);
    if (!argv.includes("--json")) { assert.match(output, /## RESULT\nFAIL\n- exit 2 \(PRECONDITION_OR_USAGE\)/); assert.equal(headings(output).length, reportSections.length + 1); }
  }
  const { output } = await invoke(t, ["prod-release"]); assert.match(output, /"prod-release" is not available yet\. Available: status, check-core, smoke, snapshot, drift, check, staging, backup-check, prod-precheck, deploy-check\./);
});

test("an unexpected error inside a command is a failed check with a redacted message, never a pass", async (t) => {
  const cli = fakeCli(t); const supabase = { ...cli.supabase, linkedRef() { throw new Error("boom postgres://postgres:hunter2-secret@db.x.supabase.co/postgres"); } };
  let output = ""; const code = await main(["status"], { root: gitRepo(t).dir, environment: cli.environment, write: (text) => { output += text; }, supabase, git: createGit({ cwd: gitRepo(t).dir }) });
  assert.equal(code, EXIT.CHECK_FAILED); assert.match(output, /failed at status: boom \[connection string\]/);
  for (const secret of forbidden) assert.ok(!output.includes(secret), secret);
});

test("as a program: the exit code of the process is the exit code of the report", () => {
  const child = spawnSync(process.execPath, [cliPath, "prod-release"], { encoding: "utf8", env: { ...process.env, SUPABASE_PROJECT_ID: "" } });
  assert.equal(child.status, EXIT.PRECONDITION_OR_USAGE, child.stderr); assert.match(child.stdout, /## CLI FINAL TARGET\nN\/A/); assert.match(child.stdout, /- exit 2 \(PRECONDITION_OR_USAGE\)/);
  assert.equal(spawnSync(process.execPath, [cliPath], { encoding: "utf8" }).status, EXIT.PRECONDITION_OR_USAGE);
});
