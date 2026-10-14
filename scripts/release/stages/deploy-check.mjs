/**
 * Release tooling: `bellis:deploy-check`. Verifies what a deployment serves, and keeps the result in the release's
 * folder (deploy-state.json): DEPLOY_PREVIEW_VERIFIED or DEPLOY_PROD_VERIFIED, with the exact URL, the alias, the
 * expected and observed commit, the environment, the project, the time and how it was verified (automatic or human).
 * These are records next to the release's state, not steps of it: nothing requires them yet.
 *
 * A deployment behind Vercel's login is a question for a person. They look at it in their browser and record it with
 * --confirm-human <release-id>: the record says a person confirmed it, never that the tool verified it.
 */
import { short } from "../lib/git.mjs";
import { loadReleaseManifest } from "../lib/manifest.mjs";
import { CheckFailed, HumanActionRequired, PreconditionError } from "../lib/report.mjs";
import { cleanOrigin, discoverDeployment, expectedRefFor, productionAlias, verifyDeployment } from "../deploy/verify.mjs";
import { openReleaseState } from "./release-state.mjs";

const environmentsAccepted = ["production", "preview", "development"];
export const deployStateName = "deploy-state";
const stateNameFor = (environment) => (environment === "production" ? "DEPLOY_PROD_VERIFIED" : environment === "preview" ? "DEPLOY_PREVIEW_VERIFIED" : null);

/** What the deployment is expected to serve, from the options and, with a release, from its state. */
function expectations({ root, git, release, state, options, now }) {
  const environment = options.expectedEnv;
  if (!environmentsAccepted.includes(environment)) throw new PreconditionError("--expected-env is production, preview or development.");
  let commit = null; let progress = null;
  if (release) {
    const { manifest, hash } = loadReleaseManifest(root, release);
    progress = openReleaseState(state, release, { manifest, manifestHash: hash, now });
    if (!progress.reached("STAGING_COMPLETE")) throw new HumanActionRequired(`Release ${release} has not completed staging (it is at ${progress.state ?? "nothing"}).`, { stage: "release state" });
    commit = [...progress.history].reverse().find((entry) => entry.state === "STAGING_VERIFIED" && entry.result === "PASS")?.commit ?? null;
  }
  if (options.expectedCommit) {
    const resolved = git.commit(options.expectedCommit);
    if (!resolved) throw new PreconditionError("--expected-commit is not a commit of this repository.");
    if (commit && resolved !== commit) throw new PreconditionError(`--expected-commit ${short(resolved)} is not the commit verified on staging for ${release} (${short(commit)}).`);
    commit = resolved;
  }
  if (!commit) throw new PreconditionError("Say which commit is expected: --expected-commit <sha>, or --release <id>.");
  const supabaseRef = options.expectedRef ?? expectedRefFor(environment);
  if (!/^[a-z0-9]{20}$/.test(supabaseRef)) throw new PreconditionError("--expected-ref is a Supabase project ref.");
  return { expected: { commit, environment, supabaseRef }, progress };
}

