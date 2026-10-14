/**
 * Release tooling: `bellis:check`. Everything that can be checked about a release on this machine, without touching
 * Supabase: the manifest, the repository, the migrations, the smokes' files, the tooling's guardrails, the unit
 * tests, TypeScript, ESLint and the build.
 *
 * It is split in two so `bellis:staging` can reuse it: `staticChecks` (seconds, always run again) and `localChecks`
 * (minutes; skipped by staging when this same commit and manifest already passed them).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkGit, short } from "../lib/git.mjs";
import { loadReleaseManifest, manifestFile } from "../lib/manifest.mjs";
import { CheckFailed, HumanActionRequired, redact } from "../lib/report.mjs";
import { migrationRisks, rehearsalSql } from "../drift/migration-diff.mjs";
import { loadManifest, selectSmokes } from "../smoke/manifest.mjs";
import { resolvePending } from "../smoke/runner.mjs";
import { validateSmokeSql } from "../smoke/sql.mjs";
import { readFileSync } from "node:fs";
import { toolingSelfTest } from "./core.mjs";

const line = (check) => `${check.ok ? "ok" : "FAIL"} · ${check.name}: ${check.detail}`;

/**
 * Whether HEAD is the source commit, or a descendant of it whose only change is this release's manifest (the
 * manifest is committed on top of the code it describes, so it can never be in the commit it names).
 */
export function sourceCommitCheck(git, manifest) {
  const head = git.commit("HEAD"); const source = manifest.sourceCommit;
  if (!git.commit(source)) return { ok: false, detail: `the source commit ${short(source)} does not exist here` };
  if (head === source) return { ok: true, detail: `HEAD is the source commit ${short(source)}` };
  if (!git.isAncestor(source, head)) return { ok: false, detail: `HEAD ${short(head)} does not descend from the source commit ${short(source)}` };
  const changed = git.changedFiles(source, head);
  const extra = changed.filter((file) => file !== manifestFile(manifest.releaseId));
  return extra.length ? { ok: false, detail: `HEAD ${short(head)} changes ${extra.length} file(s) after the source commit ${short(source)}: ${extra.slice(0, 5).join(", ")}` }
    : { ok: true, detail: `HEAD ${short(head)} is the source commit ${short(source)} plus this release's manifest` };
}

/**
 * Manifest, repository, migrations and smoke files. Fills RELEASE, GIT, MIGRATIONS and SMOKES of `report`, and
 * returns { ok, manifest, hash, pending, head, smokes }. Throws only when the manifest cannot be read at all.
 */
export function staticChecks({ root, git, release, report }) {
  const smokeManifest = loadManifest(root);
  const { manifest, hash } = loadReleaseManifest(root, release, { smokeGroups: Object.keys(smokeManifest.groups) });
  report.set("RELEASE", "INFO", [`${manifest.releaseId}: ${manifestFile(manifest.releaseId)} (sha256 ${hash.slice(0, 12)})`, `source commit ${short(manifest.sourceCommit)}, main base ${short(manifest.expectedMainBase)}`,
    `${manifest.migrations.length} migration(s); smoke groups: ${manifest.smokeGroups.join(", ")}; Preview ${manifest.previewRequired ? "required" : "not required"}`, manifest.branch ? `branch ${manifest.branch}` : null]);
  let ok = true;

  const seen = checkGit(git, { requireClean: true, expectBranch: manifest.branch, expectMain: manifest.expectedMainBase, fastForwardMainTo: "HEAD" });
  const source = sourceCommitCheck(git, manifest);
  const detached = { ok: seen.state.branch !== null, name: "branch", detail: seen.state.branch ? `on ${seen.state.branch}` : "HEAD is detached" };
  const gitChecks = [...seen.checks, { name: "source commit", ...source }, ...(manifest.branch ? [] : [detached])];
  const gitOk = gitChecks.every((item) => item.ok); ok &&= gitOk;
  report.set("GIT", gitOk ? "PASS" : "FAIL", [`branch ${seen.state.branch ?? "(detached)"} at ${short(seen.state.commit)}, main at ${short(seen.state.main)}`, ...gitChecks.map(line)]);

  let pending = []; const migrationLines = [];
  if (!manifest.migrations.length) migrationLines.push("this release has no migrations: nothing to rehearse or apply");
  try {
    pending = manifest.migrations.length ? resolvePending(root, manifest.migrations.map((item) => item.file), { release }) : [];
    for (const item of pending) migrationLines.push(`${item.file}: sha256 ${item.sha256.slice(0, 12)} matches the manifest`);
    const risks = pending.flatMap((item) => migrationRisks(item.text).map((risk) => `${item.file}: ${risk}`));
    if (risks.length) throw new HumanActionRequired("A migration of the release cannot be rehearsed safely.", { stage: "migrations", details: risks });
    if (pending.length) { rehearsalSql(pending); migrationLines.push("the rehearsal is one transaction that is rolled back"); }
    report.set("MIGRATIONS", "PASS", migrationLines);
  } catch (error) {
    ok = false; report.set("MIGRATIONS", error instanceof HumanActionRequired ? "HUMAN" : "FAIL", [...migrationLines, redact(error.message, 300), ...(error.details ?? []).slice(0, 10)]);
  }

  const smokes = selectSmokes(smokeManifest, { groups: manifest.smokeGroups });
  const refused = smokes.filter((smoke) => !validateSmokeSql(readFileSync(join(root, smoke.file), "utf8"), { checks: smoke.checks ?? [] }).ok);
  const smokesOk = smokes.length > 0 && refused.length === 0; ok &&= smokesOk;
  report.set("SMOKES", smokesOk ? "PASS" : "FAIL", [`${smokes.length} smoke(s) in ${manifest.smokeGroups.join(", ")}; each one is a transaction that is rolled back`, ...refused.map((smoke) => `refused: ${smoke.id}`)]);
  return { ok, manifest, hash, pending, head: seen.state.commit, smokes, smokeManifest, clean: seen.state.clean };
}

