#!/usr/bin/env node
/**
 * Bellis release tooling. One entry point; each command has one job and ends with the same report and an exit
 * code that says whether to go on (scripts/release/lib/report.mjs).
 *
 *   node scripts/release/cli.mjs status        where things are: repository, linked project, migrations. Reads only.
 *   node scripts/release/cli.mjs check-core    the tooling's own guardrails, including a rehearsal of the target
 *                                              guard against a simulated CLI. Reads only; no request is sent.
 *     --remote   (status) also asks the Supabase account which project is linked. One read-only request.
 *     --json     print the report as JSON instead of text.
 *
 * Neither command links the CLI, applies a migration, moves a branch or writes outside the release state folder.
 * The commands that do (staging, prod-precheck, prod-release) are not available yet and answer with exit 2.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGit, checkGit, short } from "./lib/git.mjs";
import { EXIT, PreconditionError, ReleaseError, createReport, exitCodeFor, exitName, redact, reportSections } from "./lib/report.mjs";
import { createState } from "./lib/state.mjs";
import { createSupabase } from "./lib/supabase.mjs";
import { CleanupFailed, environmentOf, environments, inspectTarget, withTarget } from "./lib/target.mjs";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const available = Object.freeze(["status", "check-core"]);
export const planned = Object.freeze(["check", "staging", "prod-precheck", "prod-release"]);
const usage = `Usage: node scripts/release/cli.mjs <${available.join("|")}> [--remote] [--json]`;

function parse(argv) {
  const [command, ...rest] = argv; const flags = new Set(rest.filter((item) => item.startsWith("--")));
  const unknown = [...flags].filter((flag) => !["--remote", "--json"].includes(flag)).concat(rest.filter((item) => !item.startsWith("--")));
  return { command, remote: flags.has("--remote"), json: flags.has("--json"), unknown };
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

/** Runs one command and returns its exit code. Everything it needs can be replaced, which is how it is tested. */
export async function main(argv = process.argv.slice(2), { root = repository, environment = process.env, write = (text) => process.stdout.write(text), home, supabase, git } = {}) {
  const options = parse(argv); const report = createReport(options.command ?? "(none)");
  try {
    if (!options.command || options.unknown.length) throw new PreconditionError(options.command ? `Unknown argument: ${options.unknown.join(" ")}. ${usage}` : usage);
    if (planned.includes(options.command)) throw new PreconditionError(`"${options.command}" is not available yet. Available: ${available.join(", ")}.`);
    if (!available.includes(options.command)) throw new PreconditionError(`Unknown command: ${options.command}. ${usage}`);
    const context = { report, root, environment, home, remote: options.remote, supabase: supabase ?? createSupabase({ cwd: root, environment }), git: git ?? createGit({ cwd: root }) };
    if (options.command === "status") status(context); else await checkCore(context);
  } catch (error) { report.fail(error, error?.stage ?? options.command ?? "arguments"); }
  write(options.json ? JSON.stringify(report.toJSON(), null, 2) + "\n" : report.render());
  return report.exitCode();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((code) => { process.exitCode = code; }, (error) => { process.stderr.write(`${redact(error?.message ?? error)}\n`); process.exitCode = EXIT.CHECK_FAILED; });