export async function runDeployCheck({ root, git, release, report, state, options, fetchImpl = fetch, now = () => new Date(), timeoutMs }) {
  const { expected, progress } = expectations({ root, git, release, state, options, now });
  const show = (value) => value ?? "not observed";
  report.set("COMMIT", "INFO", [`expected ${expected.commit}`]); report.set("ENVIRONMENT", "INFO", [`expected ${expected.environment}`]); report.set("SUPABASE REF", "INFO", [`expected ${expected.supabaseRef}`]);
  const save = (record) => { if (!release) return; const saved = state.load(release, deployStateName)?.data ?? {}; state.save(release, deployStateName, { ...saved, [expected.environment]: record }); report.set("STATE", record.state, [`release ${release}; ${record.mode} verification recorded`]); };

  // The person's confirmation: recorded as theirs, and only for a Preview this tool cannot read.
  if (options.confirmHuman !== undefined) {
    if (!release) throw new PreconditionError("--confirm-human needs --release <id>.");
    if (options.confirmHuman !== release) throw new PreconditionError(`To confirm, type the release id again: --confirm-human ${release}`);
    if (expected.environment !== "preview") throw new PreconditionError("Only a Preview is confirmed by a person; production is verified automatically.");
    const url = cleanOrigin(options.url); if (!url) throw new PreconditionError("--confirm-human needs the exact deployment URL: --url <https://...>.");
    report.set("DEPLOYMENT", "INFO", [url]); report.set("VERIFICATION MODE", "HUMAN CONFIRMED", ["a person confirmed this deployment in their browser; this tool did not verify it"]);
    report.set("PREVIEW PROTECTION", "INFO", ["confirmed by a person"]);
    for (const section of ["HTTP", "ALIAS"]) report.set(section, "N/A", ["not checked by this tool"]);
    save({ state: "DEPLOY_PREVIEW_VERIFIED", mode: "human", actor: "human-confirmed", url, alias: null, expectedCommit: expected.commit, observedCommit: null, environment: expected.environment, supabaseRef: expected.supabaseRef, at: now().toISOString() });
    return { status: "PASS" };
  }

  // The exact URL: given, or found through GitHub's public deployments API.
  let url = options.url ? cleanOrigin(options.url) : null;
  if (options.url && !url) throw new PreconditionError("--url is an http(s) address without credentials.");
  if (!url) {
    if (expected.environment === "development") throw new PreconditionError("A development server has no deployment to find: give it with --url.");
    const found = await discoverDeployment({ commit: expected.commit, environment: expected.environment, fetchImpl, timeoutMs });
    if (!found.ok) { report.set("DEPLOYMENT", "HUMAN", [found.reason, "give the exact deployment URL with --url"]); throw new HumanActionRequired("The deployment could not be found without doubt.", { stage: "discover" }); }
    url = found.url;
  }
  report.set("DEPLOYMENT", "INFO", [url, options.url ? "given with --url" : "found through GitHub's deployments of this commit"]);
  const alias = expected.environment === "production" ? cleanOrigin(options.alias ?? productionAlias) : null;
  const seen = await verifyDeployment({ url, alias, expected, fetchImpl, timeoutMs });

  if (seen.status === "HUMAN") {
    report.set("HTTP", "HUMAN", [`/api/version: HTTP ${seen.exact?.status ?? "?"}, behind Vercel's login`]);
    report.set("PREVIEW PROTECTION", "HUMAN_ACTION_REQUIRED", ["open the deployment in a browser, check its commit, environment and project at /api/version, then run:", `npm run bellis:deploy-check -- --release ${release ?? "<id>"} --expected-env ${expected.environment} --url ${url} --confirm-human ${release ?? "<id>"}`]);
    report.set("VERIFICATION MODE", "N/A", ["not verified"]); report.set("ALIAS", "N/A", []);
    throw new HumanActionRequired("The deployment is behind Vercel's login. A person has to look at it.", { stage: "preview protection" });
  }
  const observed = seen.exact.observed;
  report.set("HTTP", seen.exact.http === "PASS" && seen.pages.every((page) => page.ok) ? "PASS" : "FAIL", [`/api/version: ${seen.exact.status ?? "no answer"}`, ...seen.pages.map((page) => `${page.path}: ${page.status ?? "no answer"}${page.ok ? "" : ` (${page.problems.join(", ")})`}`)]);
  const field = (name, label) => report.set(label, observed && observed[name] === expected[name] ? "PASS" : "FAIL", [`expected ${expected[name]}`, `observed ${show(observed?.[name])}`]);
  field("commit", "COMMIT"); field("environment", "ENVIRONMENT"); field("supabaseRef", "SUPABASE REF");
  report.set("ALIAS", !seen.alias ? "N/A" : seen.alias.ok ? "PASS" : "FAIL", seen.alias ? [seen.alias.url ?? "not an address", `commit ${show(seen.alias.observed?.commit)}`, `project ${show(seen.alias.observed?.supabaseRef)}`, ...seen.alias.problems] : ["only production has an alias to check"]);
  report.set("PREVIEW PROTECTION", "NONE", ["/api/version answered without a login"]);
  if (seen.status !== "PASS") { report.set("VERIFICATION MODE", "AUTOMATIC", seen.problems.slice(0, 10)); throw new CheckFailed("The deployment does not serve what was expected.", { stage: "deploy check", details: seen.problems.slice(0, 10) }); }
  report.set("VERIFICATION MODE", "AUTOMATIC", ["read from /api/version, no credentials used"]);
  const name = stateNameFor(expected.environment);
  if (name) save({ state: name, mode: "automatic", actor: "bellis:deploy-check", url, alias, expectedCommit: expected.commit, observedCommit: observed.commit, environment: observed.environment, supabaseRef: observed.supabaseRef, at: now().toISOString() });
  else report.set("STATE", progress?.state ?? "N/A", [release ? `release ${release}; a development server is not recorded` : "no release given; nothing recorded"]);
  return { status: "PASS" };
}
