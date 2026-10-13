/**
 * Release tooling: the list of SQL smokes (manifest.json, next to this file), who reads it and who checks it.
 * The manifest is the only place that says which smokes exist, which groups they belong to and what each one has
 * to answer. A smoke file that is not listed is an error, so a new smoke cannot be forgotten.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CheckFailed, PreconditionError } from "../lib/report.mjs";
import { smokeChecks } from "./sql.mjs";

export const smokeDir = "supabase/tests";
export const manifestPath = "scripts/release/smoke/manifest.json";
const idPattern = /^[a-z][a-z0-9_]{1,60}$/;
const filePattern = /^supabase\/tests\/[a-z0-9_]+_smoke\.sql$/;

/** Everything wrong with a manifest, as a list. Empty when it can be used. `files` are the smoke files on disk. */
export function manifestProblems(manifest, { files = [], exists = () => true } = {}) {
  const problems = [];
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.smokes)) return ["the manifest has no list of smokes"];
  const groups = manifest.groups && typeof manifest.groups === "object" ? Object.keys(manifest.groups) : [];
  if (!groups.length) problems.push("the manifest defines no groups");
  if (manifest.contract?.name !== "bellis_smoke_v1" || manifest.contract?.pass !== "PASS") problems.push("the manifest does not describe the result contract (bellis_smoke_v1, PASS)");
  if (!(Number(manifest.defaults?.timeoutSeconds) > 0)) problems.push("the manifest has no default timeout");
  const ids = new Map(), paths = new Map();
  for (const [index, smoke] of manifest.smokes.entries()) {
    const name = typeof smoke?.id === "string" ? smoke.id : `#${index + 1}`;
    if (!idPattern.test(String(smoke?.id ?? ""))) problems.push(`${name}: the id uses lowercase letters, digits and underscores`);
    if (!filePattern.test(String(smoke?.file ?? ""))) problems.push(`${name}: the file has to be ${smokeDir}/<name>_smoke.sql`);
    else if (!exists(smoke.file)) problems.push(`${name}: ${smoke.file} does not exist`);
    if (ids.has(smoke?.id)) problems.push(`${name}: the id is listed twice`); ids.set(smoke?.id, true);
    if (paths.has(smoke?.file)) problems.push(`${name}: ${smoke.file} is listed twice`); paths.set(smoke?.file, true);
    if (!Array.isArray(smoke?.groups) || !smoke.groups.length) problems.push(`${name}: belongs to no group`);
    else { for (const group of smoke.groups) if (!groups.includes(group)) problems.push(`${name}: unknown group ${group}`); if (new Set(smoke.groups).size !== smoke.groups.length) problems.push(`${name}: a group is repeated`); }
    if (smoke?.expect?.result !== manifest.contract?.pass) problems.push(`${name}: has to say what it expects (result: PASS)`);
    if (smoke?.timeoutSeconds !== undefined && !(Number(smoke.timeoutSeconds) > 0 && Number(smoke.timeoutSeconds) <= 900)) problems.push(`${name}: the timeout has to be between 1 and 900 seconds`);
    for (const check of smoke?.checks ?? []) if (!smokeChecks[check]) problems.push(`${name}: unknown check ${check}`);
    if (smoke?.requires !== undefined && (!Array.isArray(smoke.requires) || smoke.requires.some((item) => typeof item !== "string"))) problems.push(`${name}: "requires" is a list of short notes`);
  }
  for (const file of files) if (!paths.has(file)) problems.push(`${file} is not in the manifest: a smoke that is not listed would never run`);
  for (const group of groups) if (!manifest.smokes.some((smoke) => smoke?.groups?.includes(group))) problems.push(`group ${group} has no smokes`);
  return problems;
}

/** Reads and checks the manifest of this repository. Throws CheckFailed with every problem found. */
export function loadManifest(root) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8")); } catch { throw new PreconditionError(`${manifestPath} could not be read.`); }
  const dir = join(root, smokeDir);
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().map((name) => `${smokeDir}/${name}`) : [];
  const problems = manifestProblems(manifest, { files, exists: (file) => existsSync(join(root, file)) });
  if (problems.length) throw new CheckFailed("The smoke manifest is not valid.", { stage: "smoke manifest", details: problems.slice(0, 20) });
  return manifest;
}

/**
 * The smokes to run, in the order of the manifest and each one once, however many of the chosen groups it is in.
 * With nothing chosen (or `all`), every smoke.
 */
export function selectSmokes(manifest, { groups = [], only = [], all = false } = {}) {
  const known = Object.keys(manifest.groups);
  for (const group of groups) if (!known.includes(group)) throw new PreconditionError(`Unknown group: ${group}. Groups: ${known.join(", ")}.`);
  for (const id of only) if (!manifest.smokes.some((smoke) => smoke.id === id)) throw new PreconditionError(`Unknown smoke: ${id}.`);
  if (all && (groups.length || only.length)) throw new PreconditionError("--all cannot be combined with --group or --only.");
  const everything = all || (!groups.length && !only.length);
  return manifest.smokes.filter((smoke) => everything || only.includes(smoke.id) || smoke.groups.some((group) => groups.includes(group)));
}
