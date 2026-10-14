/**
 * Which Supabase project a deployment may hand to the browser. Only the deployment of `main` may use production.
 * The build already refuses the wrong one (scripts/assert-staging-env.mjs --build); this is the same rule where
 * the address is served, for a deployment whose settings changed after it was built. Only the project ref in the
 * address is looked at: no key is read here.
 *
 * The same rules say what a deployment reports about itself at /api/version: which commit, which environment and
 * which project, and whether those three agree.
 */

/** Same refs as `projects` in scripts/assert-staging-env.mjs; a test keeps them equal. */
export const productionProjectRef = "pinfdbvfzoratsntjgah";
export const stagingProjectRef = "hbvmcvemrkfovzhlpgys";

type Environment = Record<string, string | undefined>;

/** The project ref of a Supabase address (https://<ref>.supabase.co), or null when it is not one. */
export function projectRefFromUrl(url: string | undefined): string | null {
  return /^https:\/\/([a-z0-9]{20})\.supabase\.(co|in)\/?$/.exec(String(url ?? "").trim())?.[1] ?? null;
}

/**
 * True when this is a Vercel deployment of a branch other than `main` and the address is the production project.
 * Outside Vercel nothing is refused here: local work is checked before `next dev` and before `next build`.
 */
export function refusesProductionProject(url: string | undefined, environment: Environment): boolean {
  if (!environment.VERCEL) return false;
  return projectRefFromUrl(url) === productionProjectRef && environment.VERCEL_GIT_COMMIT_REF !== "main";
}

export type DeploymentEnvironment = "production" | "preview" | "development" | "unknown";
/**
 * The environment of this deployment, from what Vercel says it is (VERCEL_ENV), never from a host name. Outside
 * Vercel it is development. On Vercel without a known VERCEL_ENV it is unknown, and nothing trusts it.
 */
export function deploymentEnvironment(environment: Environment): DeploymentEnvironment {
  if (!environment.VERCEL) return "development";
  const value = environment.VERCEL_ENV;
  return value === "production" || value === "preview" || value === "development" ? value : "unknown";
}

/**
 * Why this deployment's project does not fit its environment, or null when it does: no project at all, the
 * production project outside `main`, a production deployment on another project, a preview on production.
 */
export function deploymentTargetProblem(url: string | undefined, environment: Environment): string | null {
  const ref = projectRefFromUrl(url); const kind = deploymentEnvironment(environment);
  if (!ref) return "no_supabase_project";
  if (refusesProductionProject(url, environment)) return "production_project_outside_main";
  if (kind === "production" && ref !== productionProjectRef) return "production_without_production_project";
  if (kind === "preview" && ref === productionProjectRef) return "preview_with_production_project";
  return null;
}

export type VersionPayload = { service: "bellis"; commit: string; environment: DeploymentEnvironment; supabaseRef: string; branch: string | null; deploymentId: string | null; consistent: boolean; problem: string | null };
/**
 * What /api/version answers: technical facts and nothing else. The commit comes from Vercel's build metadata
 * (VERCEL_GIT_COMMIT_SHA); outside Vercel, from `localCommit` (the route reads it from git). Anything that is not
 * a full SHA is UNKNOWN, and an UNKNOWN commit or environment makes the payload inconsistent. No key, no address
 * and no other setting is ever part of it.
 */
export function versionPayload(environment: Environment, { localCommit }: { localCommit?: string } = {}): VersionPayload {
  const kind = deploymentEnvironment(environment);
  const source = String((environment.VERCEL ? environment.VERCEL_GIT_COMMIT_SHA : localCommit) ?? "").trim().toLowerCase();
  const commit = /^[0-9a-f]{40}$/.test(source) ? source : "UNKNOWN";
  const branchValue = environment.VERCEL ? environment.VERCEL_GIT_COMMIT_REF : undefined;
  const branch = branchValue && /^[A-Za-z0-9._/-]{1,100}$/.test(branchValue) ? branchValue : null;
  const deploymentId = environment.VERCEL_DEPLOYMENT_ID && /^dpl_[A-Za-z0-9]{6,64}$/.test(environment.VERCEL_DEPLOYMENT_ID) ? environment.VERCEL_DEPLOYMENT_ID : null;
  const problem = deploymentTargetProblem(environment.SUPABASE_URL, environment) ?? (commit === "UNKNOWN" ? "unknown_commit" : kind === "unknown" ? "unknown_environment" : null);
  return { service: "bellis", commit, environment: kind, supabaseRef: projectRefFromUrl(environment.SUPABASE_URL) ?? "UNKNOWN", branch, deploymentId, consistent: problem === null, problem };
}
