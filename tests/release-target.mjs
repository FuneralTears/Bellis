/**
 * The target guard of the release tooling, against a fake Supabase CLI (tests/fixtures/fake-supabase.mjs).
 * No test here reaches Supabase: the fake's whole world is a JSON file in a temporary folder.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, FailureAfterProdWrite, PreconditionError, TargetNotConfirmed, exitCodeFor } from "../scripts/release/lib/report.mjs";
import { createSupabase, parseProjectsTable, resolveCli } from "../scripts/release/lib/supabase.mjs";
import { CleanupFailed, confirmTarget, environmentOf, environments, inspectTarget, returnToStaging, withTarget } from "../scripts/release/lib/target.mjs";
import { projects } from "../scripts/assert-staging-env.mjs";
import { fakeCli, fakeCliPath, forbidden, refs, scratch } from "./fixtures/release-harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const unknownRef = "abcdefghijklmnopqrst";
/** No real signal handler is installed by these tests. */
const noSignals = { on() {}, off() {} };
const run = async (cli, env, fn = async () => "done", extra = {}) => {
  try { return { ok: true, value: await withTarget(cli.supabase, env, fn, { environment: cli.environment, signals: noSignals, ...extra }) }; }
  catch (error) { return { ok: false, error }; }
};
const everything = (value) => JSON.stringify(value, (key, item) => (item instanceof Error ? { message: item.message, details: item.details, stage: item.stage, cause: item.cause } : item));
const assertNoLeak = (value) => { const text = typeof value === "string" ? value : everything(value); for (const secret of forbidden) assert.ok(!text.includes(secret), `leaked: ${secret}`); };

test("the refs come from one place and the two environments are different projects", () => {
  assert.equal(environments.staging.ref, projects.staging); assert.equal(environments.production.ref, projects.production);
  assert.equal(refs.staging, "hbvmcvemrkfovzhlpgys"); assert.equal(refs.production, "pinfdbvfzoratsntjgah");
  assert.notEqual(refs.staging, refs.production);
  assert.equal(environmentOf(refs.staging), "staging"); assert.equal(environmentOf(refs.production), "production"); assert.equal(environmentOf(unknownRef), null);
  assert.equal(environments.production.label, "PROD"); assert.equal(environments.staging.label, "STAGING");
});

test("target staging: the step runs on staging and the CLI stays there", async (t) => {
  const cli = fakeCli(t); let seen = null;
  const out = await run(cli, "staging", async (target) => { seen = { ...target, file: cli.linkedFile() }; target.assertOnTarget(); target.confirm(); return 7; });
  assert.ok(out.ok); assert.deepEqual(out.value, { result: 7, finalTarget: "staging" });
  assert.equal(seen.env, "staging"); assert.equal(seen.ref, refs.staging); assert.equal(seen.label, "STAGING"); assert.equal(seen.file, refs.staging);
  assert.equal(cli.linkedFile(), refs.staging);
  // Linked and read back before the step; confirmed again after it, with no second link needed.
  assert.deepEqual(cli.calls(), ["link staging", "projects list", "projects list", "projects list"]);
});

test("target production: link, confirm, run, back to staging, confirm", async (t) => {
  const cli = fakeCli(t); let seen = null;
  const out = await run(cli, "production", async (target) => { seen = { ref: target.ref, label: target.label, file: cli.linkedFile() }; target.assertOnTarget(); return "applied"; });
  assert.ok(out.ok); assert.deepEqual(out.value, { result: "applied", finalTarget: "staging" });
  assert.deepEqual(seen, { ref: refs.production, label: "PROD", file: refs.production });
  assert.equal(cli.linkedFile(), refs.staging);
  assert.deepEqual(cli.calls(), ["link production", "projects list", "projects list", "link staging", "projects list"]);
});

test("unexpected ref: a link that lands on another project fails closed", async (t) => {
  for (const lands of [unknownRef, refs.staging]) {
    const cli = fakeCli(t, { linkLands: { [refs.production]: lands } }); let ran = false;
    const out = await run(cli, "production", async () => { ran = true; });
    assert.equal(out.ok, false); assert.equal(ran, false, "the step must not run");
    assert.ok(out.error instanceof TargetNotConfirmed); assert.equal(exitCodeFor(out.error), EXIT.TARGET_NOT_CONFIRMED);
    assert.equal(out.error.stage, "confirm production"); assert.ok(out.error.details.length >= 1);
    assert.equal(out.error.finalTarget, "staging"); assert.equal(cli.linkedFile(), refs.staging);
  }
});

