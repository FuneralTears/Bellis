/**
 * Release tooling: exit codes, errors and the report every command ends with.
 * The exit code is how a caller (a person or an agent) knows whether to go on or stop, so there is one list of
 * them, here, and nothing else in the tooling writes a number.
 */

export const EXIT = Object.freeze({
  /** Everything that was asked was checked and is fine. */
  PASS: 0,
  /** A check ran and failed: a test, a smoke, a drift, a dirty tree. Nothing was written to production. */
  CHECK_FAILED: 1,
  /** The command could not start: bad arguments, a missing tool, a missing manifest, a step not available yet. */
  PRECONDITION_OR_USAGE: 2,
  /** The environment could not be confirmed, or the CLI could not be left on staging. Stop and look. */
  TARGET_NOT_CONFIRMED: 3,
  /** Something only a person can do is missing: a backup, an approval, a login. */
  HUMAN_ACTION_REQUIRED: 4,
  /** Something failed after production was written. The report says how far it got. */
  FAILURE_AFTER_PROD_WRITE: 5,
});
const exitNames = Object.freeze(Object.fromEntries(Object.entries(EXIT).map(([name, code]) => [code, name])));
export function exitName(code) {
  return exitNames[code] ?? "UNKNOWN";
}
/** When two things went wrong, the one that matters most decides the exit code. */
const severity = [EXIT.PASS, EXIT.PRECONDITION_OR_USAGE, EXIT.CHECK_FAILED, EXIT.HUMAN_ACTION_REQUIRED, EXIT.TARGET_NOT_CONFIRMED, EXIT.FAILURE_AFTER_PROD_WRITE];
export function worstExit(...codes) {
  return codes.filter((code) => code in exitNames).sort((a, b) => severity.indexOf(b) - severity.indexOf(a))[0] ?? EXIT.CHECK_FAILED;
}

