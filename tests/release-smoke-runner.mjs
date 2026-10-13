/**
 * The smoke runner, end to end, against the fake Supabase CLI (tests/fixtures/fake-supabase.mjs): what is sent,
 * what counts as a pass, and what the runner does when its own self-test fails. Nothing here reaches Supabase.
 */
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../scripts/release/cli.mjs";
import { createGit } from "../scripts/release/lib/git.mjs";
import { EXIT, TargetNotConfirmed } from "../scripts/release/lib/report.mjs";
import { resolvePending, runSmokes, selfTestMarker, selfTests } from "../scripts/release/smoke/runner.mjs";
import { statements, validateSmokeSql } from "../scripts/release/smoke/sql.mjs";
import { fakeCli, forbidden, gitRepo, refs, scratch } from "./fixtures/release-harness.mjs";

const good = (n) => `-- synthetic\nbegin;\nselect ${n} as value;\nrollback;\n`;
/** A project in a scratch folder: smoke files, their manifest, and (optionally) migrations. */
function project(t, files = { a_one: good(1), b_two: good(2), c_three: good(3) }, { groups = { a_one: ["core"], b_two: ["core", "admin"], c_three: ["admin"] }, migrations = {}, entries = {} } = {}) {
  const root = scratch(t, "bellis-smokes-");
  for (const dir of ["supabase/tests", "supabase/migrations", "scripts/release/smoke", "releases"]) mkdirSync(join(root, dir), { recursive: true });
  for (const [id, text] of Object.entries(files)) if (text !== null) writeFileSync(join(root, "supabase", "tests", `${id}_smoke.sql`), text);
  for (const [name, text] of Object.entries(migrations)) writeFileSync(join(root, "supabase", "migrations", name), text);
  const manifest = { version: 1, contract: { name: "bellis_smoke_v1", pass: "PASS" }, defaults: { timeoutSeconds: 60 }, groups: { core: "core", admin: "admin" },
    smokes: Object.keys(files).map((id) => ({ id, file: `supabase/tests/${id}_smoke.sql`, groups: groups[id] ?? ["core", "admin"], expect: { result: "PASS" }, ...(entries[id] ?? {}) })) };
  writeFileSync(join(root, "scripts", "release", "smoke", "manifest.json"), JSON.stringify(manifest));
  return { root, manifest };
}
function run(t, { cli = fakeCli(t), files, options, smokes, pending = [] } = {}) {
  const made = project(t, files, options); const events = [];
  const outcome = runSmokes({ root: made.root, supabase: cli.supabase, manifest: made.manifest, smokes: smokes ? made.manifest.smokes.filter((item) => smokes.includes(item.id)) : made.manifest.smokes,
    pending: pending.length ? resolvePending(made.root, pending) : [], environment: cli.environment, emit: (event) => events.push(event), temporary: scratch(t, "bellis-tmp-") });
  return { outcome, events, cli, ...made };
}
const statusOf = (outcome) => Object.fromEntries(outcome.results.map((result) => [result.id, result.status]));
const reasonOf = (outcome, id) => outcome.results.find((result) => result.id === id).reason;
const sent = (cli) => cli.state().queries ?? [];
const assertNoLeak = (value) => { const text = typeof value === "string" ? value : JSON.stringify(value); for (const secret of forbidden) assert.ok(!text.includes(secret), `leaked: ${secret}`); };