test("unexpected ref: the file says production but the account marks another project", async (t) => {
  for (const marks of [refs.staging, unknownRef]) {
    const cli = fakeCli(t, { marks, projects: [{ ref: refs.staging, name: "Bellis Staging" }, { ref: refs.production, name: "Bellis" }, { ref: unknownRef, name: "Other" }] }); let ran = false;
    const out = await run(cli, "production", async () => { ran = true; });
    assert.equal(out.ok, false); assert.equal(ran, false); assert.equal(exitCodeFor(out.error), EXIT.TARGET_NOT_CONFIRMED);
  }
});

test("ambiguous list of projects: two linked, none linked, or the project listed twice or not at all", async (t) => {
  const twice = [{ ref: refs.staging, name: "Bellis Staging" }, { ref: refs.production, name: "Bellis" }, { ref: refs.production, name: "Bellis copy" }];
  for (const behaviour of [{ marks: "both" }, { marks: "none" }, { projects: twice }, { projects: [{ ref: refs.staging, name: "Bellis Staging" }] }]) {
    const cli = fakeCli(t, behaviour); let ran = false;
    const out = await run(cli, "production", async () => { ran = true; });
    assert.equal(out.ok, false, JSON.stringify(behaviour)); assert.equal(ran, false, "the step must not run");
    assert.equal(exitCodeFor(out.error), EXIT.TARGET_NOT_CONFIRMED);
  }
  // With an ambiguous list not even staging can be confirmed, so the way back is reported as failed too.
  const cli = fakeCli(t, { marks: "both" }); const out = await run(cli, "staging");
  assert.ok(out.error instanceof CleanupFailed); assert.equal(out.error.finalTarget, "unconfirmed");
  assert.match(out.error.details.join(" | "), /more than one project is marked as linked/);
});

test("a list of projects that cannot be read fails closed", async (t) => {
  for (const behaviour of [{ failProjects: true }, { noJson: true }]) {
    const cli = fakeCli(t, behaviour); let ran = false;
    const out = await run(cli, "production", async () => { ran = true; });
    assert.equal(out.ok, false); assert.equal(ran, false); assert.equal(exitCodeFor(out.error), EXIT.TARGET_NOT_CONFIRMED); assertNoLeak(out.error);
  }
});

test("SUPABASE_PROJECT_ID pointing elsewhere fails closed: the link would not decide where commands go", async (t) => {
  const cli = fakeCli(t); cli.environment.SUPABASE_PROJECT_ID = refs.production; let ran = false;
  const out = await run(cli, "staging", async () => { ran = true; });
  assert.equal(out.ok, false); assert.equal(ran, false); assert.equal(exitCodeFor(out.error), EXIT.TARGET_NOT_CONFIRMED);
  assert.match(everything(out.error), /SUPABASE_PROJECT_ID/);
  assert.equal(inspectTarget(cli.supabase, "staging", { environment: { SUPABASE_PROJECT_ID: refs.staging } }).ok, true);
});

test("the step fails: the CLI is linked back to staging and the original error is the one thrown", async (t) => {
  const cli = fakeCli(t); const boom = new Error("the migration failed");
  const out = await run(cli, "production", async () => { assert.equal(cli.linkedFile(), refs.production); throw boom; });
  assert.equal(out.ok, false); assert.equal(out.error, boom); assert.equal(out.error.finalTarget, "staging");
  assert.equal(exitCodeFor(out.error), EXIT.CHECK_FAILED);
  assert.equal(cli.linkedFile(), refs.staging); assert.equal(cli.calls().at(-2), "link staging"); assert.equal(cli.calls().at(-1), "projects list");
  // An error after a write to production keeps its own exit code on the way out.
  const after = await run(fakeCli(t), "production", async () => { throw new FailureAfterProdWrite("smoke failed after the push"); });
  assert.equal(exitCodeFor(after.error), EXIT.FAILURE_AFTER_PROD_WRITE); assert.equal(after.error.finalTarget, "staging");
});

