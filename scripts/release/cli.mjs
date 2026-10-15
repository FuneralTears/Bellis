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
 *   node scripts/release/cli.mjs drift         the schema, read from PostgreSQL's catalogs. Read-only except --rehearse.
 *     --capture --release <id> --env <staging|production>   capture it (label: the environment, or --label).
 *     --compare <a> <b>   compare two captures exactly: labels of --release, or files. Any difference fails.
 *     --verbose           (with --compare) also show each side of what differs, with credentials removed.
 *     --rehearse --release <id>   on staging only, before the release's migrations are applied there: run them in
 *                                 one transaction, capture the schema, roll back. Keeps `base` and `expected`.
 *     --expected --release <id>   is the difference between staging and production exactly the release? Compares the
 *                                 captures base, expected, staging and production. Runs nothing.
 *
 *   node scripts/release/cli.mjs check --release <id>     everything about a release that can be checked on this
 *                                              machine: manifest, git, migrations, smokes' files, tooling, tests,
 *                                              TypeScript, ESLint, build. Never touches Supabase.
 *   node scripts/release/cli.mjs staging --release <id>   takes the release to staging (see stages/staging.mjs). Writes
 *                                              only to staging; production is only read.
 *     --confirm-preview <id>   a person confirms they looked at the Preview. Writes nothing but the release's state.
 *     --reuse-rehearsal <folder>   only when the release is already applied on staging and its state has no rehearsal:
 *                              reuse the rehearsal kept in that folder of the releases directory, after checking it is
 *                              this release's, of the same migrations and hashes, on the same line of commits, and that
 *                              staging is an exact match of its expected schema. Any failure stops; nothing is reused.
 *
 *   node scripts/release/cli.mjs backup-check --release <id>   the two production backups (public, private) a person
 *                                              made: local files only, read with pg_restore --list.
 *     --public <file> --private <file>   check these files instead of the newest ones in the backups folder.
 *     --max-age-hours <n>                how old a backup may be (24 by default).
 *   node scripts/release/cli.mjs prod-precheck --release <id>  everything about production before a release, read-only
 *                                              (see stages/prod-precheck.mjs). Writes nothing to any database.
 *     --reuse             reuse a precheck of this commit and manifest that has not expired (2 hours).
 *
 *   node scripts/release/cli.mjs deploy-check --expected-env <production|preview|development> [--release <id>]
 *                                              what a deployment serves, from its /api/version: commit, environment
 *                                              and Supabase project. Reads public URLs only; never deploys or promotes.
 *     --url <exact deployment URL>   otherwise it is found through GitHub's public deployments of the commit.
 *     --expected-commit <sha> --expected-ref <ref> --alias <url>   (the alias defaults to the production one)
 *     --confirm-human <id> --url <url>   a person confirms a Preview this tool cannot read (behind Vercel's login).
 *
 *   node scripts/release/cli.mjs prod-release --release <id>   the release to production: the only command that writes
 *                                              there. Needs CONFIRM_PROD_RELEASE=<id>@<short commit>, a valid precheck
 *                                              and the release id typed in a terminal (see stages/prod-release.mjs).
 *
 * Only staging, and production through prod-release, are written to. Nothing here moves a branch. The command that would write to
 * production (prod-release) is not available yet and answers with exit 2.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGit, checkGit, short } from "./lib/git.mjs";
