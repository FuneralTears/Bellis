/**
 * Release tooling: `bellis:deploy-check`. Verifies what a deployment serves, and keeps the result in the release's
 * folder (deploy-state.json): DEPLOY_PREVIEW_VERIFIED, DEPLOY_PROD_PARTIAL_VERIFIED or DEPLOY_PROD_VERIFIED, with the
 * exact URL, the alias, the expected and observed commit, the environment, the project, the deployment id, the time
 * and how it was verified (automatic, or human).
 *
 * A deployment behind Vercel's login is a question for a person. They look at it in their browser and record it with
 * --confirm-human <release-id>: the record says a person confirmed it, never that the tool verified it.
 *   Preview      a protected Preview is confirmed by a person.
 *   Production   the alias is public and always read by the tool. When the exact URL is protected and the alias
 *                serves the release, the result is DEPLOY_PROD_PARTIAL_VERIFIED; a person then confirms the exact
 *                URL, which is accepted only after prod-release moved main (MAIN_ADVANCED), for the release's commit,
 *                and with the alias read again and still right.
 * When the release is at MAIN_ADVANCED (prod-release stopped at the deployment), a production deployment verified
 * here (automatically, or confirmed by a person) moves it on: DEPLOY_PROD_VERIFIED, the public QA without a login, and
 * RELEASE_COMPLETE. Nothing is written anywhere else: no database, no git.
 */
import { short } from "../lib/git.mjs";
import { loadReleaseManifest } from "../lib/manifest.mjs";
import { CheckFailed, HumanActionRequired, PreconditionError } from "../lib/report.mjs";
import { cleanOrigin, discoverDeployment, expectedRefFor, productionAlias, techQa, verifyDeployment } from "../deploy/verify.mjs";
import { openReleaseState } from "./release-state.mjs";

const environmentsAccepted = ["production", "preview", "development"];
export const deployStateName = "deploy-state";
const stateNameFor = (environment) => (environment === "production" ? "DEPLOY_PROD_VERIFIED" : environment === "preview" ? "DEPLOY_PREVIEW_VERIFIED" : null);

