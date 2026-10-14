/**
 * Release tooling: which Supabase project a command is about to touch.
 * The CLI is linked to one project at a time and every `db push` goes wherever it points, so the name of a command
 * proves nothing. Before anything runs against a project, the link is set and then read back two ways: from the
 * CLI's own file and from the account's list of projects. Whatever happens afterwards, the CLI is put back on
 * staging and that is checked too. If any of it cannot be confirmed, nothing runs.
 */
import { projects as refs } from "../../assert-staging-env.mjs";
import { EXIT, PreconditionError, ReleaseError, TargetNotConfirmed, worstExit } from "./report.mjs";

/** The two environments. The refs come from scripts/assert-staging-env.mjs: there is one list of them. */
export const environments = Object.freeze({
  staging: Object.freeze({ key: "staging", ref: refs.staging, label: "STAGING" }),
  production: Object.freeze({ key: "production", ref: refs.production, label: "PROD" }),
});
/** "staging", "production" or null for a ref that is neither. */
/** Only the two names above: a key inherited from Object (like "__proto__") is not an environment. */
const known = (envKey) => typeof envKey === "string" && Object.hasOwn(environments, envKey);
export function environmentOf(ref) {
  return Object.values(environments).find((item) => item.ref === ref)?.key ?? null;
}

/**
 * Whether the CLI is linked to `envKey`, as far as can be told. Every doubt is a problem: an override in the
 * environment, a file that says something else, a list that cannot be read, no project or two projects marked as
 * linked, or the expected project missing from the list.
 */
export function inspectTarget(supabase, envKey, { environment = process.env } = {}) {
  const expected = known(envKey) ? environments[envKey] : null;
  if (!expected) throw new PreconditionError(`Unknown environment: ${envKey}. Use staging or production.`);
  const problems = [];
  // The CLI prefers this variable over its link: with it set, the link says nothing about where a command goes.
  const override = (environment.SUPABASE_PROJECT_ID ?? "").trim();
  if (override && override !== expected.ref) problems.push("SUPABASE_PROJECT_ID is set to a different project");
  const file = supabase.linkedRef();
  if (file !== expected.ref) problems.push(file ? `the CLI is linked to ${environmentOf(file) ?? "an unknown project"}, not ${envKey}` : "the CLI is not linked to any project");
  const listed = supabase.projects();
  if (!listed.ok) problems.push(`the list of projects could not be read (${listed.reason})`);
  else {
    const linked = listed.projects.filter((item) => item.linked);
    if (listed.projects.filter((item) => item.ref === expected.ref).length !== 1) problems.push(`the ${envKey} project is not in the list exactly once`);
    if (linked.length !== 1) problems.push(linked.length ? "more than one project is marked as linked" : "no project is marked as linked");
    else if (linked[0].ref !== expected.ref) problems.push(`the list marks ${environmentOf(linked[0].ref) ?? "an unknown project"} as linked, not ${envKey}`);
  }
  return { ok: problems.length === 0, env: envKey, ref: expected.ref, problems };
}
/** Throws unless the CLI is confirmed on `envKey`. */
export function confirmTarget(supabase, envKey, options = {}) {
  const seen = inspectTarget(supabase, envKey, options);
  if (!seen.ok) throw new TargetNotConfirmed(`The CLI could not be confirmed on ${envKey}.`, { stage: `confirm ${envKey}`, details: seen.problems });
  return seen;
}

/** Links to `envKey` and confirms it. Throws without running anything else when either step fails. */
function linkAndConfirm(supabase, envKey, options) {
  const linked = supabase.link(environments[envKey].ref);
  if (!linked.ok) throw new TargetNotConfirmed(`The CLI could not be linked to ${envKey}.`, { stage: `link ${envKey}`, details: [linked.reason] });
  return confirmTarget(supabase, envKey, options);
}
/**
 * Leaves the CLI on staging and says whether that could be confirmed. Never throws: it runs when things are
 * already going wrong. If staging is already confirmed nothing is changed; otherwise it links and checks again.
 */
export function returnToStaging(supabase, options = {}) {
  try {
    if (inspectTarget(supabase, "staging", options).ok) return { ok: true, problems: [] };
    const linked = supabase.link(environments.staging.ref);
    if (!linked.ok) return { ok: false, problems: [`the CLI could not be linked back to staging (${linked.reason})`] };
    const seen = inspectTarget(supabase, "staging", options);
    return { ok: seen.ok, problems: seen.problems };
  } catch (error) { return { ok: false, problems: [`returning to staging failed (${error?.message ?? error})`] }; }
}

