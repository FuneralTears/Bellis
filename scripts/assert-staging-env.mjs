#!/usr/bin/env node
/**
 * Stops work on any branch other than `main` from reaching the production Supabase project.
 * Run it before `next dev`, before a migration and before a deploy:
 *
 *   node scripts/assert-staging-env.mjs            checks the local site settings and the linked CLI project
 *   node scripts/assert-staging-env.mjs --dev      only what `next dev` would use
 *   node scripts/assert-staging-env.mjs --build    only what `next build` / `next start` would use
 *   node scripts/assert-staging-env.mjs --cli      only the project `supabase db push` / `functions deploy` would touch
 *
 * It reads the project address from the same files Next.js reads, in the same order, and the project the Supabase
 * CLI is linked to. Only project refs are printed: never a key. Nothing is written and no request is sent.
 * Exit code 0 when safe, 1 when production would be reached from a branch that is not `main`, 2 on a usage error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const projects = { production: "pinfdbvfzoratsntjgah", staging: "hbvmcvemrkfovzhlpgys" };
const names = Object.fromEntries(Object.entries(projects).map(([name, ref]) => [ref, name]));

/** The project ref in a Supabase address, "local" for a local stack, "" when there is none, "unknown" for anything else. */
export function projectRef(url) {
  const value = String(url ?? "").trim();
  if (!value) return "";
  const hosted = /^https:\/\/([a-z0-9]{20})\.supabase\.(co|in)\/?$/.exec(value);
  if (hosted) return hosted[1];
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(value) ? "local" : "unknown";
}

/** KEY=value lines of an env file. Quotes are removed; nothing is expanded. */
export function parseEnv(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

/** The files Next.js loads for a mode, first match wins. The process environment goes before all of them. */
export const envFiles = (mode) => [`.env.${mode}.local`, ".env.local", `.env.${mode}`, ".env"];

/** The value Next.js would end up with for `name`, and where it came from. */
export function resolveSetting(name, mode, readFile, environment = {}) {
  if (environment[name]) return { value: environment[name], source: "process environment" };
  for (const file of envFiles(mode)) {
    const text = readFile(file);
    if (text === null) continue;
    const values = parseEnv(text);
    // A name that is present but empty still wins, exactly as it does in Next.js: that is how the overrides fail closed.
    if (name in values) return { value: values[name], source: file };
  }
  return { value: "", source: "not set" };
}

/**
 * The verdict for one target. `ref` is what would be reached, `branch` the branch being worked on.
 * Only `main` may reach production. Any other branch must reach Staging, a local stack, or nothing at all.
 */
export function verdict(branch, ref) {
  if (ref === projects.production) return branch === "main" ? { ok: true, note: "production, on main" }
    : { ok: false, note: `PRODUCTION from branch "${branch}"` };
  if (ref === projects.staging) return { ok: true, note: branch === "main" ? "staging (on main: production is not reached)" : "staging" };
  if (ref === "local") return { ok: true, note: "local stack" };
  if (ref === "") return { ok: true, note: "not set: nothing is reached" };
  // A project nobody listed here. Refused off main, so a new project is added on purpose and not by accident.
  return branch === "main" ? { ok: true, note: "a project this script does not know" }
    : { ok: false, note: `a project this script does not know (${ref === "unknown" ? "unrecognized address" : ref})` };
}

/** Every check for the chosen targets. Pure: all it knows comes from its arguments. */
export function evaluate({ branch, targets, readFile, environment = {} }) {
  const checks = [];
  for (const mode of ["development", "production"]) {
    if (!targets.includes(mode === "development" ? "dev" : "build")) continue;
    const { value, source } = resolveSetting("SUPABASE_URL", mode, readFile, environment);
    const ref = projectRef(value);
    checks.push({ target: mode === "development" ? "next dev" : "next build / next start", source, ref, ...verdict(branch, ref) });
  }
  if (targets.includes("cli")) {
    const linked = (readFile("supabase/.temp/project-ref") ?? "").trim();
    const override = environment.SUPABASE_PROJECT_ID ?? "";
    const ref = override || linked;
    checks.push({ target: "supabase db push / functions deploy", source: override ? "SUPABASE_PROJECT_ID" : linked ? "supabase/.temp/project-ref" : "not linked", ref, ...verdict(branch, ref) });
  }
  return { branch, checks, ok: checks.every((check) => check.ok) };
}

function currentBranch(root) {
  // Vercel and CI check out a detached commit: they say which branch it is.
  const named = process.env.BELLIS_BRANCH || process.env.VERCEL_GIT_COMMIT_REF || process.env.GITHUB_REF_NAME;
  if (named) return named;
  try { return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return "unknown"; }
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const flags = process.argv.slice(2);
  const known = { "--dev": "dev", "--build": "build", "--cli": "cli" };
  const unknown = flags.filter((flag) => !(flag in known));
  if (unknown.length) { console.error(`Unknown option: ${unknown.join(" ")}. Use --dev, --build, --cli or nothing for all three.`); process.exit(2); }
  const targets = flags.length ? flags.map((flag) => known[flag]) : ["dev", "build", "cli"];
  const readFile = (file) => { const path = join(root, file); return existsSync(path) ? readFileSync(path, "utf8") : null; };
  const result = evaluate({ branch: currentBranch(root), targets, readFile, environment: process.env });
  console.log(`Branch: ${result.branch}`);
  for (const check of result.checks) {
    const label = check.ref && check.ref !== "local" && check.ref !== "unknown" ? `${check.ref}${names[check.ref] ? ` (${names[check.ref]})` : ""}` : check.ref || "—";
    console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.target}: ${label} · ${check.note} · from ${check.source}`);
  }
  if (!result.ok) {
    console.error(`\nRefused: only "main" may reach the production project (${projects.production}).`);
    console.error(`For the site: set SUPABASE_URL to https://${projects.staging}.supabase.co in .env.development.local and .env.production.local (ignored by Git).`);
    console.error(`For the CLI: npx supabase link --project-ref ${projects.staging}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