/** What the deployment is expected to serve, from the options and, with a release, from its state. */
function expectations({ root, git, release, state, options, now }) {
  const environment = options.expectedEnv;
  if (!environmentsAccepted.includes(environment)) throw new PreconditionError("--expected-env is production, preview or development.");
  let commit = null; let progress = null; let manifest = null;
  if (release) {
    let hash; ({ manifest, hash } = loadReleaseManifest(root, release));
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
  return { expected: { commit, environment, supabaseRef }, progress, manifest };
}

export async function runDeployCheck({ root, git, release, report, state, options, fetchImpl = fetch, now = () => new Date(), timeoutMs }) {
  const { expected, progress, manifest } = expectations({ root, git, release, state, options, now });
  const show = (value) => value ?? "not observed";
  report.set("COMMIT", "INFO", [`expected ${expected.commit}`]); report.set("ENVIRONMENT", "INFO", [`expected ${expected.environment}`]); report.set("SUPABASE REF", "INFO", [`expected ${expected.supabaseRef}`]);
  const records = () => (release ? state.load(release, deployStateName)?.data ?? {} : {});
  const save = (record) => { if (!release) return; state.save(release, deployStateName, { ...records(), [expected.environment]: record }); report.set("STATE", record.state, [`release ${release}; ${record.mode} verification recorded`]); };
  const alias = expected.environment === "production" ? cleanOrigin(options.alias ?? productionAlias) : null;
  const aliasLines = (seen) => (seen.alias ? [seen.alias.url ?? "not an address", `commit ${show(seen.alias.observed?.commit)}`, `project ${show(seen.alias.observed?.supabaseRef)}`, `deployment ${show(seen.alias.observed?.deploymentId)}`, ...seen.alias.problems] : ["only production has an alias to check"]);
  /**
   * A release stopped by prod-release at its deployment (MAIN_ADVANCED) goes on once production is verified: the
   * deployment is recorded, the public pages are checked without a login, and the release is complete.
   */
  const closeRelease = async (detail) => {
    if (!progress || progress.state !== "MAIN_ADVANCED") return;
    const head = expected.commit;
    progress.advance("DEPLOY_PROD_VERIFIED", { commit: head, environment: "vercel", detail });
    const qa = await techQa(alias, { fetchImpl, timeoutMs });
    if (!qa.ok) { report.set("TECH QA", "FAIL", qa.results.filter((item) => !item.ok).map((item) => `${item.path}: ${item.status}`)); progress.note("tech qa", { commit: head, environment: "production", result: "FAIL", detail: "a public page did not answer as it should" }); throw new CheckFailed("A page of production does not answer as it should.", { stage: "tech qa" }); }
    report.set("TECH QA", manifest.previewRequired ? "HUMAN QA REQUIRED" : "PASS", [`${qa.results.length} page(s) answered without a login, nothing secret in them`, ...(manifest.previewRequired ? ["the release changes screens behind a login: a person has to look at them in production"] : [])]);
    progress.advance("RELEASE_COMPLETE", { commit: head, environment: "production", detail: `released ${short(head)} to production; ${detail}` });
    report.set("STATE", progress.state, [`release ${release}`]);
  };

  // The person's confirmation: recorded as theirs, never as the tool's.
  if (options.confirmHuman !== undefined) {
    if (!release) throw new PreconditionError("--confirm-human needs --release <id>.");
    if (options.confirmHuman !== release) throw new PreconditionError(`To confirm, type the release id again: --confirm-human ${release}`);
    const url = cleanOrigin(options.url); if (!url) throw new PreconditionError("--confirm-human needs the exact deployment URL: --url <https://...>.");
    report.set("DEPLOYMENT", "INFO", [url]);
    if (expected.environment === "preview") {
      report.set("VERIFICATION MODE", "HUMAN CONFIRMED", ["a person confirmed this deployment in their browser; this tool did not verify it"]);
      report.set("PREVIEW PROTECTION", "INFO", ["confirmed by a person"]);
      for (const section of ["HTTP", "ALIAS"]) report.set(section, "N/A", ["not checked by this tool"]);
      save({ state: "DEPLOY_PREVIEW_VERIFIED", mode: "human", actor: "human-confirmed", url, alias: null, expectedCommit: expected.commit, observedCommit: null, environment: expected.environment, supabaseRef: expected.supabaseRef, at: now().toISOString() });
      return { status: "PASS" };
    }
    if (expected.environment !== "production") throw new PreconditionError("Only a Preview or a production deployment is confirmed by a person.");
    // Production: only after main moved, for this commit, and only what the tool could not read.
    if (progress.state !== "MAIN_ADVANCED") throw new PreconditionError(progress.reached("DEPLOY_PROD_VERIFIED") ? `Release ${release} already has its production deployment verified (${progress.state}).` : `A production deployment is confirmed only after prod-release moved main (the release is at ${progress.state}).`);
    const partial = records().production;
    if (partial?.state !== "DEPLOY_PROD_PARTIAL_VERIFIED" || partial.expectedCommit !== expected.commit || partial.url !== url) throw new PreconditionError("The production alias has not been verified automatically for this deployment and commit. Run bellis:deploy-check --expected-env production first.");
    const seen = await verifyDeployment({ url, alias, expected, fetchImpl, timeoutMs });
    report.set("ALIAS", seen.alias?.ok ? "PASS" : "FAIL", aliasLines(seen));
    if (!["PARTIAL", "PASS"].includes(seen.status)) { report.set("HTTP", "FAIL", seen.problems.slice(0, 10)); throw new CheckFailed("The production alias no longer serves the release.", { stage: "deploy check", details: seen.problems.slice(0, 10) }); }
    report.set("HTTP", "PASS", [seen.protected ? "/api/version of the exact URL: behind Vercel's login, confirmed by a person" : "/api/version of the exact URL: answered", `the alias answered: HTTP ${seen.alias.status}`]);
    for (const [name, label] of [["commit", "COMMIT"], ["environment", "ENVIRONMENT"], ["supabaseRef", "SUPABASE REF"]]) report.set(label, "PASS", [`expected ${expected[name]}`, `confirmed by a person on the exact URL; the alias serves ${seen.alias.observed[name]}`]);
    report.set("PREVIEW PROTECTION", "INFO", [seen.protected ? "the exact URL is behind Vercel's login: confirmed by a person" : "the exact URL answered without a login"]);
    report.set("VERIFICATION MODE", "HUMAN CONFIRMED", ["the exact deployment was confirmed by a person in their browser; the alias was read by this tool"]);
    save({ state: "DEPLOY_PROD_VERIFIED", mode: "human", actor: "human-confirmed", url, alias, expectedCommit: expected.commit, observedCommit: expected.commit, environment: "production", supabaseRef: expected.supabaseRef,
      deploymentId: seen.alias.observed.deploymentId, at: now().toISOString(), aliasVerification: { mode: "automatic", commit: seen.alias.observed.commit, environment: seen.alias.observed.environment, supabaseRef: seen.alias.observed.supabaseRef, deploymentId: seen.alias.observed.deploymentId } });
    await closeRelease(`exact deployment confirmed by a person; alias read by the tool (deployment ${seen.alias.observed.deploymentId ?? "unknown"})`);
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
  const seen = await verifyDeployment({ url, alias, expected, fetchImpl, timeoutMs });
  const confirmCommand = `npm run bellis:deploy-check -- --release ${release ?? "<id>"} --expected-env ${expected.environment} --url ${url} --confirm-human ${release ?? "<id>"}`;

  if (seen.status === "HUMAN") {
    report.set("HTTP", "HUMAN", [`/api/version: HTTP ${seen.exact?.status ?? "?"}, behind Vercel's login`]);
    report.set("PREVIEW PROTECTION", "HUMAN_ACTION_REQUIRED", ["open the deployment in a browser, check its commit, environment and project at /api/version, then run:", confirmCommand]);
    report.set("VERIFICATION MODE", "N/A", ["not verified"]); report.set("ALIAS", "N/A", []);
    throw new HumanActionRequired("The deployment is behind Vercel's login. A person has to look at it.", { stage: "preview protection" });
  }
  if (seen.status === "PARTIAL") {
    // The alias is verified; the exact URL is not, and is not said to be.
    const aliasSeen = seen.alias.observed;
    report.set("HTTP", "HUMAN", [`/api/version of the exact URL: HTTP ${seen.exact?.status ?? "?"}, behind Vercel's login`, `the alias answered: HTTP ${seen.alias.status}`, ...seen.pages.map((page) => `alias ${page.path}: ${page.status ?? "no answer"}`)]);
    for (const [name, label] of [["commit", "COMMIT"], ["environment", "ENVIRONMENT"], ["supabaseRef", "SUPABASE REF"]]) report.set(label, "PASS", [`expected ${expected[name]}`, `observed through the alias ${aliasSeen[name]}`, "the exact URL is not read: behind Vercel's login"]);
    report.set("ALIAS", "PASS", aliasLines(seen));
    report.set("PREVIEW PROTECTION", "HUMAN_ACTION_REQUIRED", [`open ${url}/api/version in a browser, check commit ${expected.commit}, environment ${expected.environment} and project ${expected.supabaseRef}, then run:`, confirmCommand]);
    report.set("VERIFICATION MODE", "AUTOMATIC", ["alias read by this tool; the exact deployment is waiting for a person"]);
    if (release) save({ state: "DEPLOY_PROD_PARTIAL_VERIFIED", mode: "automatic", scope: "alias", actor: "bellis:deploy-check", url, alias, expectedCommit: expected.commit, observedCommit: aliasSeen.commit, environment: aliasSeen.environment, supabaseRef: aliasSeen.supabaseRef, deploymentId: aliasSeen.deploymentId, at: now().toISOString() });
    throw new HumanActionRequired("The production alias serves the release; the exact deployment is behind Vercel's login and needs a person.", { stage: "deploy check" });
  }
  const observed = seen.exact.observed;
  report.set("HTTP", seen.exact.http === "PASS" && seen.pages.every((page) => page.ok) ? "PASS" : "FAIL", [`/api/version: ${seen.exact.status ?? "no answer"}`, ...seen.pages.map((page) => `${page.path}: ${page.status ?? "no answer"}${page.ok ? "" : ` (${page.problems.join(", ")})`}`)]);
  const field = (name, label) => report.set(label, observed && observed[name] === expected[name] ? "PASS" : "FAIL", [`expected ${expected[name]}`, `observed ${show(observed?.[name])}`]);
  field("commit", "COMMIT"); field("environment", "ENVIRONMENT"); field("supabaseRef", "SUPABASE REF");
  report.set("ALIAS", !seen.alias ? "N/A" : seen.alias.ok ? "PASS" : "FAIL", aliasLines(seen));
  report.set("PREVIEW PROTECTION", seen.protected ? "HUMAN_ACTION_REQUIRED" : "NONE", [seen.protected ? "the exact URL is behind Vercel's login" : "/api/version answered without a login"]);
  if (seen.status !== "PASS") { report.set("VERIFICATION MODE", "AUTOMATIC", seen.problems.slice(0, 10)); throw new CheckFailed("The deployment does not serve what was expected.", { stage: "deploy check", details: seen.problems.slice(0, 10) }); }
  report.set("VERIFICATION MODE", "AUTOMATIC", ["read from /api/version, no credentials used"]);
  const name = stateNameFor(expected.environment);
  if (name) save({ state: name, mode: "automatic", actor: "bellis:deploy-check", url, alias, expectedCommit: expected.commit, observedCommit: observed.commit, environment: observed.environment, supabaseRef: observed.supabaseRef, deploymentId: observed.deploymentId, at: now().toISOString() });
  else report.set("STATE", progress?.state ?? "N/A", [release ? `release ${release}; a development server is not recorded` : "no release given; nothing recorded"]);
  if (expected.environment === "production") await closeRelease("exact deployment and alias read by this tool");
  return { status: "PASS" };
}