/** Environments a command may write to in this version of the tooling. Production is not one of them. */
export const writableEnvironments = Object.freeze(["staging"]);
/**
 * Called right before anything that writes (applying migrations): throws, before the write, unless the write is
 * meant for an environment that may be written to and the CLI is there right now. Cheap: reads the CLI's own file.
 */
export function assertWritable(supabase, target, { environment = process.env, operation = "a write" } = {}) {
  if (!writableEnvironments.includes(target)) throw new ReleaseError(`Refused: ${operation} on ${target}. This tooling does not write to ${target}.`, { exitCode: EXIT.TARGET_NOT_CONFIRMED, stage: "write guard" });
  const ref = environments[target].ref; const override = (environment.SUPABASE_PROJECT_ID ?? "").trim();
  if (supabase.linkedRef() !== ref || (override && override !== ref)) throw new TargetNotConfirmed(`Refused: ${operation}. The CLI is not on ${target} right now.`, { stage: "write guard" });
}

/** The CLI could not be left on staging. Carries what happened before, if anything did. */
export class CleanupFailed extends ReleaseError {
  constructor(problems, { original = null, result } = {}) {
    super("The CLI could not be left on staging. Check it before running anything else.", {
      exitCode: worstExit(EXIT.TARGET_NOT_CONFIRMED, original instanceof ReleaseError ? original.exitCode : original ? EXIT.CHECK_FAILED : EXIT.PASS),
      stage: "return to staging", details: [...problems, ...(original ? [`before that: ${original.message}`] : [])], cause: original ?? undefined });
    this.original = original; this.result = result; this.finalTarget = "unconfirmed";
  }
}

/**
 * Runs `fn` with the CLI on `envKey`, and puts it back on staging afterwards whatever happens:
 *   1. link to envKey      2. read the ref back      3. check the list of projects
 *   4. run fn              5. link back to staging   6. confirm staging
 * `fn` receives `assertOnTarget()`, to call right before each write: it reads the link again and throws if it moved.
 * Resolves to { result, finalTarget: "staging" }. Rejects with what failed (finalTarget on the error says where the
 * CLI was left), or with CleanupFailed when staging could not be confirmed at the end.
 * While it runs, an interruption (Ctrl+C) also returns the CLI to staging before the process ends.
 */
export async function withTarget(supabase, envKey, fn, { environment = process.env, signals = process, onSignalExit = (code) => process.exit(code), signalExitCode = EXIT.CHECK_FAILED, log = () => {} } = {}) {
  if (!known(envKey)) throw new PreconditionError(`Unknown environment: ${envKey}. Use staging or production.`);
  const options = { environment };
  let cleaned = null;
  const cleanup = () => (cleaned ??= returnToStaging(supabase, options));
  const onSignal = (signal) => {
    const end = cleanup();
    log(`interrupted (${signal}): CLI ${end.ok ? "back on staging" : "NOT confirmed on staging"}`);
    onSignalExit(end.ok ? signalExitCode : worstExit(signalExitCode, EXIT.TARGET_NOT_CONFIRMED));
  };
  const handled = ["SIGINT", "SIGTERM", "SIGBREAK"];
  for (const signal of handled) signals.on(signal, onSignal);
  let failure = null; let result;
  try {
    const confirmed = linkAndConfirm(supabase, envKey, options);
    result = await fn({ env: envKey, ref: confirmed.ref, label: environments[envKey].label,
      /** Call right before a write. Cheap: reads the CLI's own file, no request. */
      assertOnTarget() {
        const override = (environment.SUPABASE_PROJECT_ID ?? "").trim();
        if (supabase.linkedRef() !== confirmed.ref || (override && override !== confirmed.ref)) throw new TargetNotConfirmed(`The CLI is no longer on ${envKey}.`, { stage: `write on ${envKey}` });
      },
      /** The full confirmation again, including the list of projects. */
      confirm: () => confirmTarget(supabase, envKey, options) });
  } catch (error) { failure = error ?? new Error("unknown failure"); }
  finally { for (const signal of handled) signals.off(signal, onSignal); }
  const end = cleanup();
  if (!end.ok) throw new CleanupFailed(end.problems, { original: failure, result });
  if (failure) { try { failure.finalTarget = "staging"; } catch { /* a frozen error still fails the command */ } throw failure; }
  return { result, finalTarget: "staging" };
}