test("all smokes pass: each one sent once, as one transaction ending in the result row and ROLLBACK", (t) => {
  const { outcome, events, cli } = run(t);
  assert.equal(outcome.ok, true); assert.deepEqual(statusOf(outcome), { a_one: "PASS", b_two: "PASS", c_three: "PASS" });
  assert.deepEqual(outcome.counts, { total: 3, passed: 3, failed: 0, rejected: 0, notRun: 0 }); assert.equal(outcome.rollbackVerified, true); assert.equal(outcome.targetConfirmed, true);
  // The account's list (target), the failing self-test, the three smokes, the rollback check. No link.
  assert.deepEqual(cli.calls(), ["projects list", "db query", "db query", "db query", "db query", "db query"]);
  const queries = sent(cli); assert.match(queries[0], new RegExp(selfTestMarker)); assert.match(queries.at(-1), /txid_status\(/);
  for (const [index, id] of ["a_one", "b_two", "c_three"].entries()) {
    const sql = queries[index + 1]; assert.equal(validateSmokeSql(sql).ok, true, "what is sent is still one transaction that is undone");
    assert.deepEqual(statements(sql).map((statement) => statement.tokens[0].value), ["begin", "select", "select", "rollback"]);
    assert.match(sql, new RegExp(`select ${index + 1} as value;[\\s;]*select 'bellis_smoke_v1' as contract, '${id}' as smoke, 'PASS' as result, '[0-9a-f]{32}' as nonce, txid_current\\(\\)::text as txid;\\nrollback;\\n$`));
  }
  assert.deepEqual(events.map((event) => event.type), ["plan", "selftest", "selftest", "selftest", "smoke", "smoke", "smoke", "rollback", "summary"]);
  assert.equal(cli.linkedFile(), refs.staging); assertNoLeak([outcome, events]);
});

test("self-test: a COMMIT and a missing ROLLBACK are refused without being sent, and a failing smoke fails", (t) => {
  const { outcome, cli } = run(t);
  assert.deepEqual(outcome.selfTests.map((item) => [item.id, item.ok]), [["selftest_commit", true], ["selftest_no_rollback", true], ["selftest_failure", true]]);
  assert.equal(outcome.selfTests[0].detail, "refused, nothing was sent"); assert.equal(outcome.selfTests[2].detail, "failed, as it has to");
  assert.equal(sent(cli).filter((sql) => /commit/.test(sql)).length, 0, "the COMMIT self-test never left this machine");
  assert.deepEqual(selfTests.map((item) => item.expect), ["rejected", "rejected", "fail"]);
  assert.equal(validateSmokeSql(selfTests[0].text).ok, false); assert.equal(validateSmokeSql(selfTests[1].text).ok, false); assert.equal(validateSmokeSql(selfTests[2].text).ok, true);
});

test("self-test: if the failing smoke passes, the runner is broken and no smoke runs", (t) => {
  const { outcome, cli, events } = run(t, { cli: fakeCli(t, { behaviour: { selftest_failure: "pass" } }) });
  assert.equal(outcome.ok, false); assert.equal(outcome.selfTests[2].ok, false); assert.match(outcome.selfTests[2].detail, /IT PASSED/);
  assert.deepEqual(statusOf(outcome), { a_one: "NOT RUN", b_two: "NOT RUN", c_three: "NOT RUN" }); assert.equal(outcome.counts.passed, 0);
  assert.equal(sent(cli).length, 1, "only the self-test was sent"); assert.equal(events.at(-1).stopped, "the runner failed its own self-test");
});

test("self-test: failing for another reason is not proof either", (t) => {
  for (const behaviour of ["exit1", "error", "garbage", "no-row"]) {
    const { outcome } = run(t, { cli: fakeCli(t, { behaviour: { selftest_failure: behaviour } }) });
    assert.equal(outcome.ok, false, behaviour); assert.equal(outcome.selfTests[2].ok, false); assert.match(outcome.selfTests[2].detail, /could not be checked/); assertNoLeak(outcome);
  }
});

test("a SQL error fails the smoke, and the others still run", (t) => {
  const { outcome, cli } = run(t, { cli: fakeCli(t, { behaviour: { b_two: "error" } }) });
  assert.equal(outcome.ok, false); assert.deepEqual(statusOf(outcome), { a_one: "PASS", b_two: "FAIL", c_three: "PASS" });
  assert.equal(reasonOf(outcome, "b_two"), "SQL error P0001: smoke_assertion_failed"); assert.deepEqual(outcome.counts, { total: 3, passed: 2, failed: 1, rejected: 0, notRun: 0 });
  assert.match(sent(cli).at(-1), /array\['\d+','\d+'\]/, "only the two that passed have a rollback to verify");
});

test("a CLI exit code other than 0 fails the smoke, even with a perfect row", (t) => {
  for (const behaviour of ["exit1", "exit3-with-row"]) {
    const { outcome } = run(t, { cli: fakeCli(t, { behaviour: { a_one: behaviour } }) });
    assert.equal(statusOf(outcome).a_one, "FAIL", behaviour); assert.match(reasonOf(outcome, "a_one"), /^exit [13]/); assert.equal(outcome.ok, false); assertNoLeak(outcome);
  }
});

test("the expected row missing fails the smoke: no rows, another row, two rows, another run's row, another smoke's row", (t) => {
  for (const [behaviour, pattern] of [["no-row", /the expected result row is missing/], ["other-row", /the expected result row is missing/], ["two-rows", /expected one result row, got 2/], ["wrong-nonce", /not the row this run asked for/],
    ["wrong-smoke", /not the row this run asked for/], ["garbage", /could not be read/], ["no-txid", /no transaction id/]]) {
    const { outcome } = run(t, { cli: fakeCli(t, { behaviour: { c_three: behaviour } }) });
    assert.equal(statusOf(outcome).c_three, "FAIL", behaviour); assert.match(reasonOf(outcome, "c_three"), pattern); assert.equal(outcome.ok, false);
  }
});

test("a row that says FAIL fails the smoke", (t) => {
  const { outcome } = run(t, { cli: fakeCli(t, { behaviour: { a_one: "fail-result" } }) });
  assert.equal(statusOf(outcome).a_one, "FAIL"); assert.equal(reasonOf(outcome, "a_one"), "the result is FAIL, expected PASS"); assert.equal(outcome.ok, false);
});

test("a transaction PostgreSQL does not report as aborted fails the smoke", (t) => {
  const committed = run(t, { cli: fakeCli(t, { txStatus: { b_two: "committed" } }) });
  assert.deepEqual(statusOf(committed.outcome), { a_one: "PASS", b_two: "FAIL", c_three: "PASS" }); assert.equal(reasonOf(committed.outcome, "b_two"), "its transaction was not rolled back (committed)");
  assert.equal(committed.outcome.ok, false); assert.deepEqual(committed.events.find((event) => event.type === "rollback").notRolledBack, ["b_two"]);
  const unknown = run(t, { cli: fakeCli(t, { failStatusQuery: true }) });
  assert.deepEqual(statusOf(unknown.outcome), { a_one: "FAIL", b_two: "FAIL", c_three: "FAIL" }); assert.match(reasonOf(unknown.outcome, "a_one"), /the rollback could not be verified/);
  assert.equal(unknown.outcome.ok, false); assert.equal(unknown.outcome.rollbackVerified, false);
});

test("a file that is not a transaction that is undone stops the run before anything is sent", (t) => {
  for (const [text, pattern] of [["begin;\nselect 1;\ncommit;\n", /has a COMMIT/], ["begin;\nselect 1;\n", /does not end in ROLLBACK/], ["select 1;\nrollback;\n", /has no BEGIN/], ["begin;\nbegin;\nrollback;\n", /has 2 BEGIN/],
    ["begin;\nrollback;\nselect 1;\n", /ROLLBACK before the end/], ["begin;\nselect 'open;\nrollback;\n", /cannot be read/], [null, /could not be read/]]) {
    const { outcome, cli, events } = run(t, { files: { a_one: good(1), b_two: text, c_three: good(3) } });
    assert.equal(outcome.ok, false); assert.deepEqual(statusOf(outcome), { a_one: "NOT RUN", b_two: "REJECTED", c_three: "NOT RUN" }); assert.match(reasonOf(outcome, "b_two"), pattern);
    assert.deepEqual(cli.calls(), [], "the CLI was not run at all"); assert.equal(outcome.targetConfirmed, false); assert.deepEqual(outcome.counts, { total: 3, passed: 0, failed: 0, rejected: 1, notRun: 2 });
    assert.equal(events.at(-1).stopped, "a smoke was refused before anything was sent");
  }
});

test("COMMIT as text is not a COMMIT: such a smoke runs", (t) => {
  const { outcome } = run(t, { files: { a_one: "begin;\n-- commit;\nselect 'commit;';\ndo $$ begin if false then commit; end if; end $$;\nrollback;\n" } });
  assert.deepEqual(statusOf(outcome), { a_one: "PASS" }); assert.equal(outcome.ok, true);
});

test("a check asked for in the manifest is applied before running", (t) => {
  const { outcome, cli } = run(t, { files: { a_one: "begin;\nselect current_date;\nrollback;\n" }, options: { entries: { a_one: { checks: ["workspace-clock"] } } } });
  assert.deepEqual(statusOf(outcome), { a_one: "REJECTED" }); assert.match(reasonOf(outcome, "a_one"), /uses current_date/); assert.deepEqual(cli.calls(), []);
});

test("the CLI has to be on staging, confirmed, or nothing is sent", (t) => {
  for (const behaviour of [{ linked: refs.production }, { marks: "both" }, { failProjects: true }, { linked: null }]) {
    const cli = fakeCli(t, behaviour);
    assert.throws(() => run(t, { cli }), (error) => error instanceof TargetNotConfirmed, JSON.stringify(behaviour));
    assert.equal(sent(cli).length, 0); assert.equal(cli.calls().includes("link staging"), false, "the runner never links");
  }
  const cli = fakeCli(t); cli.environment.SUPABASE_PROJECT_ID = refs.production;
  assert.throws(() => run(t, { cli }), TargetNotConfirmed); assert.equal(sent(cli).length, 0);
});

test("pending migrations run inside each smoke's transaction, before the smoke", (t) => {
  const { outcome, cli, events } = run(t, { smokes: ["a_one", "b_two"], pending: ["20270102000000_b.sql", "20270101000000_a.sql"],
    options: { migrations: { "20270101000000_a.sql": "create table pending_a(id int);\n", "20270102000000_b.sql": "alter table pending_a add note text\n-- no semicolon at the end" } } });
  assert.equal(outcome.ok, true); const queries = sent(cli);
  assert.doesNotMatch(queries[0], /pending_a/, "the self-test runs without them");
  for (const sql of queries.slice(1, 3)) {
    assert.deepEqual(statements(sql).map((statement) => statement.tokens[0].value), ["begin", "create", "alter", "select", "select", "rollback"]); assert.equal(validateSmokeSql(sql).ok, true);
  }
  assert.deepEqual(events[0].pending.map((item) => item.file), ["20270101000000_a.sql", "20270102000000_b.sql"]);
});

test("nothing is left in the temporary folder", (t) => {
  const temporary = scratch(t, "bellis-tmp-"); const made = project(t); const cli = fakeCli(t, { behaviour: { a_one: "error" } });
  runSmokes({ root: made.root, supabase: cli.supabase, manifest: made.manifest, smokes: made.manifest.smokes, environment: cli.environment, temporary });
  assert.deepEqual(readdirSync(temporary), []);
  const broken = fakeCli(t, { linked: refs.production });
  assert.throws(() => runSmokes({ root: made.root, supabase: broken.supabase, manifest: made.manifest, smokes: made.manifest.smokes, environment: broken.environment, temporary }));
  assert.deepEqual(readdirSync(temporary), []); assert.notEqual(temporary, tmpdir());
});

test("no secret gets out: not in results, events, the report or NDJSON, whatever the CLI prints", async (t) => {
  const cli = fakeCli(t, { behaviour: { a_one: "leak-error", b_two: "exit1" } });
  const { outcome, events } = run(t, { cli });
  assert.deepEqual(statusOf(outcome), { a_one: "FAIL", b_two: "FAIL", c_three: "PASS" }); assert.match(reasonOf(outcome, "a_one"), /^SQL error P0001: failed to connect to \[connection string\]/);
  assertNoLeak([outcome, events]);
  for (const flags of [[], ["--ndjson"], ["--json"]]) { const out = await invoke(t, ["smoke", ...flags], { cli: fakeCli(t, { behaviour: { a_one: "leak-error", b_two: "exit1" } }) }); assert.equal(out.code, EXIT.CHECK_FAILED); assertNoLeak(out.output); }
});

/** The `smoke` command, in-process, with the fake CLI and a scratch project. */
async function invoke(t, argv, { cli = fakeCli(t), made = project(t) } = {}) {
  let output = "";
  const code = await main(argv, { root: made.root, environment: cli.environment, home: scratch(t), write: (text) => { output += text; }, supabase: cli.supabase, git: createGit({ cwd: gitRepo(t).dir }) });
  return { code, output, cli, made };
}
const sectionOf = (output, name) => output.split(/^## /m).find((part) => part.startsWith(`${name}\n`)) ?? "";

test("command: `smoke` runs everything once and ends with the report", async (t) => {
  const { code, output, cli } = await invoke(t, ["smoke"]);
  assert.equal(code, EXIT.PASS, output);
  assert.match(output, /^smokes: 3 on staging\nok {4}self-test selftest_commit: refused, nothing was sent\nok {4}self-test selftest_no_rollback: refused, nothing was sent\nok {4}self-test selftest_failure: failed, as it has to\nPASS {6}a_one {2}\d+\.\ds\nPASS {6}b_two/);
  assert.match(output, /ok {4}rollback verified for 3 transaction\(s\)/);
  assert.match(sectionOf(output, "TARGET"), /^TARGET\nPASS\n- STAGING \(hbvmcvemrkfovzhlpgys\)/); assert.match(sectionOf(output, "CLI FINAL TARGET"), /^CLI FINAL TARGET\nPASS\n- STAGING/);
  assert.match(sectionOf(output, "SMOKES"), /^SMOKES\nPASS\n- 3\/3 PASS\n- self-test: 3\/3 .*\n- rollback verified with PostgreSQL for 3 transaction\(s\)/);
  assert.match(output, /## RESULT\nPASS\n- exit 0 \(PASS\)\n$/); assert.equal(cli.calls().filter((call) => call.startsWith("link")).length, 0);
});

test("command: --group, several groups without running a smoke twice, --only and --all", async (t) => {
  const ran = async (argv) => { const out = await invoke(t, argv); const queries = out.cli.state().queries ?? []; return { code: out.code, ids: queries.flatMap((sql) => /as contract, '([a-z_]+)' as smoke/.exec(sql)?.[1] ?? []).filter((id) => !id.startsWith("selftest")) }; };
  assert.deepEqual(await ran(["smoke", "--group", "core"]), { code: 0, ids: ["a_one", "b_two"] });
  assert.deepEqual(await ran(["smoke", "--group", "admin"]), { code: 0, ids: ["b_two", "c_three"] });
  assert.deepEqual(await ran(["smoke", "--group", "core", "admin"]), { code: 0, ids: ["a_one", "b_two", "c_three"] });
  assert.deepEqual(await ran(["smoke", "--group", "core", "--group", "admin"]), { code: 0, ids: ["a_one", "b_two", "c_three"] });
  assert.deepEqual(await ran(["smoke", "--only", "c_three"]), { code: 0, ids: ["c_three"] });
  assert.deepEqual(await ran(["smoke", "--all"]), { code: 0, ids: ["a_one", "b_two", "c_three"] });
  for (const argv of [["smoke", "--group", "nope"], ["smoke", "--group"], ["smoke", "--only", "nope"], ["smoke", "--all", "--group", "core"], ["smoke", "stray"], ["smoke", "--remote"]]) {
    const out = await invoke(t, argv); assert.equal(out.code, EXIT.PRECONDITION_OR_USAGE, argv.join(" ")); assert.deepEqual(out.cli.calls(), []);
  }
});

test("command: --list shows the selection and runs nothing", async (t) => {
  const { code, output, cli } = await invoke(t, ["smoke", "--list", "--group", "admin"]);
  assert.equal(code, EXIT.PASS); assert.match(output, /LISTED {4}b_two {2}core, admin\nLISTED {4}c_three {2}admin\n/); assert.match(output, /2 of 3 smoke\(s\) selected; nothing was run/); assert.deepEqual(cli.calls(), []);
});

test("command: a failing smoke is exit 1, and the report names it", async (t) => {
  const { code, output } = await invoke(t, ["smoke"], { cli: fakeCli(t, { behaviour: { b_two: "error" } }) });
  assert.equal(code, EXIT.CHECK_FAILED); assert.match(output, /FAIL {6}b_two {2}SQL error P0001: smoke_assertion_failed/);
  assert.match(sectionOf(output, "SMOKES"), /^SMOKES\nFAIL\n- 2\/3 PASS\n[\s\S]*- FAIL · b_two: SQL error P0001: smoke_assertion_failed/); assert.match(output, /- exit 1 \(CHECK_FAILED\)/);
});

test("command: a refused file is exit 1 and says nothing was sent; a wrong target is exit 3", async (t) => {
  const refusedRun = await invoke(t, ["smoke"], { made: project(t, { a_one: good(1), b_two: "begin;\nselect 1;\ncommit;\n" }) });
  assert.equal(refusedRun.code, EXIT.CHECK_FAILED); assert.match(sectionOf(refusedRun.output, "TARGET"), /^TARGET\nN\/A\n- nothing was sent/); assert.match(refusedRun.output, /REJECTED {2}b_two {2}has a COMMIT \(line 3\)/);
  assert.match(sectionOf(refusedRun.output, "SMOKES"), /0\/2 PASS, 1 refused before running, 1 not run/); assert.deepEqual(refusedRun.cli.calls(), []);
  const wrong = await invoke(t, ["smoke"], { cli: fakeCli(t, { linked: refs.production }) });
  assert.equal(wrong.code, EXIT.TARGET_NOT_CONFIRMED); assert.match(sectionOf(wrong.output, "CLI FINAL TARGET"), /^CLI FINAL TARGET\nFAIL\n- PROD/); assert.equal((wrong.cli.state().queries ?? []).length, 0);
  assert.equal(wrong.cli.linkedFile(), refs.production, "reported, not moved");
});

test("command: an invalid manifest stops it before anything else", async (t) => {
  const made = project(t); writeFileSync(join(made.root, "supabase", "tests", "stray_smoke.sql"), good(9));
  const { code, output, cli } = await invoke(t, ["smoke"], { made });
  assert.equal(code, EXIT.CHECK_FAILED); assert.match(output, /failed at smoke manifest: The smoke manifest is not valid\.\n- supabase\/tests\/stray_smoke\.sql is not in the manifest/); assert.deepEqual(cli.calls(), []);
});

test("command: --ndjson is one JSON event per line, ending with the report", async (t) => {
  const { code, output } = await invoke(t, ["smoke", "--ndjson", "--group", "core"], { cli: fakeCli(t, { behaviour: { b_two: "fail-result" } }) });
  const events = output.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ["plan", "selftest", "selftest", "selftest", "smoke", "smoke", "rollback", "summary", "report"]);
  assert.deepEqual(events.filter((event) => event.type === "smoke").map((event) => [event.id, event.status]), [["a_one", "PASS"], ["b_two", "FAIL"]]);
  assert.equal(events.at(-1).exitCode, EXIT.CHECK_FAILED); assert.equal(events.at(-1).sections.SMOKES.status, "FAIL"); assert.equal(code, EXIT.CHECK_FAILED);
  assert.deepEqual(events.at(-2).counts, { total: 2, passed: 1, failed: 1, rejected: 0, notRun: 0 });
});

test("command: --with-pending takes file names of supabase/migrations and nothing else", async (t) => {
  const migrations = { "20270101000000_a.sql": "create table pending_a(id int);\n", "20270102000000_own.sql": "begin;\ncreate table x(id int);\ncommit;\n" };
  const ok = await invoke(t, ["smoke", "--only", "a_one", "--with-pending", "20270101000000_a.sql"], { made: project(t, undefined, { migrations }) });
  assert.equal(ok.code, EXIT.PASS, ok.output); assert.match(ok.output, /with 1 pending migration\(s\): 20270101000000_a\.sql \([0-9a-f]{12}\)/);
  assert.match(sectionOf(ok.output, "MIGRATIONS"), /^MIGRATIONS\nINFO\n- pending, inside each smoke's transaction: 20270101000000_a\.sql/); assert.match(ok.cli.state().queries[1], /create table pending_a/);
  for (const [name, code] of [["../outside.sql", EXIT.PRECONDITION_OR_USAGE], ["supabase/migrations/20270101000000_a.sql", EXIT.PRECONDITION_OR_USAGE], ["20270109000000_missing.sql", EXIT.PRECONDITION_OR_USAGE], ["20270102000000_own.sql", EXIT.CHECK_FAILED]]) {
    const out = await invoke(t, ["smoke", "--with-pending", name], { made: project(t, undefined, { migrations }) });
    assert.equal(out.code, code, name); assert.deepEqual(out.cli.calls(), [], "nothing was sent");
  }
  const noRelease = await invoke(t, ["smoke", "--with-pending", "20270101000000_a.sql", "--release", "h2-9"], { made: project(t, undefined, { migrations }) });
  assert.equal(noRelease.code, EXIT.PRECONDITION_OR_USAGE); assert.match(noRelease.output, /releases\/h2-9\.json could not be read/);
});