import { EXIT, HumanActionRequired, PreconditionError, ReleaseError, backupSections, checkSections, createReport, deploySections, precheckSections, prodReleaseSections, redact, releaseSections } from "./lib/report.mjs";
import { createState } from "./lib/state.mjs";
import { createSupabase } from "./lib/supabase.mjs";
import { environmentOf, environments, inspectTarget } from "./lib/target.mjs";
import { defaultRunLocal, runCheck } from "./stages/check.mjs";
import { toolingSelfTest } from "./stages/core.mjs";
import { openReleaseState, stateName } from "./stages/release-state.mjs";
import { confirmPreview, runStaging } from "./stages/staging.mjs";
import { runBackupCheck, runPrecheck } from "./stages/prod-precheck.mjs";
import { defaultListToc } from "./backup/validate.mjs";
import { runDeployCheck } from "./stages/deploy-check.mjs";
import { runProdRelease } from "./stages/prod-release.mjs";
import { loadManifest, selectSmokes } from "./smoke/manifest.mjs";
import { humanLine, resolvePending, runSmokes } from "./smoke/runner.mjs";
import { captureSchema } from "./drift/capture.mjs";
import { acceptCapture, compareSchemas, differenceDetail, differenceLine as driftLine, readCaptureFile } from "./drift/compare.mjs";
import { explainExpected, rehearse, releaseMigrations } from "./drift/migration-diff.mjs";
import { loadConfig } from "./snapshot/build-sql.mjs";
import { captureSnapshot } from "./snapshot/capture.mjs";
import { acceptSnapshot, compareSnapshots, differenceLine, readSnapshotFile } from "./snapshot/compare.mjs";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const available = Object.freeze(["status", "check-core", "smoke", "snapshot", "drift", "check", "staging", "backup-check", "prod-precheck", "deploy-check", "prod-release"]);
export const planned = Object.freeze([]);
const usage = `Usage: node scripts/release/cli.mjs <${available.join("|")}> [options] (see the top of scripts/release/cli.mjs)`;
/** The options each command takes: `true` for a switch, "list" for one that is followed by one or more values. */
const optionsOf = Object.freeze({
  status: { "--remote": true, "--json": true },
  "check-core": { "--json": true },
  smoke: { "--all": true, "--list": true, "--ndjson": true, "--json": true, "--group": "list", "--only": "list", "--with-pending": "list", "--release": "list" },
  drift: { "--ndjson": true, "--json": true, "--capture": true, "--rehearse": true, "--expected": true, "--replace": true, "--verbose": true, "--release": "list", "--label": "list", "--env": "list", "--compare": "list" },
  check: { "--json": true, "--release": "list" },
  "backup-check": { "--json": true, "--release": "list", "--public": "list", "--private": "list", "--max-age-hours": "list" },
  "prod-release": { "--json": true, "--release": "list" },
  "deploy-check": { "--json": true, "--release": "list", "--url": "list", "--alias": "list", "--expected-commit": "list", "--expected-env": "list", "--expected-ref": "list", "--confirm-human": "list" },
  "prod-precheck": { "--json": true, "--release": "list", "--reuse": true, "--public": "list", "--private": "list", "--max-age-hours": "list" },
  staging: { "--json": true, "--release": "list", "--confirm-preview": "list", "--reuse-rehearsal": "list" },
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

async function checkCore({ report, root, supabase, git, environment, home }) {
  describeTarget(report, supabase, { remote: false, environment });
  const seen = checkGit(git, { requireClean: false });
  report.set("GIT", seen.ok ? "PASS" : "FAIL", [`branch ${seen.state.branch ?? "(detached)"} at ${short(seen.state.commit)}`, ...seen.checks.map(line)]);
  const checks = await toolingSelfTest({ root, supabase, environment, home, commands: available });
  // The guardrails have no section of their own in the agreed report: they go under SMOKES, labelled as the
  // tooling's self-test, and any failure there fails the command.
  report.set("MIGRATIONS", "INFO", [`${localMigrations(root).length} local migration(s)`, "applied migrations are not read by this command"]);
  report.set("SMOKES", section(checks), ["tooling self-test (no SQL smoke is run by this command)", ...checks.map(line)]);
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

/**
 * Schema drift: capture a schema, compare two exactly, rehearse a release's migrations on staging, or check that
 * the difference between staging and production is exactly the release. Nothing here links the CLI or writes to
 * production; the rehearsal is a transaction on staging that is rolled back.
 */
function drift({ report, root, supabase, git, environment, home, options, write }) {
  const ndjson = options.flags.has("--ndjson"); const emit = (event, text) => { if (ndjson) write(JSON.stringify(event) + "\n"); else if (text) write(text + "\n"); };
  const modes = ["--capture", "--rehearse", "--expected"].filter((name) => options.flags.has(name)).concat(options.lists["--compare"] ? ["--compare"] : []);
  if (modes.length !== 1) throw new PreconditionError("drift takes one of --capture, --compare, --rehearse or --expected.");
  const release = one(options, "--release"); const state = createState({ repository: root, environment, home }); const labelPattern = /^[a-z0-9][a-z0-9-]{0,30}$/;
  const stored = (label, which = label) => { const saved = state.load(release, `schema-${label}`); return saved ? acceptCapture(saved.data, which) : null; };
  const finalTarget = (target) => { const env = environmentOf(supabase.linkedRef()); report.set("CLI FINAL TARGET", env === "staging" ? "PASS" : env === target ? "INFO" : "FAIL", [`${env ? environments[env].label : "OTHER"}${env === "production" ? " (left as it was found)" : ""}`]); };
  const countsLine = (capture) => Object.entries(capture.counts).map(([category, count]) => `${category} ${count}`).join(", ");
  const show = (differences, names, tag = "") => { for (const item of differences) emit({ type: "difference", ...(tag ? { group: tag } : {}), category: item.category, object: redact(item.id, 200), change: item.change, parts: item.parts }, `${tag ? `${tag.padEnd(11)}  ` : ""}${driftLine(item, names)}`); };
  if (modes[0] !== "--compare" && !release) throw new PreconditionError("drift needs --release <id>: captures are kept in the release's folder.");
  if (release) state.releaseDir(release);

  if (modes[0] === "--capture") {
    const target = one(options, "--env"); const label = one(options, "--label") ?? target;
    if (!target || !Object.hasOwn(environments, target)) throw new PreconditionError("--capture needs --env staging or --env production.");
    if (!labelPattern.test(label)) throw new PreconditionError("A label uses lowercase letters, digits and dashes.");
    if (["base", "expected"].includes(label)) throw new PreconditionError("The labels base and expected belong to --rehearse.");
    if (state.load(release, `schema-${label}`) && !options.flags.has("--replace")) throw new PreconditionError(`Release ${release} already has a schema capture labelled ${label}. Use another label, or --replace.`);
    const commit = checkGit(git, { requireClean: false }).state.commit;
    let taken; try { taken = captureSchema({ supabase, target, release, label, gitCommit: commit, environment }); } finally { finalTarget(target); }
    report.set("TARGET", "PASS", [`${environments[target].label} (${environments[target].ref}), confirmed with the account's list of projects`, "read-only transaction; the CLI was not linked or moved by this command"]);
    const file = state.save(release, `schema-${label}`, taken);
    for (const [category, count] of Object.entries(taken.counts)) emit({ type: "category", category, objects: count }, `${String(count).padStart(6)}  ${category}`);
    for (const warning of taken.warnings) emit({ type: "warning", ...warning }, `warning  ${warning.code.replace(/_/g, " ")}: ${redact(warning.object, 80)}`);
    emit({ type: "capture", release, label, environment: target, objects: Object.values(taken.counts).reduce((sum, count) => sum + count, 0), migrations: taken.appliedMigrations.length, file }, null);
    report.set("MIGRATIONS", "INFO", [`${taken.appliedMigrations.length} applied on ${target}`, taken.appliedMigrations.length ? `latest: ${taken.appliedMigrations.at(-1)}` : null]);
    report.set("DRIFT", "INFO", [`${label}: schema of ${target} captured, ${Object.values(taken.counts).reduce((sum, count) => sum + count, 0)} object(s)`, countsLine(taken), ...taken.warnings.map((warning) => `warning: ${warning.code.replace(/_/g, " ")}: ${redact(warning.object, 80)}`), `saved to ${file}`]);
    if (!ndjson) write("\n");
    return;
  }

  if (modes[0] === "--compare") {
    const names = options.lists["--compare"]; if (names.length !== 2) throw new PreconditionError("--compare takes two captures: two labels of --release, or two files.");
    const read = (name, which) => { if (release && labelPattern.test(name)) { const found = stored(name, which); if (!found) throw new PreconditionError(`Release ${release} has no schema capture labelled ${name}.`); return found; } return readCaptureFile(resolve(name), which); };
    const first = read(names[0], "first"), second = read(names[1], "second"); const labels = [first.meta.label, second.meta.label]; const shown = labels[0] === labels[1] ? ["first", "second"] : labels;
    const seen = compareSchemas(first, second);
    show(seen.differences, shown);
    if (options.flags.has("--verbose") && !ndjson) for (const item of seen.differences) { const lines = differenceDetail(item, first, second, shown); if (lines.length) write(`${driftLine(item, shown)}\n${lines.join("\n")}\n`); }
    emit({ type: "compare", ok: seen.ok, differences: seen.differences.length, counts: seen.counts }, null);
    const describe = (capture) => `${capture.meta.label} (${capture.meta.environment}, ${capture.meta.databaseTime}, ${capture.appliedMigrations.length} migrations)`;
    report.set("MIGRATIONS", first.appliedMigrations.join() === second.appliedMigrations.join() ? "INFO" : "FAIL", [first.appliedMigrations.join() === second.appliedMigrations.join() ? `the same ${first.appliedMigrations.length} migrations are applied on both` : "the two do not have the same migrations applied"]);
    report.set("DRIFT", seen.ok ? "PASS" : "FAIL", [seen.ok ? `EXACT MATCH: ${Object.values(seen.counts).reduce((sum, item) => sum + item.first, 0)} object(s), no difference` : `DRIFT: ${seen.differences.length} difference(s)`,
      `first: ${describe(first)}`, `second: ${describe(second)}`, ...seen.differences.slice(0, 25).map((item) => driftLine(item, shown)), seen.differences.length > 25 ? `… and ${seen.differences.length - 25} more` : null]);
    if (!ndjson && seen.differences.length) write("\n");
    return;
  }

  const pending = releaseMigrations(root, release);
  report.set("MIGRATIONS", "INFO", pending.map((item) => `of the release: ${item.file} (sha256 ${item.sha256.slice(0, 12)}, matches the manifest)`));

  if (modes[0] === "--rehearse") {
    if ((state.load(release, "schema-base") || state.load(release, "schema-expected")) && !options.flags.has("--replace")) throw new PreconditionError(`Release ${release} was already rehearsed. Use --replace to rehearse it again.`);
    const commit = checkGit(git, { requireClean: false }).state.commit;
    let outcome; try { outcome = rehearse({ supabase, pending, release, gitCommit: commit, environment }); } finally { finalTarget("staging"); }
    report.set("TARGET", "PASS", [`${environments.staging.label} (${environments.staging.ref}), confirmed with the account's list of projects`, "one transaction, rolled back; PostgreSQL reports it as aborted and the schema is what it was"]);
    state.save(release, "schema-base", outcome.base); const file = state.save(release, "schema-expected", outcome.expected);
    show(outcome.changes.differences, ["before", "after the release"]);
    emit({ type: "rehearsal", release, migrations: pending.map((item) => item.file), changes: outcome.changes.differences.length }, null);
    report.set("DRIFT", "INFO", [`rehearsed on staging: the release changes ${outcome.changes.differences.length} object(s)`, ...outcome.changes.differences.slice(0, 25).map((item) => driftLine(item, ["before", "after the release"])), `kept as base and expected next to ${file}`]);
    if (!ndjson) write("\n");
    return;
  }

  // --expected: four captures, compared. Nothing is run.
  const base = stored("base"), expected = stored("expected");
  if (!base || !expected) throw new HumanActionRequired(`Release ${release} was not rehearsed. What its migrations change has to be measured on staging before they are applied there (drift --rehearse --release ${release}).`, { stage: "expected diff" });
  const staging = stored("staging"), production = stored("production");
  if (!staging || !production) throw new PreconditionError(`Capture both schemas first: drift --capture --release ${release} --env staging, and --env production.`);
  const seen = explainExpected({ base, expected, staging, production, pending });
  show(seen.explained, ["production", "staging"], "EXPLAINED"); show(seen.drift, ["rehearsed base", "production"], "DRIFT"); show(seen.unexplained, ["expected", "staging"], "UNEXPLAINED");
  emit({ type: "expected", ok: seen.ok, explained: seen.explained.length, drift: seen.drift.length, unexplained: seen.unexplained.length, problems: seen.problems }, null);
  report.set("DRIFT", seen.ok ? "PASS" : "FAIL", [seen.ok ? `EXPLAINED: the ${seen.explained.length} difference(s) between staging and production are exactly what the release's migrations do` : "NOT EXPLAINED BY THE RELEASE",
    ...seen.problems, `changed by the migrations: ${seen.explained.length}`, `drift in production (differs from what the release was rehearsed on): ${seen.drift.length}`, `in staging and not explained by the migrations: ${seen.unexplained.length}`,
    ...seen.drift.slice(0, 15).map((item) => `DRIFT ${driftLine(item, ["rehearsed base", "production"])}`), ...seen.unexplained.slice(0, 15).map((item) => `UNEXPLAINED ${driftLine(item, ["expected", "staging"])}`)]);
  if (!ndjson) write("\n");
}

/** `bellis:check`: local only. A release that passes is recorded as CHECKED. */
async function check({ report, root, supabase, git, environment, home, options, runLocal }) {
  const release = one(options, "--release"); if (!release) throw new PreconditionError("check needs --release <id>.");
  const state = createState({ repository: root, environment, home });
  const found = await runCheck({ root, git, supabase, environment, home, release, report, commands: available, runLocal: runLocal ?? defaultRunLocal(root, environment) });
  if (!found.ok) throw new ReleaseError("The release does not pass its checks.", { exitCode: EXIT.CHECK_FAILED, stage: "check" });
  const progress = openReleaseState(state, release, { manifest: found.manifest, manifestHash: found.hash });
  progress.advance("CHECKED", { commit: found.head, detail: "bellis:check passed" });
}

/** `bellis:staging`, or `--confirm-preview`. */
async function staging({ report, root, supabase, git, environment, home, options, runLocal, signals }) {
  const release = one(options, "--release"); if (!release) throw new PreconditionError("staging needs --release <id>.");
  const state = createState({ repository: root, environment, home });
  const reuseRehearsal = one(options, "--reuse-rehearsal");
  if (reuseRehearsal && options.lists["--confirm-preview"]) throw new PreconditionError("--reuse-rehearsal cannot be combined with --confirm-preview.");
  if (options.lists["--confirm-preview"]) { confirmPreview({ root, git, release, typed: one(options, "--confirm-preview"), report, state }); report.set("CLI FINAL TARGET", "N/A", ["Supabase was not used"]); return; }
  try { await runStaging({ root, git, supabase, environment, home, release, report, state, signals, reuseRehearsal, commands: available, runLocal: runLocal ?? defaultRunLocal(root, environment) }); }
  finally { const env = environmentOf(supabase.linkedRef()); report.set("CLI FINAL TARGET", env === "staging" ? "STAGING" : "OTHER", [env ? environments[env].label : "not linked"]); }
}

const backupOptions = (options) => {
  const hours = one(options, "--max-age-hours"); if (hours !== undefined && !(Number(hours) > 0 && Number(hours) <= 168)) throw new PreconditionError("--max-age-hours is a number of hours between 1 and 168.");
  return { paths: { public: one(options, "--public"), private: one(options, "--private") }, maxAgeHours: hours === undefined ? undefined : Number(hours) };
};
/** `bellis:backup-check`: the two backups of a release, local files only. */
function backupCheck({ report, root, environment, home, options, listToc, now }) {
  const release = one(options, "--release"); if (!release) throw new PreconditionError("backup-check needs --release <id>.");
  runBackupCheck({ root, release, report, state: createState({ repository: root, environment, home }), environment, home, listToc: listToc ?? defaultListToc(environment), now: now ?? (() => new Date()), ...backupOptions(options) });
}
/** `bellis:prod-precheck`: production, read-only. */
async function prodPrecheck({ report, root, supabase, git, environment, home, options, listToc, now, signals }) {
  const release = one(options, "--release"); if (!release) throw new PreconditionError("prod-precheck needs --release <id>.");
  try { await runPrecheck({ root, git, supabase, environment, home, release, report, state: createState({ repository: root, environment, home }), listToc: listToc ?? defaultListToc(environment), signals, reuse: options.flags.has("--reuse"), now: now ?? (() => new Date()), ...backupOptions(options) }); }
  finally {
    const env = environmentOf(supabase.linkedRef()); report.set("CLI FINAL TARGET", env === "staging" ? "STAGING" : "OTHER", [env ? environments[env].label : "not linked"]);
    if (report.get("SAFE TO APPLY PROD?").status !== "YES") report.set("SAFE TO APPLY PROD?", "NO", ["the precheck did not pass"]);
  }
}

/** `bellis:deploy-check`: what a deployment serves. Writes nothing but the release's deploy records. */
async function deployCheck({ report, root, git, environment, home, options, fetchImpl, now }) {
  const release = one(options, "--release");
  await runDeployCheck({ root, git, release, report, state: createState({ repository: root, environment, home }), fetchImpl: fetchImpl ?? fetch, now: now ?? (() => new Date()),
    options: { url: one(options, "--url"), alias: one(options, "--alias"), expectedCommit: one(options, "--expected-commit"), expectedEnv: one(options, "--expected-env"), expectedRef: one(options, "--expected-ref"), confirmHuman: one(options, "--confirm-human") } });
}

/** `bellis:prod-release`: the release to production. */
async function prodRelease({ report, root, supabase, git, environment, home, signals, fetchImpl, now, prompt, sleep, aliasUrl, timings, options }) {
  const release = one(options, "--release"); if (!release) throw new PreconditionError("prod-release needs --release <id>.");
  try {
    await runProdRelease({ root, git, supabase, environment, home, release, report, state: createState({ repository: root, environment, home }), signals, fetchImpl: fetchImpl ?? fetch, now: now ?? (() => new Date()),
      ...(prompt ? { prompt } : {}), ...(sleep ? { sleep } : {}), ...(aliasUrl ? { alias: aliasUrl } : {}), ...(timings ? { timings } : {}) });
  } finally { const env = environmentOf(supabase.linkedRef()); report.set("CLI FINAL TARGET", env === "staging" ? "STAGING" : "OTHER", [env ? environments[env].label : "not linked"]); }
}

/** Runs one command and returns its exit code. Everything it needs can be replaced, which is how it is tested. */
export async function main(argv = process.argv.slice(2), { root = repository, environment = process.env, write = (text) => process.stdout.write(text), home, supabase, git, runLocal, signals = process, listToc, now, fetchImpl, prompt, sleep, aliasUrl, timings } = {}) {
  const options = parse(argv);
  const sectionsOf = { check: checkSections, staging: releaseSections, "backup-check": backupSections, "prod-precheck": precheckSections, "deploy-check": deploySections, "prod-release": prodReleaseSections };
  const report = createReport(options.command ?? "(none)", { sections: sectionsOf[options.command] });
  try {
    if (!options.command || options.unknown.length) throw new PreconditionError(options.command ? `Unknown argument: ${options.unknown.join(" ")}. ${usage}` : usage);
    if (planned.includes(options.command)) throw new PreconditionError(`"${options.command}" is not available yet. Available: ${available.join(", ")}.`);
    if (!available.includes(options.command)) throw new PreconditionError(`Unknown command: ${options.command}. ${usage}`);
    const context = { report, root, environment, home, options, write, runLocal, signals, listToc, now, fetchImpl, prompt, sleep, aliasUrl, timings, remote: options.remote, supabase: supabase ?? createSupabase({ cwd: root, environment }), git: git ?? createGit({ cwd: root }) };
    const commands = { status, smoke, snapshot, drift, check, staging, "check-core": checkCore, "backup-check": backupCheck, "prod-precheck": prodPrecheck, "deploy-check": deployCheck, "prod-release": prodRelease };
    await commands[options.command](context);
  } catch (error) { report.fail(error, error?.stage ?? options.command ?? "arguments"); }
  if (["check", "staging", "backup-check", "prod-precheck", "deploy-check", "prod-release"].includes(options.command)) persist(report, options, { root, environment, home });
  if (options.flags.has("--ndjson")) write(JSON.stringify({ type: "report", ...report.toJSON() }) + "\n");
  else write(options.json ? JSON.stringify(report.toJSON(), null, 2) + "\n" : report.render());
  return report.exitCode();
}

/** The report of check and staging, and the release's state, kept in the release's folder. A failure to keep it is said, not hidden. */
function persist(report, options, { root, environment, home }) {
  const release = options.lists["--release"]?.[0]; if (!release) return;
  try {
    const state = createState({ repository: root, environment, home });
    if (report.get("STATE") && options.command !== "deploy-check") { const saved = state.load(release, stateName)?.data?.state; report.set("STATE", saved ?? "N/A", [saved ? `release ${release}` : "no state recorded"]); }
    state.save(release, `${options.command}-report`, report.toJSON());
  } catch (error) { report.set(report.get("STATE") ? "STATE" : "RELEASE", report.get("STATE") ? "N/A" : "INFO", [`the report could not be kept: ${redact(error?.message ?? error, 160)}`]); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((code) => { process.exitCode = code; }, (error) => { process.stderr.write(`${redact(error?.message ?? error)}\n`); process.exitCode = EXIT.CHECK_FAILED; });