/** The four local commands, run without a shell, their output never printed: one summary line each. */
export function defaultRunLocal(root, environment = process.env) {
  const node = (args, timeout = 900_000) => { const result = spawnSync(process.execPath, args, { cwd: root, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout, maxBuffer: 256 * 1024 * 1024 }); return { code: result.status ?? 1, text: `${result.stdout ?? ""}\n${result.stderr ?? ""}` }; };
  const has = (path) => existsSync(join(root, path));
  return (step, { files = [] } = {}) => {
    if (step === "tests") { const run = node(["scripts/run-tests.mjs"]); const summary = /\d+ file\(s\), \d+ test\(s\)[^\n]*/.exec(run.text)?.[0] ?? "no summary"; return { ok: run.code === 0, summary: redact(summary, 200) }; }
    if (step === "typescript") { if (!has("node_modules/typescript/bin/tsc")) return { ok: false, summary: "TypeScript is not installed" }; const run = node(["node_modules/typescript/bin/tsc", "--noEmit"]); const errors = (run.text.match(/error TS\d+/g) ?? []).length; return { ok: run.code === 0, summary: run.code === 0 ? "no errors" : `${errors} error(s)` }; }
    if (step === "lint") {
      if (!has("node_modules/eslint/bin/eslint.js")) return { ok: false, summary: "ESLint is not installed" };
      const run = node(["node_modules/eslint/bin/eslint.js", ...files]); const problems = /✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/.exec(run.text);
      return { ok: run.code === 0, summary: `${files.length} path(s): ${problems ? `${problems[2]} error(s), ${problems[3]} warning(s)` : run.code === 0 ? "no problems" : "failed"}` };
    }
    if (step === "build") {
      const guard = node(["scripts/assert-staging-env.mjs", "--build"]); if (guard.code !== 0) return { ok: false, summary: "the build guard refused the environment" };
      if (!has("node_modules/next/dist/bin/next")) return { ok: false, summary: "Next.js is not installed" };
      const run = node(["node_modules/next/dist/bin/next", "build"], 1_200_000); return { ok: run.code === 0, summary: run.code === 0 ? "built" : "the build failed" };
    }
    return { ok: false, summary: `unknown step ${step}` };
  };
}

/** The paths ESLint looks at: the release tooling, and every script or source file changed since main's base. */
export function lintPaths(root, git, manifest) {
  const changed = git.changedFiles(manifest.expectedMainBase, "HEAD").filter((file) => /\.(m?js|tsx?)$/.test(file) && existsSync(join(root, file)) && !file.startsWith("scripts/release/"));
  return ["scripts/release", ...changed];
}

/** Tooling self-test, tests, TypeScript, ESLint and build. Fills TOOLING, TESTS, TYPESCRIPT, LINT and BUILD. */
export async function localChecks({ root, git, supabase, environment, home, report, manifest, commands, runLocal }) {
  const tooling = await toolingSelfTest({ root, supabase, environment, home, commands });
  const toolingOk = tooling.every((item) => item.ok);
  report.set("TOOLING", toolingOk ? "PASS" : "FAIL", tooling.filter((item) => !item.ok).map(line).concat(toolingOk ? [`${tooling.length} guardrail(s), no request sent`] : []));
  let ok = toolingOk;
  for (const [step, section] of [["tests", "TESTS"], ["typescript", "TYPESCRIPT"], ["lint", "LINT"], ["build", "BUILD"]]) {
    const outcome = runLocal(step, { files: step === "lint" ? lintPaths(root, git, manifest) : [] });
    ok &&= outcome.ok; report.set(section, outcome.ok ? "PASS" : "FAIL", [outcome.summary]);
  }
  return ok;
}

/** `bellis:check`. Returns { ok, ... } and leaves the report filled. Nothing here reaches Supabase. */
export async function runCheck(context) {
  const found = staticChecks(context);
  if (!found.ok) { for (const section of ["TOOLING", "TESTS", "TYPESCRIPT", "LINT", "BUILD"]) context.report.set(section, "N/A", ["not run: an earlier check failed"]); return { ...found, ok: false }; }
  const local = await localChecks({ ...context, manifest: found.manifest });
  if (!local) throw new CheckFailed("A local check failed.", { stage: "check" });
  return { ...found, ok: true };
}
