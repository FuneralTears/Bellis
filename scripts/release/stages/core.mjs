/**
 * Release tooling: the tooling's own guardrails, checked without sending a single request. Used by check-core and
 * by check.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT, exitCodeFor, exitName, redact, reportSections } from "../lib/report.mjs";
import { createState } from "../lib/state.mjs";
import { CleanupFailed, environmentOf, environments, withTarget, writableEnvironments } from "../lib/target.mjs";

/**
 * A CLI that only exists in memory, with the two real refs. It lets the target guard be rehearsed (wrong project,
 * ambiguous list, a failing step, a failing way back) without sending a single request.
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

/** The guardrails, as { name, ok, detail }. `commands` are the ones the CLI exposes. */
export async function toolingSelfTest({ root, supabase, environment, home, commands }) {
  const checks = []; const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  // One list of refs: the build guard, the runtime guard and this tooling have to agree.
  const runtime = /productionProjectRef\s*=\s*"([a-z0-9]{20})"/.exec(readFileSync(join(root, "lib", "supabase-target.ts"), "utf8"))?.[1];
  add("project refs agree", runtime === environments.production.ref && environments.staging.ref !== environments.production.ref, "scripts/assert-staging-env.mjs and lib/supabase-target.ts name the same production project");
  const codes = Object.values(EXIT);
  add("exit codes", new Set(codes).size === codes.length && codes.every((code) => exitName(code) !== "UNKNOWN") && codes.join() === "0,1,2,3,4,5", `${codes.length} codes, each one with one meaning`);
  add("report sections", reportSections.join() === "TARGET,GIT,MIGRATIONS,DRIFT,SNAPSHOT,SMOKES,DEPLOY,CLI FINAL TARGET", "the report has its sections in the agreed order");
  let stateRoot = null; try { stateRoot = createState({ repository: root, environment, home }).root; } catch (error) { add("release state outside the repository", false, redact(error.message)); }
  if (stateRoot) add("release state outside the repository", true, "runtime state is kept outside the repository");
  let refused = false; try { createState({ repository: root, root: join(root, "releases") }); } catch { refused = true; }
  add("release state refused inside the repository", refused, "a folder inside the repository is rejected");
  const version = supabase.version();
  add("Supabase CLI", version.ok, version.ok ? `version ${version.version}, from ${supabase.source}` : `could not be run (${version.reason})`);
  add("redaction", !/hunter2|eyJhbGciOi/.test(redact("postgres://user:hunter2@db.example/postgres token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abcdefgh")), "credentials are removed from anything shown");
  add("nothing writes to production", writableEnvironments.join() === "staging" && !commands.some((name) => name.startsWith("prod")), `writable: ${writableEnvironments.join(", ")}; commands: ${commands.join(", ")}`);
  return [...checks, ...(await rehearseTargetGuard())];
}
