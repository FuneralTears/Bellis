/**
 * Release tooling: where a release is on its way to staging, kept in its folder (release-state.json) so a release can
 * be picked up again after a closed terminal, a network error after an apply, or a Preview a person has not looked
 * at yet.
 *
 *   CHECKED → REHEARSED → STAGING_APPLIED → STAGING_VERIFIED → PREVIEW_PENDING → STAGING_COMPLETE
 *   → PROD_PRECHECK_COMPLETE → PROD_APPLIED → PROD_VERIFIED → MAIN_ADVANCED → DEPLOY_PROD_VERIFIED → RELEASE_COMPLETE
 * (a release without migrations also skips PROD_APPLIED)
 *
 * A release without migrations skips REHEARSED and STAGING_APPLIED (there is nothing to rehearse or apply), and one
 * that does not need its Preview looked at goes from STAGING_VERIFIED to STAGING_COMPLETE. Nothing else can be
 * skipped. Running a step again that is not ahead of where the release is (a new check, say) is written down in the
 * history and does not move the release back.
 * The state belongs to one version of the manifest and one source commit; another one is refused.
 */
import { CheckFailed, HumanActionRequired, releaseStates } from "../lib/report.mjs";

export const stateName = "release-state";
const rank = (name) => releaseStates.indexOf(name);

/** The states a release has to go through, given its manifest. */
export function requiredStates(manifest) {
  return releaseStates.filter((name) => (manifest.migrations.length || !["REHEARSED", "STAGING_APPLIED", "PROD_APPLIED"].includes(name)) && (manifest.previewRequired || name !== "PREVIEW_PENDING"));
}

/**
 * The state of a release, read from its folder. `begin` binds it to the manifest's hash and source commit; a state
 * written for another version of the manifest is refused rather than trusted.
 */
export function openReleaseState(state, release, { manifest, manifestHash, now = () => new Date() }) {
  const saved = state.load(release, stateName)?.data ?? null;
  if (saved && (saved.manifestHash !== manifestHash || saved.sourceCommit !== manifest.sourceCommit))
    throw new HumanActionRequired(`The saved state of release ${release} belongs to another version of its manifest or another source commit.`, { stage: "release state", details: ["move the release's folder away (or use a new release id) to start again"] });
  let current = saved ?? { releaseId: release, manifestHash, sourceCommit: manifest.sourceCommit, state: null, history: [] };
  const path = requiredStates(manifest);
  const persist = () => state.save(release, stateName, current);
  return {
    get state() { return current.state; },
    get history() { return current.history; },
    /** Whether the release has reached `name` (or gone past it). */
    reached(name) { return current.state !== null && rank(current.state) >= rank(name); },
    /**
     * Moves the release to `to`, or writes down a step run again. Throws when `to` would skip a required state.
     * Each entry: { state, at, commit, environment, result, detail }.
     */
    advance(to, { commit, environment = "local", result = "PASS", detail = null } = {}) {
      if (!path.includes(to)) throw new CheckFailed(`${to} is not a state this release goes through.`, { stage: "release state" });
      const entry = { state: to, at: now().toISOString(), commit: commit ?? null, environment, result, detail };
      if (current.state !== null && rank(to) <= rank(current.state)) { current = { ...current, history: [...current.history, { ...entry, rerun: true }] }; persist(); return current.state; }
      const next = path[current.state === null ? 0 : path.indexOf(current.state) + 1];
      if (to !== next) throw new CheckFailed(`The release cannot go from ${current.state ?? "nothing"} to ${to}: ${next ?? "nothing"} comes first.`, { stage: "release state" });
      current = { ...current, state: to, history: [...current.history, entry] }; persist(); return to;
    },
    /** Writes down something that happened without moving the release (a failure, say). */
    note(stateNameToNote, { commit, environment = "local", result, detail = null } = {}) {
      current = { ...current, history: [...current.history, { state: stateNameToNote, at: now().toISOString(), commit: commit ?? null, environment, result, detail }] }; persist();
    },
  };
}
