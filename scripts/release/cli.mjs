#!/usr/bin/env node
/**
 * Bellis release tooling. One entry point; each command has one job and ends with the same report and an exit
 * code that says whether to go on (scripts/release/lib/report.mjs).
 *
 *   node scripts/release/cli.mjs status        where things are: repository, linked project, migrations. Reads only.
 *   node scripts/release/cli.mjs check-core    the tooling's own guardrails, including a rehearsal of the target
 *                                              guard against a simulated CLI. Reads only; no request is sent.
 *   node scripts/release/cli.mjs smoke         the SQL smokes of supabase/tests, against staging. Each one is a
 *                                              transaction that is rolled back; nothing is left behind.
 *     --remote   (status) also asks the Supabase account which project is linked. One read-only request.
 *     --json     print the report as JSON instead of text.
 *     --group <name...>   (smoke) only the smokes of these groups: core, crm, plans, admin, release.
 *     --only <id...>      (smoke) only these smokes.
 *     --all               (smoke) every smoke, each one once. The default when nothing is chosen.
 *     --list              (smoke) show which smokes would run, and run nothing.
 *     --with-pending <file...>   (smoke) run these migrations of supabase/migrations first, inside each smoke's
 *                                transaction, to try a migration before it is applied. Nothing is kept.
 *     --release <id>      (smoke) with --with-pending: the migrations have to match releases/<id>.json.
 *     --ndjson            (smoke, snapshot) one JSON event per line instead of text.
 *   node scripts/release/cli.mjs snapshot      counts and fingerprints of the data: never a row. Read-only.
 *     --release <id> --label <pre|post|...>    take one and keep it in the release's folder, outside the repository.
 *     --env <staging|production>   which project (staging by default). The CLI has to be there already.
 *     --replace           take it again under a label that already exists.
 *     --output <file>     also write the snapshot to this file (outside the repository).
 *     --compare <a> <b>   compare two snapshots: two labels of --release, or two files. Any difference fails.
 *
 * No command links the CLI, applies a migration, moves a branch or writes outside the release state folder.
 * The commands that do (staging, prod-precheck, prod-release) are not available yet and answer with exit 2.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGit, checkGit, short } from "./lib/git.mjs";
import { EXIT, PreconditionError, ReleaseError, createReport, exitCodeFor, exitName, redact, reportSections } from "./lib/report.mjs";
import { createState } from "./lib/state.mjs";
import { createSupabase } from "./lib/supabase.mjs";
import { CleanupFailed, environmentOf, environments, inspectTarget, withTarget } from "./lib/target.mjs";
import { loadManifest, selectSmokes } from "./smoke/manifest.mjs";
import { humanLine, resolvePending, runSmokes } from "./smoke/runner.mjs";
import { loadConfig } from "./snapshot/build-sql.mjs";
import { captureSnapshot } from "./snapshot/capture.mjs";
import { acceptSnapshot, compareSnapshots, differenceLine, readSnapshotFile } from "./snapshot/compare.mjs";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const available = Object.freeze(["status", "check-core", "smoke", "snapshot"]);
export const planned = Object.freeze(["check", "staging", "prod-precheck", "prod-release"]);
const usage = `Usage: node scripts/release/cli.mjs <${available.join("|")}> [options] (see the top of scripts/release/cli.mjs)`;
/** The options each command takes: `true` for a switch, "list" for one that is followed by one or more values. */
const optionsOf = Object.freeze({
  status: { "--remote": true, "--json": true },
  "check-core": { "--json": true },
  smoke: { "--all": true, "--list": true, "--ndjson": true, "--json": true, "--group": "list", "--only": "list", "--with-pending": "list", "--release": "list" },
  snapshot: { "--ndjson": true, "--json": true, "--replace": true, "--release": "list", "--label": "list", "--env": "list", "--output": "list", "--compare": "list" },
});

