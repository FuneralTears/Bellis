/**
 * Release tooling: the manifest of a release, releases/<release-id>.json, versioned in git.
 *
 * It says what is being released and nothing else:
 *   releaseId          the name of the release; the file is named after it
 *   sourceCommit       the commit whose code is released (full SHA)
 *   expectedMainBase   where main has to be when the release starts (full SHA)
 *   migrations         [{ file, sha256 }], the migrations of the release, in the order they are applied (may be empty)
 *   smokeGroups        the groups of SQL smokes that have to pass (see scripts/release/smoke/manifest.json)
 *   previewRequired    whether a person has to look at the Vercel Preview before the release goes on
 *   createdAt          when the manifest was written (ISO time)
 *   branch             (optional) the branch the release is made from
 *   notes              (optional) a short note
 * Any other field is an error, and so is anything that looks like a credential.
 *
 * The manifest is committed on top of the source commit: the commit that adds it cannot be the one it names. So the
 * repository is accepted at the source commit itself or at a descendant whose only change is this manifest.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CheckFailed, PreconditionError } from "./report.mjs";
import { findSecrets } from "./state.mjs";

export const releaseIdPattern = /^[a-z0-9](?:[a-z0-9-]|\.(?!\.)){1,60}$/;
const commitPattern = /^[0-9a-f]{40}$/;
const fields = Object.freeze({ releaseId: true, sourceCommit: true, expectedMainBase: true, migrations: true, smokeGroups: true, previewRequired: true, createdAt: true, branch: false, notes: false });
export const manifestFile = (releaseId) => `releases/${releaseId}.json`;

/** Everything wrong with a manifest, as a list. Empty when it can be used. */
export function manifestProblems(manifest, { releaseId, smokeGroups } = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return ["the manifest is not a JSON object"];
  const problems = [];
  for (const key of Object.keys(manifest)) if (!Object.hasOwn(fields, key)) problems.push(`unknown field: ${/^[A-Za-z_]{1,40}$/.test(key) ? key : "(name not shown)"}`);
  for (const [key, required] of Object.entries(fields)) if (required && manifest[key] === undefined) problems.push(`missing field: ${key}`);
  if (manifest.releaseId !== undefined && !releaseIdPattern.test(String(manifest.releaseId))) problems.push("releaseId: lowercase letters, digits, dashes and single dots only");
  if (releaseId !== undefined && manifest.releaseId !== releaseId) problems.push(`releaseId: the file is releases/${releaseId}.json but it says ${releaseIdPattern.test(String(manifest.releaseId)) ? manifest.releaseId : "something else"}`);
  for (const key of ["sourceCommit", "expectedMainBase"]) if (manifest[key] !== undefined && !commitPattern.test(String(manifest[key]))) problems.push(`${key}: has to be a full commit SHA (40 hex characters)`);
  if (manifest.migrations !== undefined) {
    if (!Array.isArray(manifest.migrations)) problems.push("migrations: has to be a list (it can be empty)");
    else {
      const seen = new Set();
      manifest.migrations.forEach((item, index) => {
        const where = `migrations[${index}]`;
        if (!item || typeof item !== "object" || Array.isArray(item)) { problems.push(`${where}: is not { file, sha256 }`); return; }
        for (const key of Object.keys(item)) if (!["file", "sha256"].includes(key)) problems.push(`${where}: unknown field ${/^[A-Za-z_]{1,40}$/.test(key) ? key : "(name not shown)"}`);
        if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(String(item.file))) problems.push(`${where}.file: has to be the file name of a migration (no path)`);
        if (!/^[0-9a-f]{64}$/.test(String(item.sha256))) problems.push(`${where}.sha256: has to be a SHA-256 (64 hex characters)`);
        if (seen.has(item.file)) problems.push(`${where}: ${item.file} is listed twice`); seen.add(item.file);
        if (index > 0 && !(String(manifest.migrations[index - 1]?.file) < String(item.file))) problems.push(`${where}: the migrations are not in the order they are applied`);
      });
    }
  }
  if (manifest.smokeGroups !== undefined) {
    if (!Array.isArray(manifest.smokeGroups) || !manifest.smokeGroups.length || manifest.smokeGroups.some((group) => !/^[a-z][a-z0-9_-]{0,30}$/.test(String(group)))) problems.push("smokeGroups: has to be a non-empty list of group names");
    else if (new Set(manifest.smokeGroups).size !== manifest.smokeGroups.length) problems.push("smokeGroups: a group is repeated");
    else if (smokeGroups) for (const group of manifest.smokeGroups) if (!smokeGroups.includes(group)) problems.push(`smokeGroups: unknown group ${group}`);
  }
  if (manifest.previewRequired !== undefined && typeof manifest.previewRequired !== "boolean") problems.push("previewRequired: has to be true or false");
  if (manifest.createdAt !== undefined && (typeof manifest.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(manifest.createdAt) || Number.isNaN(Date.parse(manifest.createdAt)))) problems.push("createdAt: has to be an ISO time in UTC");
  if (manifest.branch !== undefined && (typeof manifest.branch !== "string" || !/^[A-Za-z0-9._/-]{1,100}$/.test(manifest.branch) || manifest.branch.includes(".."))) problems.push("branch: is not a branch name");
  if (manifest.notes !== undefined && (typeof manifest.notes !== "string" || manifest.notes.length > 500)) problems.push("notes: has to be text of 500 characters at most");
  if (findSecrets(manifest).length) problems.push("the manifest holds something that looks like a credential");
  return problems;
}

/** Reads releases/<releaseId>.json and checks it. Throws PreconditionError when it cannot be read, CheckFailed when it is not valid. */
export function loadReleaseManifest(root, releaseId, { smokeGroups } = {}) {
  if (!releaseIdPattern.test(String(releaseId ?? ""))) throw new PreconditionError("A release id uses lowercase letters, digits, dashes and single dots (for example h2-8c).");
  let text; try { text = readFileSync(join(root, "releases", `${releaseId}.json`), "utf8"); } catch { throw new PreconditionError(`${manifestFile(releaseId)} could not be read.`); }
  let manifest; try { manifest = JSON.parse(text); } catch { throw new CheckFailed(`${manifestFile(releaseId)} is not valid JSON.`, { stage: "manifest" }); }
  const problems = manifestProblems(manifest, { releaseId, smokeGroups });
  if (problems.length) throw new CheckFailed(`${manifestFile(releaseId)} is not a valid release manifest.`, { stage: "manifest", details: problems.slice(0, 20) });
  return { manifest, hash: createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex") };
}