test("the link fails: nothing else runs", async (t) => {
  const cli = fakeCli(t, { failLink: [refs.production] }); let ran = false;
  const out = await run(cli, "production", async () => { ran = true; });
  assert.equal(out.ok, false); assert.equal(ran, false, "the step must not run");
  assert.ok(out.error instanceof TargetNotConfirmed); assert.equal(out.error.stage, "link production"); assert.equal(exitCodeFor(out.error), EXIT.TARGET_NOT_CONFIRMED);
  assert.equal(cli.calls()[0], "link production"); assert.equal(cli.calls().includes("link staging"), false, "it never left staging, so no second link");
  assert.equal(cli.linkedFile(), refs.staging); assert.equal(out.error.finalTarget, "staging");
  assert.match(out.error.details[0], /^exit 1/); assertNoLeak(out.error);
});

test("the way back fails: it is reported as its own failure, with what happened before", async (t) => {
  // The step went fine, but staging cannot be linked afterwards.
  let cli = fakeCli(t);
  let out = await run(cli, "production", async () => { cli.set({ failLink: [refs.staging] }); return "applied"; });
  assert.equal(out.ok, false); assert.ok(out.error instanceof CleanupFailed); assert.equal(exitCodeFor(out.error), EXIT.TARGET_NOT_CONFIRMED);
  assert.equal(out.error.finalTarget, "unconfirmed"); assert.equal(out.error.result, "applied"); assert.equal(out.error.original, null);
  assert.equal(out.error.stage, "return to staging"); assert.match(out.error.details[0], /could not be linked back to staging/);
  assert.equal(cli.linkedFile(), refs.production, "the test really left the fake on production"); assertNoLeak(out.error);
  // The step failed and so did the way back: both are in the error.
  cli = fakeCli(t);
  out = await run(cli, "production", async () => { cli.set({ failLink: [refs.staging] }); throw new Error("the smoke failed"); });
  assert.ok(out.error instanceof CleanupFailed); assert.equal(out.error.original.message, "the smoke failed");
  assert.match(out.error.details.join(" | "), /before that: the smoke failed/); assert.equal(exitCodeFor(out.error), EXIT.TARGET_NOT_CONFIRMED);
  // After a write to production, that is still the exit code that wins.
  cli = fakeCli(t);
  out = await run(cli, "production", async () => { cli.set({ failLink: [refs.staging] }); throw new FailureAfterProdWrite("failed after the push"); });
  assert.ok(out.error instanceof CleanupFailed); assert.equal(exitCodeFor(out.error), EXIT.FAILURE_AFTER_PROD_WRITE);
  // The link "works" but the CLI is not on staging afterwards.
  cli = fakeCli(t);
  out = await run(cli, "production", async () => { cli.set({ linkLands: { [refs.staging]: refs.production } }); });
  assert.ok(out.error instanceof CleanupFailed); assert.match(out.error.details.join(" | "), /linked to production, not staging/);
});

test("returnToStaging never throws and says what it could not do", (t) => {
  const cli = fakeCli(t, { linked: refs.production });
  assert.deepEqual(returnToStaging(cli.supabase, { environment: cli.environment }), { ok: true, problems: [] }); assert.equal(cli.linkedFile(), refs.staging);
  const broken = { linkedRef() { throw new Error("disk error"); }, link() { throw new Error("no"); }, projects() { throw new Error("no"); } };
  const end = returnToStaging(broken, { environment: {} });
  assert.equal(end.ok, false); assert.match(end.problems[0], /returning to staging failed/);
});

test("assertOnTarget notices a link that moved while the step was running", async (t) => {
  const cli = fakeCli(t);
  const out = await run(cli, "production", async (target) => { target.assertOnTarget(); cli.supabase.link(refs.staging); target.assertOnTarget(); return "wrote to the wrong place"; });
  assert.equal(out.ok, false); assert.ok(out.error instanceof TargetNotConfirmed); assert.equal(out.error.stage, "write on production");
  assert.equal(cli.linkedFile(), refs.staging);
});

test("an environment that is not staging or production is refused before anything runs", async (t) => {
  const cli = fakeCli(t);
  for (const env of ["prod", "", undefined, refs.production, "__proto__"]) {
    const out = await run(cli, env); assert.equal(out.ok, false); assert.ok(out.error instanceof PreconditionError, String(env)); assert.equal(exitCodeFor(out.error), EXIT.PRECONDITION_OR_USAGE);
  }
  assert.throws(() => confirmTarget(cli.supabase, "prod"), PreconditionError);
  assert.deepEqual(cli.calls(), [], "the CLI was never run");
});