function parse(argv) {
  const [command, ...rest] = argv; const known = optionsOf[command] ?? {}; const flags = new Set(); const lists = {}; const unknown = [];
  let open = null;
  for (const item of rest) {
    if (item.startsWith("--")) { open = null; if (!Object.hasOwn(known, item)) { unknown.push(item); continue; } flags.add(item); if (known[item] === "list") { open = item; lists[item] ??= []; } }
    else if (open) lists[open].push(item); else unknown.push(item);
  }
  for (const [name, values] of Object.entries(lists)) if (!values.length) unknown.push(`${name} (it needs a value)`);
  return { command, flags, lists, remote: flags.has("--remote"), json: flags.has("--json"), unknown };
}
const line = (check) => `${check.ok ? "ok" : "FAIL"} · ${check.name}: ${check.detail}`;
const section = (checks) => (checks.every((item) => item.ok) ? "PASS" : "FAIL");
const localMigrations = (root) => { const dir = join(root, "supabase", "migrations"); return existsSync(dir) ? readdirSync(dir).filter((name) => /^\d{14}_.+\.sql$/.test(name)).sort() : []; };

/** What the CLI is linked to right now, without changing it. With `remote`, the account's list is read as well. */
function describeTarget(report, supabase, { remote, environment }) {
  const ref = supabase.linkedRef(); const env = environmentOf(ref);
  const lines = [ref ? `linked project: ${env ?? "unknown"} (${ref})` : "the CLI is not linked to any project", "nothing was linked or changed by this command"];
  let ok = env === "staging";
  if (!ok) lines.push("at rest the CLI is expected to be on staging");
  if (remote && ok) { const seen = inspectTarget(supabase, "staging", { environment }); ok = seen.ok; lines.push(seen.ok ? "confirmed with the account's list of projects" : `not confirmed: ${seen.problems.join("; ")}`); }
  report.set("TARGET", ok ? "PASS" : "FAIL", lines);
  report.set("CLI FINAL TARGET", ok ? "PASS" : "FAIL", [env ? environments[env].label : "OTHER"]);
  return ok;
}

function status({ report, root, supabase, git, remote, environment }) {
  const onStaging = describeTarget(report, supabase, { remote, environment });
  const seen = checkGit(git, { requireClean: false });
  report.set("GIT", seen.ok ? "PASS" : "FAIL", [`branch ${seen.state.branch ?? "(detached)"} at ${short(seen.state.commit)}`, `main at ${short(seen.state.main)}`,
    seen.state.clean ? "working tree clean" : `working tree has ${seen.state.changes.length} change(s)`, ...seen.checks.map(line)]);
  const migrations = localMigrations(root);
  report.set("MIGRATIONS", "INFO", [`${migrations.length} local migration(s)`, migrations.length ? `latest: ${migrations.at(-1)}` : "none", "applied migrations are not read by this command"]);
  // A CLI left on production (or nowhere) is the one thing `status` treats as an alarm.
  if (!onStaging) report.fail(new ReleaseError("The CLI is not confirmed on staging.", { exitCode: EXIT.TARGET_NOT_CONFIRMED, stage: "status" }));
}

/**
 * A CLI that only exists in memory, with the two real refs. It lets check-core rehearse the target guard (wrong
 * project, ambiguous list, a failing step, a failing way back) without sending a single request.
 */