/** An error that knows which exit code it means and at which stage it happened. */
export class ReleaseError extends Error {
  constructor(message, { exitCode = EXIT.CHECK_FAILED, stage = null, details = [], cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = new.target.name; this.exitCode = exitCode; this.stage = stage; this.details = details;
  }
}
export class CheckFailed extends ReleaseError { constructor(message, options = {}) { super(message, { ...options, exitCode: EXIT.CHECK_FAILED }); } }
export class PreconditionError extends ReleaseError { constructor(message, options = {}) { super(message, { ...options, exitCode: EXIT.PRECONDITION_OR_USAGE }); } }
export class TargetNotConfirmed extends ReleaseError { constructor(message, options = {}) { super(message, { ...options, exitCode: EXIT.TARGET_NOT_CONFIRMED }); } }
export class HumanActionRequired extends ReleaseError { constructor(message, options = {}) { super(message, { ...options, exitCode: EXIT.HUMAN_ACTION_REQUIRED }); } }
export class FailureAfterProdWrite extends ReleaseError { constructor(message, options = {}) { super(message, { ...options, exitCode: EXIT.FAILURE_AFTER_PROD_WRITE }); } }
/** The exit code for anything thrown. An error that is not ours is a failed check, never a pass. */
export function exitCodeFor(error) {
  return error instanceof ReleaseError && error.exitCode in exitNames ? error.exitCode : EXIT.CHECK_FAILED;
}

/**
 * Removes anything that looks like a credential from a piece of text before it is shown or stored: connection
 * strings, JWTs, Supabase keys, bearer tokens and key=value pairs with a telling name. Tool output is never
 * printed raw; what is printed goes through here first, and is cut short.
 */
export function scrub(text) {
  return String(text ?? "")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s'"]+/gi, "[connection string]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[jwt]")
    .replace(/\bsb_(secret|publishable)_[A-Za-z0-9_-]+/g, "[supabase key]")
    .replace(/\b(sbp|sbs|ghp|gho|github_pat)_[A-Za-z0-9_]{12,}/g, "[token]")
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [credential]")
    .replace(/\b([A-Za-z0-9_]*(password|passwd|secret|token|apikey|api_key|service_role|authorization|cookie)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1$3[redacted]");
}
/** The same, on one line and cut short: what goes into a report. `scrub` keeps the text's lines and its length. */
export function redact(text, max = 300) {
  const oneLine = scrub(text).replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** The sections of every report, in the order they are printed. A stage that has nothing to say leaves "N/A". */
export const reportSections = Object.freeze(["TARGET", "GIT", "MIGRATIONS", "DRIFT", "SNAPSHOT", "SMOKES", "DEPLOY", "CLI FINAL TARGET"]);
/** The orchestrated commands (check, staging) print these sections instead. */
export const releaseSections = Object.freeze(["RELEASE", "GIT", "MIGRATIONS", "REHEARSAL", "DRY RUN", "STAGING APPLY", "EXPECTED DRIFT", "SMOKES", "SNAPSHOT", "RESIDUE", "PREVIEW", "CLI FINAL TARGET", "STATE"]);
export const checkSections = Object.freeze(["RELEASE", "GIT", "MIGRATIONS", "SMOKES", "TOOLING", "TESTS", "TYPESCRIPT", "LINT", "BUILD", "STATE"]);
export const backupSections = Object.freeze(["RELEASE", "BACKUP PUBLIC", "BACKUP PRIVATE", "STATE"]);
export const precheckSections = Object.freeze(["RELEASE", "STAGING STATE", "BACKUP PUBLIC", "BACKUP PRIVATE", "PROD TARGET", "PROD MIGRATIONS", "PROD DRIFT", "PROD SNAPSHOT", "PROD DRY RUN", "DATA INTEGRITY", "PRECHECK EXPIRY", "CLI FINAL TARGET", "STATE", "SAFE TO APPLY PROD?"]);
export const deploySections = Object.freeze(["DEPLOYMENT", "HTTP", "COMMIT", "ENVIRONMENT", "SUPABASE REF", "ALIAS", "PREVIEW PROTECTION", "VERIFICATION MODE", "STATE"]);
/** Records kept next to a release's state when a deployment is verified. They are not steps of the release. */
export const deployStates = Object.freeze(["DEPLOY_PREVIEW_VERIFIED", "DEPLOY_PROD_VERIFIED"]);
export const releaseStates = Object.freeze(["CHECKED", "REHEARSED", "STAGING_APPLIED", "STAGING_VERIFIED", "PREVIEW_PENDING", "STAGING_COMPLETE", "PROD_PRECHECK_COMPLETE",
  "PROD_APPLIED", "PROD_VERIFIED", "MAIN_ADVANCED", "DEPLOY_PROD_VERIFIED", "RELEASE_COMPLETE"]);
export const prodReleaseSections = Object.freeze(["RELEASE", "HUMAN APPROVAL", "PRECHECK", "PROD TARGET", "PROD MIGRATIONS", "PROD APPLY", "PROD SCHEMA", "PROD SMOKES", "PROD SNAPSHOT", "MAIN", "DEPLOYMENT", "PROD VERSION", "PROD ALIAS", "TECH QA", "CLI FINAL TARGET", "STATE"]);
/**
 * What each status word means for the exit code: "ok" does not stop anything, "fail" is a failed check, "human" is
 * waiting for a person. A section can only be given one of these words.
 */
const statuses = Object.freeze({ PASS: "ok", INFO: "ok", "N/A": "ok", "NOT NEEDED": "ok", IDENTICAL: "ok", NONE: "ok", STAGING: "ok",
  MATCH: "ok", YES: "ok", NO: "ok", VALID: "ok", READY: "ok", EXPIRED: "human", "HUMAN QA REQUIRED": "human", AUTOMATIC: "ok", "HUMAN CONFIRMED": "ok", HUMAN_ACTION_REQUIRED: "human", ...Object.fromEntries(deployStates.map((name) => [name, "ok"])),
  FAIL: "fail", DIFFERENT: "fail", FOUND: "fail", OTHER: "fail", DRIFT: "fail", HUMAN: "human", "HUMAN VERIFICATION REQUIRED": "human", REQUIRED: "human", ...Object.fromEntries(releaseStates.map((name) => [name, "ok"])) });

export function createReport(command, { now = () => new Date(), sections: names = reportSections } = {}) {
  const sections = new Map(names.map((name) => [name, { status: "N/A", lines: [] }]));
  const startedAt = now();
  let failure = null;
  const report = {
    command,
    /** Sets a section. `lines` are short facts; each one is redacted before it is kept. */
    set(section, status, lines = []) {
      if (!sections.has(section)) throw new PreconditionError(`Unknown report section: ${section}`);
      if (!Object.hasOwn(statuses, status)) throw new PreconditionError(`Unknown report status: ${status}`);
      sections.set(section, { status, lines: [].concat(lines).filter((line) => line !== null && line !== undefined && line !== "").map((line) => redact(line, 400)) });
      return report;
    },
    get(section) { return sections.get(section); },
    /** Records what stopped the command. The first failure is the one reported. */
    fail(error, stage = null) {
      if (!failure) failure = { message: redact(error?.message ?? String(error), 400), exitCode: exitCodeFor(error), stage: stage ?? error?.stage ?? null,
        details: (error?.details ?? []).map((line) => redact(line, 400)) };
      return report;
    },
    get failure() { return failure; },
    /** FAIL if anything failed or was thrown; PASS otherwise. A section waiting for a person is not a pass. */
    exitCode() {
      if (failure) return failure.exitCode;
      const kinds = [...sections.values()].map((item) => statuses[item.status]);
      if (kinds.includes("fail")) return EXIT.CHECK_FAILED;
      if (kinds.includes("human")) return EXIT.HUMAN_ACTION_REQUIRED;
      return EXIT.PASS;
    },
    /** PASS, HUMAN ACTION REQUIRED (waiting for a person, nothing failed) or FAIL. */
    result() { const code = report.exitCode(); return code === EXIT.PASS ? "PASS" : code === EXIT.HUMAN_ACTION_REQUIRED ? "HUMAN ACTION REQUIRED" : "FAIL"; },
    toJSON() {
      const code = report.exitCode();
      return { command, startedAt: startedAt.toISOString(), finishedAt: now().toISOString(), result: report.result(), exitCode: code, exit: exitName(code),
        sections: Object.fromEntries([...sections].map(([name, value]) => [name, value])), failure };
    },
    render() {
      const code = report.exitCode(); const out = [];
      for (const [name, value] of sections) { out.push(`## ${name}`, value.status, ...value.lines.map((line) => `- ${line}`), ""); }
      out.push("## RESULT", report.result(), `- exit ${code} (${exitName(code)})`);
      if (failure) { out.push(`- ${failure.stage ? `failed at ${failure.stage}: ` : ""}${failure.message}`, ...failure.details.map((line) => `- ${line}`)); }
      return out.join("\n") + "\n";
    },
  };
  return report;
}