test("the CLI's output never comes back: only named fields, and reasons are redacted", (t) => {
  const cli = fakeCli(t);
  const listed = cli.supabase.projects(); assert.equal(listed.ok, true);
  for (const item of listed.projects) assert.deepEqual(Object.keys(item).sort(), ["linked", "name", "ref", "status"]);
  assert.deepEqual(listed.projects.map((item) => [item.ref, item.linked]), [[refs.staging, true], [refs.production, false]]);
  assert.deepEqual(cli.supabase.link(refs.production), { ok: true }); assert.deepEqual(cli.supabase.version(), { ok: true, version: "2.120.0" });
  cli.set({ failLink: [refs.staging], failProjects: true });
  const link = cli.supabase.link(refs.staging), list = cli.supabase.projects();
  assert.equal(link.ok, false); assert.equal(list.ok, false); assert.deepEqual(list.projects, []);
  assert.match(link.reason, /\[connection string\]/); assertNoLeak([listed, link, list]);
  // Something that is not a ref never reaches the CLI.
  const before = cli.calls().length;
  for (const bad of ["", "prod", `${refs.staging} --debug`, "../../x", null]) assert.deepEqual(cli.supabase.link(bad), { ok: false, reason: "not a project ref" });
  assert.equal(cli.calls().length, before);
  // A link file with something else in it is not a ref either.
  const odd = fakeCli(t, { linked: "not-a-ref" }); assert.equal(odd.supabase.linkedRef(), null);
});

/** `npx.cmd supabase projects list` in a person's terminal, exactly as it printed it (CREATED AT elided as shown). */
const realTable = [
  "LINKED | ORG ID               | REFERENCE ID         | NAME           | REGION                    | CREATED AT (UTC)",
  "--------|----------------------|----------------------|----------------|---------------------------|---------------------",
  "   ●    | hlpnaohuceifooypgdll | hbvmcvemrkfovzhlpgys | Bellis Staging | East US (North Virginia)  | ...",
  "        | hlpnaohuceifooypgdll | pinfdbvfzoratsntjgah | Bellis         | South America (São Paulo) | ...",
].join("\n");

test("projects list: the format is always asked for, so who is calling does not change it", (t) => {
  const cli = fakeCli(t, { tableWithoutFlag: true });
  const listed = cli.supabase.projects();
  assert.equal(listed.ok, true); assert.deepEqual(listed.projects.map((item) => [item.ref, item.linked]), [[refs.staging, true], [refs.production, false]]);
  assert.ok(cli.rawCalls().includes("projects list --output-format json"), "the wrapper asks for JSON");
  cli.supabase.push({ dryRun: true }); assert.ok(cli.rawCalls().at(-1).startsWith("db push"), "and so does db push");
  const source = readFileSync(new URL("../scripts/release/lib/supabase.mjs", import.meta.url), "utf8");
  assert.match(source, /run\(\["projects", "list", "--output-format", "json"\]\)/); assert.match(source, /\.\.\.\(dryRun \? \["--dry-run"\] : \["--yes"\]\), "--output-format", "json"\]/);
});

test("projects list: the real table, exactly as a person's terminal prints it, is read and still guarded", (t) => {
  for (const text of [realTable, realTable.replace(/\n/g, "\r\n"), `│\n◇  Fetching projects...\n\n  \n${realTable}\r\n`]) {
    assert.deepEqual(parseProjectsTable(text), [{ ref: refs.staging, name: "Bellis Staging", status: "", linked: true }, { ref: refs.production, name: "Bellis", status: "", linked: false }]);
  }
  // Through the wrapper and the guard, with a CLI that answers with the table whatever it is asked.
  const cli = fakeCli(t, { projectsTable: realTable.replace(/\n/g, "\r\n") });
  assert.deepEqual(inspectTarget(cli.supabase, "staging", { environment: cli.environment }), { ok: true, env: "staging", ref: refs.staging, problems: [] });
  assert.equal(inspectTarget(cli.supabase, "production", { environment: cli.environment }).ok, false, "the table says staging is linked");
  const both = realTable.replace("        | hlpnaohuceifooypgdll | pinfdbvfzoratsntjgah", "   ●    | hlpnaohuceifooypgdll | pinfdbvfzoratsntjgah");
  assert.match(inspectTarget(fakeCli(t, { projectsTable: both }).supabase, "staging", { environment: {} }).problems.join(), /more than one project is marked as linked/);
});