function simulatedCli({ linked = environments.staging.ref, breakLink = [], linkLands = {}, marks = "linked" } = {}) {
  const state = { linked, calls: [] };
  return { state,
    linkedRef: () => state.linked,
    link(ref) { state.calls.push(`link ${environmentOf(ref) ?? "unknown"}`); if (breakLink.includes(ref)) return { ok: false, reason: "simulated failure" }; state.linked = linkLands[ref] ?? ref; return { ok: true }; },
    projects() { state.calls.push("projects"); const list = Object.values(environments).map((item) => ({ ref: item.ref, name: item.key, status: "ACTIVE_HEALTHY", linked: marks === "both" ? true : marks === "none" ? false : item.ref === state.linked })); return { ok: true, projects: list }; } };
}
async function rehearseTargetGuard() {
  const quiet = { environment: {}, signals: { on() {}, off() {} } }; const checks = [];
  const attempt = async (cli, env, fn = async () => "done") => { try { return { ok: true, value: await withTarget(cli, env, fn, quiet) }; } catch (error) { return { ok: false, error }; } };
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  let cli = simulatedCli(); let ran = false; let out = await attempt(cli, "production", async (target) => { ran = true; target.assertOnTarget(); return target.ref; });
  add("production runs and returns to staging", out.ok && ran && out.value.result === environments.production.ref && cli.state.linked === environments.staging.ref, "the step ran on production and the CLI ended on staging");
  cli = simulatedCli({ linkLands: { [environments.production.ref]: environments.staging.ref } }); ran = false; out = await attempt(cli, "production", async () => { ran = true; });
  add("a link that lands elsewhere stops everything", !out.ok && !ran && exitCodeFor(out.error) === EXIT.TARGET_NOT_CONFIRMED, "the step did not run");
  cli = simulatedCli({ marks: "both" }); ran = false; out = await attempt(cli, "staging", async () => { ran = true; });
  add("an ambiguous list of projects stops everything", !out.ok && !ran && exitCodeFor(out.error) === EXIT.TARGET_NOT_CONFIRMED, "the step did not run");
  cli = simulatedCli({ breakLink: [environments.production.ref] }); ran = false; out = await attempt(cli, "production", async () => { ran = true; });
  add("a link that fails stops everything", !out.ok && !ran && cli.state.linked === environments.staging.ref, "the step did not run and the CLI stayed on staging");
  cli = simulatedCli(); out = await attempt(cli, "production", async () => { throw new Error("simulated step failure"); });
  add("a failing step still returns to staging", !out.ok && out.error.message === "simulated step failure" && cli.state.linked === environments.staging.ref && out.error.finalTarget === "staging", "the CLI ended on staging");
  cli = simulatedCli(); out = await attempt(cli, "production", async () => { cli.state.linked = environments.production.ref; cli.link = () => ({ ok: false, reason: "simulated failure" }); });
  add("a failing way back is reported, not hidden", !out.ok && out.error instanceof CleanupFailed && exitCodeFor(out.error) === EXIT.TARGET_NOT_CONFIRMED, "reported as target not confirmed");
  return checks;
}

async function checkCore({ report, root, supabase, git, environment, home }) {
  describeTarget(report, supabase, { remote: false, environment });
  const seen = checkGit(git, { requireClean: false });
  report.set("GIT", seen.ok ? "PASS" : "FAIL", [`branch ${seen.state.branch ?? "(detached)"} at ${short(seen.state.commit)}`, ...seen.checks.map(line)]);
  const guardrails = []; const add = (name, ok, detail) => guardrails.push({ name, ok: !!ok, detail });
  // One list of refs: the build guard, the runtime guard and this tooling have to agree.
  const runtime = /productionProjectRef\s*=\s*"([a-z0-9]{20})"/.exec(readFileSync(join(root, "lib", "supabase-target.ts"), "utf8"))?.[1];
  add("project refs agree", runtime === environments.production.ref && environments.staging.ref !== environments.production.ref, "scripts/assert-staging-env.mjs and lib/supabase-target.ts name the same production project");
  const codes = Object.values(EXIT);
  add("exit codes", new Set(codes).size === codes.length && codes.every((code) => exitName(code) !== "UNKNOWN") && codes.join() === "0,1,2,3,4,5", `${codes.length} codes, each one with one meaning`);
  add("report sections", reportSections.join() === "TARGET,GIT,MIGRATIONS,DRIFT,SNAPSHOT,SMOKES,DEPLOY,CLI FINAL TARGET", "the report has its sections in the agreed order");
  let stateRoot = null; try { stateRoot = createState({ repository: root, environment, home }).root; } catch (error) { stateRoot = null; add("release state outside the repository", false, redact(error.message)); }
  if (stateRoot) add("release state outside the repository", true, "runtime state is kept outside the repository");
  let refused = false; try { createState({ repository: root, root: join(root, "releases") }); } catch { refused = true; }
  add("release state refused inside the repository", refused, "a folder inside the repository is rejected");
  const version = supabase.version();
  add("Supabase CLI", version.ok, version.ok ? `version ${version.version}, from ${supabase.source}` : `could not be run (${version.reason})`);
  add("redaction", !/hunter2|eyJhbGciOi/.test(redact("postgres://user:hunter2@db.example/postgres token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abcdefgh")), "credentials are removed from anything shown");
  add("commands that write are not exposed yet", planned.every((name) => !available.includes(name)), `available: ${available.join(", ")}`);
  const rehearsal = await rehearseTargetGuard();
  // The guardrails have no section of their own in the agreed report: they go under SMOKES, labelled as the
  // tooling's self-test, and any failure there fails the command.
  report.set("MIGRATIONS", "INFO", [`${localMigrations(root).length} local migration(s)`, "applied migrations are not read by this command"]);
  report.set("SMOKES", section([...guardrails, ...rehearsal]), ["tooling self-test (no SQL smoke is run by this command)", ...guardrails.map(line), ...rehearsal.map(line)]);
}

