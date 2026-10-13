/**
 * Which Supabase project a deployment may hand to the browser. Only the deployment of `main` may use production.
 * The build already refuses the wrong one (scripts/assert-staging-env.mjs --build); this is the same rule where
 * the address is served, for a deployment whose settings changed after it was built. Only the project ref in the
 * address is looked at: no key is read here.
 */

/**
 * Whether the browser may print the backoffice gate's debug line (states only, no personal data).
 * Never on the production deployment; on previews and locally, yes.
 */
export function allowsAdminDebug(environment: Record<string, string | undefined>): boolean {
  return environment.VERCEL_ENV !== "production";
}

/** Same ref as `projects.production` in scripts/assert-staging-env.mjs; a test keeps the two equal. */
export const productionProjectRef = "pinfdbvfzoratsntjgah";

/**
 * True when this is a Vercel deployment of a branch other than `main` and the address is the production project.
 * Outside Vercel nothing is refused here: local work is checked before `next dev` and before `next build`.
 */
export function refusesProductionProject(url: string | undefined, environment: Record<string, string | undefined>): boolean {
  if (!environment.VERCEL) return false;
  const host = /^https:\/\/([a-z0-9]{20})\.supabase\.(co|in)\/?$/.exec(String(url ?? "").trim())?.[1];
  return host === productionProjectRef && environment.VERCEL_GIT_COMMIT_REF !== "main";
}