test("projects list: a table in doubt is never used", () => {
  const broken = [
    ["no header", realTable.split("\n").slice(1).join("\n")], ["a header without the reference", realTable.replace("REFERENCE ID", "REF")], ["no rows", realTable.split("\n").slice(0, 2).join("\n")],
    ["another mark", realTable.replace("●", "*")], ["a cell too many", realTable.replace("Bellis Staging", "Bellis | Staging")], ["a cell missing", realTable.replace("| Bellis         ", "")],
    ["a ref that is not one", realTable.replace("hbvmcvemrkfovzhlpgys", "hbvmcvemrkfovzhlpgy")], ["an empty name", realTable.replace("Bellis Staging", "              ")], ["nothing", ""],
  ];
  for (const [name, text] of broken) assert.equal(parseProjectsTable(text), null, name);
});

test("a CLI that cannot be started is a failed call, not a crash", (t) => {
  const dir = scratch(t); const supabase = createSupabase({ cwd: dir, command: [join(dir, "no-such-program")], environment: {} });
  const link = supabase.link(refs.staging); assert.equal(link.ok, false); assert.match(link.reason, /could not be started/);
  assert.equal(supabase.projects().ok, false); assert.equal(supabase.version().ok, false); assert.equal(supabase.linkedRef(), null);
  assert.equal(inspectTarget(supabase, "staging", { environment: {} }).ok, false);
});

test("where the CLI is looked for: an explicit path first, and a clear error when there is none", (t) => {
  const dir = scratch(t);
  const found = resolveCli({ root: dir, environment: { BELLIS_SUPABASE_CLI: fakeCliPath } });
  assert.equal(found.source, "BELLIS_SUPABASE_CLI"); assert.deepEqual(found.command, [process.execPath, fakeCliPath]);
  assert.throws(() => resolveCli({ root: dir, environment: { BELLIS_SUPABASE_CLI: join(dir, "missing.js") } }), PreconditionError);
  assert.throws(() => resolveCli({ root: dir, environment: { npm_config_cache: dir } }), /was not found/);
});

test("signals: the handlers are installed while the step runs and removed afterwards", async (t) => {
  const cli = fakeCli(t); const installed = new Map(); const exits = []; const logs = [];
  const signals = { on: (name, fn) => installed.set(name, fn), off: (name, fn) => { if (installed.get(name) === fn) installed.delete(name); } };
  const out = await run(cli, "production", async () => {
    assert.deepEqual([...installed.keys()].sort(), ["SIGBREAK", "SIGINT", "SIGTERM"]);
    installed.get("SIGINT")("SIGINT");
    assert.equal(cli.linkedFile(), refs.staging, "the CLI is back on staging before the process is told to end");
  }, { signals, onSignalExit: (code) => exits.push(code), log: (text) => logs.push(text) });
  assert.deepEqual(exits, [EXIT.CHECK_FAILED]); assert.match(logs[0], /interrupted \(SIGINT\): CLI back on staging/);
  assert.equal(installed.size, 0); assert.ok(out.ok); assert.equal(cli.linkedFile(), refs.staging);
  // Interrupted, and staging cannot be reached either: the exit code says the target is not confirmed.
  const stuck = fakeCli(t); const codes = []; let handler = null;
  await run(stuck, "production", async () => { stuck.set({ failLink: [refs.staging] }); handler("SIGINT"); },
    { signals: { on: (name, fn) => { if (name === "SIGINT") handler = fn; }, off() {} }, onSignalExit: (code) => codes.push(code) });
  assert.deepEqual(codes, [EXIT.TARGET_NOT_CONFIRMED]);
});

test("Ctrl+C in a real process: it ends with a failure code and the CLI is on staging", (t) => {
  const cli = fakeCli(t);
  const child = spawnSync(process.execPath, [join(here, "fixtures", "interrupted-target.mjs"), fakeCliPath, cli.workdir, "SIGINT"], { env: cli.environment, encoding: "utf8", timeout: 60_000 });
  assert.equal(child.status, EXIT.CHECK_FAILED, child.stderr);
  assert.match(child.stdout, new RegExp(`on:${refs.production}`)); assert.match(child.stdout, /interrupted \(SIGINT\): CLI back on staging/);
  assert.doesNotMatch(child.stdout, /the step finished/);
  assert.equal(cli.linkedFile(), refs.staging); assert.deepEqual(cli.calls().slice(-2), ["link staging", "projects list"]);
  assertNoLeak(child.stdout + child.stderr);
});