/**
 * The SQL smokes. Only against staging for now: the CLI has to be there already, and it is not moved.
 * Progress is printed as it happens (text, or one JSON event per line), and the report closes it.
 */
function smoke({ report, root, supabase, git, environment, options, write }) {
  const manifest = loadManifest(root);
  const chosen = selectSmokes(manifest, { groups: options.lists["--group"] ?? [], only: options.lists["--only"] ?? [], all: options.flags.has("--all") });
  const release = options.lists["--release"]; if (release && release.length !== 1) throw new PreconditionError("--release takes one release id.");
  const pending = resolvePending(root, options.lists["--with-pending"] ?? [], { release: release?.[0] });
  const ndjson = options.flags.has("--ndjson");
  const emit = (event) => { if (ndjson) write(JSON.stringify(event) + "\n"); else { const text = humanLine(event); if (text) write(text + "\n"); } };
  const groups = Object.keys(manifest.groups).map((group) => `${group}: ${manifest.smokes.filter((item) => item.groups.includes(group)).length}`).join(", ");
  report.set("MIGRATIONS", pending.length ? "INFO" : "N/A", pending.map((item) => `pending, inside each smoke's transaction: ${item.file} (sha256 ${item.sha256.slice(0, 12)}${item.verified ? ", matches the release" : ""})`));
  if (options.flags.has("--list")) {
    for (const item of chosen) emit(ndjson ? { type: "listed", id: item.id, file: item.file, groups: item.groups } : { type: "smoke", status: "LISTED", id: item.id, reason: item.groups.join(", ") });
    report.set("SMOKES", "INFO", [`${chosen.length} of ${manifest.smokes.length} smoke(s) selected; nothing was run`, `groups: ${groups}`]);
    if (!ndjson) write("\n");
    return;
  }
  const seen = checkGit(git, { requireClean: false });
  report.set("GIT", "INFO", [`branch ${seen.state.branch ?? "(detached)"} at ${short(seen.state.commit)}`, seen.state.clean ? "working tree clean" : `working tree has ${seen.state.changes.length} change(s): the smokes run are the files on disk`]);
  let outcome;
  try { outcome = runSmokes({ root, supabase, manifest, smokes: chosen, pending, environment, emit }); }
  finally { const ref = supabase.linkedRef(); const env = environmentOf(ref); report.set("CLI FINAL TARGET", env === "staging" ? "PASS" : "FAIL", [env ? environments[env].label : "OTHER"]); if (!ndjson) write("\n"); }
  report.set("TARGET", outcome.targetConfirmed ? "PASS" : "N/A", outcome.targetConfirmed ? [`${environments.staging.label} (${environments.staging.ref}), confirmed with the account's list of projects`, "the CLI was not linked or moved by this command"] : ["nothing was sent: the run stopped before connecting"]);
  const failed = outcome.results.filter((item) => item.status !== "PASS");
  report.set("SMOKES", outcome.ok ? "PASS" : "FAIL", [
    `${outcome.counts.passed}/${outcome.counts.total} PASS${outcome.counts.rejected ? `, ${outcome.counts.rejected} refused before running` : ""}${outcome.counts.notRun ? `, ${outcome.counts.notRun} not run` : ""}`,
    outcome.stopped ? `stopped: ${outcome.stopped}` : null,
    outcome.selfTests.length ? `self-test: ${outcome.selfTests.filter((item) => item.ok).length}/${outcome.selfTests.length} (${outcome.selfTests.map((item) => `${item.id} ${item.ok ? "ok" : "FAIL"}`).join(", ")})` : "self-test: not reached",
    outcome.rollbackVerified ? `rollback verified with PostgreSQL for ${outcome.counts.passed} transaction(s)` : null,
    ...failed.slice(0, 15).map((item) => `${item.status} · ${item.id}: ${item.reason ?? ""}`),
  ]);
}

const one = (options, name) => { const values = options.lists[name]; if (values && values.length !== 1) throw new PreconditionError(`${name} takes one value.`); return values?.[0]; };
const insideRepository = (root, path) => { const inside = relative(resolve(root), resolve(path)); return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside)); };

/**
 * Data snapshots: take one (counts and fingerprints, kept in the release's folder) or compare two.
 * Taking one reads the database in a read-only transaction and never links the CLI.
 */
function snapshot({ report, root, supabase, git, environment, home, options, write }) {
  const ndjson = options.flags.has("--ndjson"); const emit = (event, text) => { if (ndjson) write(JSON.stringify(event) + "\n"); else if (text) write(text + "\n"); };
  const release = one(options, "--release"); const state = createState({ repository: root, environment, home });
  if (options.lists["--compare"]) {
    const names = options.lists["--compare"];
    if (names.length !== 2 || options.lists["--label"] || options.lists["--env"] || options.lists["--output"] || options.flags.has("--replace")) throw new PreconditionError("--compare takes two snapshots (two labels of --release, or two files) and no other option.");
    const read = (name, which) => {
      if (release && /^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) { const saved = state.load(release, `snapshot-${name}`); if (!saved) throw new PreconditionError(`Release ${release} has no snapshot labelled ${name}.`); return acceptSnapshot(saved.data, which); }
      return readSnapshotFile(resolve(name), which);
    };
    const before = read(names[0], "first"), after = read(names[1], "second");
    const seen = compareSnapshots(before, after);
    for (const row of seen.rows) emit({ type: "table", table: row.table, countBefore: row.countBefore, countAfter: row.countAfter, countEqual: row.countEqual, fingerprintEqual: row.fingerprintEqual, status: row.status }, row.status === "same" ? null : `DIFFERENT  ${differenceLine(row)}`);
    emit({ type: "compare", ok: seen.ok, comparable: seen.comparable, tables: seen.rows.length, different: seen.different.length, problems: seen.problems }, null);
    const describe = (item) => `${item.meta.label} (${item.meta.environment}, ${item.meta.databaseTime})`;
    report.set("SNAPSHOT", seen.ok ? "PASS" : "FAIL", [seen.ok ? `IDENTICAL: ${seen.rows.length} table(s), same counts and same fingerprints` : seen.comparable ? `DIFFERENT: ${seen.different.length} of ${seen.rows.length} table(s)` : "NOT COMPARABLE",
      `first: ${describe(before)}`, `second: ${describe(after)}`, ...seen.problems, ...seen.different.slice(0, 20).map(differenceLine)]);
    if (!ndjson && seen.different.length) write("\n");
    return;
  }
  const label = one(options, "--label"); const target = one(options, "--env") ?? "staging"; const output = one(options, "--output");
  if (!release || !label) throw new PreconditionError("A snapshot needs --release <id> and --label <name> (for example --release h2-8c --label pre).");
  if (!Object.hasOwn(environments, target)) throw new PreconditionError("--env is staging or production.");
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(label)) throw new PreconditionError("A label uses lowercase letters, digits and dashes.");
  if (output && insideRepository(root, output)) throw new PreconditionError("--output cannot be inside the repository: snapshots are never kept there.");
  state.releaseDir(release);
  if (state.load(release, `snapshot-${label}`) && !options.flags.has("--replace")) throw new PreconditionError(`Release ${release} already has a snapshot labelled ${label}. Use another label, or --replace.`);
  const config = loadConfig(root);
  const seen = checkGit(git, { requireClean: false });
  report.set("GIT", "INFO", [`branch ${seen.state.branch ?? "(detached)"} at ${short(seen.state.commit)}`]);
  let taken;
  try { taken = captureSnapshot({ supabase, config, target, release, label, commit: seen.state.commit, environment }); }
  finally { const env = environmentOf(supabase.linkedRef()); report.set("CLI FINAL TARGET", env === "staging" ? "PASS" : env === target ? "INFO" : "FAIL", [`${env ? environments[env].label : "OTHER"}${env === "production" ? " (left as it was found)" : ""}`]); }
  report.set("TARGET", "PASS", [`${environments[target].label} (${environments[target].ref}), confirmed with the account's list of projects`, "read-only transaction; the CLI was not linked or moved by this command"]);
  const file = state.save(release, `snapshot-${label}`, taken);
  if (output) { try { writeFileSync(resolve(output), JSON.stringify(taken, null, 2) + "\n", { encoding: "utf8", flag: "w" }); } catch (error) { throw new PreconditionError(`--output could not be written (${error.code ?? "error"}).`); } }
  for (const entry of taken.tables) emit({ type: "table", table: entry.table, mode: entry.mode, count: entry.count }, `${String(entry.count).padStart(8)}  ${entry.table}${entry.mode === "count" ? "  (count only)" : ""}`);
  for (const warning of taken.warnings) emit({ type: "warning", ...warning }, `warning   ${warning.table}: ${warning.code.replace(/_/g, " ")}`);
  emit({ type: "snapshot", release, label, environment: target, tables: taken.tables.length, warnings: taken.warnings.length, file }, null);
  const excluded = taken.tables.flatMap((entry) => (entry.excluded ?? []).map((column) => `${entry.table}.${column}`));
  report.set("SNAPSHOT", "PASS", [`${label}: ${taken.tables.length} table(s), ${taken.tables.filter((entry) => entry.mode === "fingerprint").length} fingerprinted, ${taken.tables.filter((entry) => entry.mode === "count").length} counted only`,
    `rows counted: ${taken.tables.reduce((sum, entry) => sum + entry.count, 0)}`, `columns left out of fingerprints: ${excluded.length ? excluded.join(", ") : "none"}`, `tables left out on purpose: ${taken.ignored.length ? taken.ignored.join(", ") : "none"}`,
    ...taken.warnings.map((warning) => `warning: ${warning.table}: ${warning.code.replace(/_/g, " ")}`), `saved to ${file}`, output ? `also written to ${resolve(output)}` : null]);
  if (!ndjson) write("\n");
}

/** Runs one command and returns its exit code. Everything it needs can be replaced, which is how it is tested. */
export async function main(argv = process.argv.slice(2), { root = repository, environment = process.env, write = (text) => process.stdout.write(text), home, supabase, git } = {}) {
  const options = parse(argv); const report = createReport(options.command ?? "(none)");
  try {
    if (!options.command || options.unknown.length) throw new PreconditionError(options.command ? `Unknown argument: ${options.unknown.join(" ")}. ${usage}` : usage);
    if (planned.includes(options.command)) throw new PreconditionError(`"${options.command}" is not available yet. Available: ${available.join(", ")}.`);
    if (!available.includes(options.command)) throw new PreconditionError(`Unknown command: ${options.command}. ${usage}`);
    const context = { report, root, environment, home, options, write, remote: options.remote, supabase: supabase ?? createSupabase({ cwd: root, environment }), git: git ?? createGit({ cwd: root }) };
    if (options.command === "status") status(context); else if (options.command === "smoke") smoke(context); else if (options.command === "snapshot") snapshot(context); else await checkCore(context);
  } catch (error) { report.fail(error, error?.stage ?? options.command ?? "arguments"); }
  if (options.flags.has("--ndjson")) write(JSON.stringify({ type: "report", ...report.toJSON() }) + "\n");
  else write(options.json ? JSON.stringify(report.toJSON(), null, 2) + "\n" : report.render());
  return report.exitCode();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((code) => { process.exitCode = code; }, (error) => { process.stderr.write(`${redact(error?.message ?? error)}\n`); process.exitCode = EXIT.CHECK_FAILED; });
