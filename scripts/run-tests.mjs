#!/usr/bin/env node
/**
 * `npm test`: every unit test of the repository, in a fixed order, with one verdict.
 *
 *   node scripts/run-tests.mjs              all of them (tests/*.mjs and supabase/tests/*.test.mjs)
 *   node scripts/run-tests.mjs release      only the files whose name contains "release"
 *
 * None of these tests opens a connection: the SQL smokes are not run from here.
 * tests/known-failures.json lists tests that are known to fail on one platform. They are reported apart and do not
 * fail the run; if one of them starts passing, the run fails until it is taken off the list, so the list cannot rot.
 * Anything else that fails, fails the run.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { run } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const slash = (path) => path.split("\\").join("/");
const list = (dir, pattern) => readdirSync(join(root, dir)).filter((name) => pattern.test(name)).sort().map((name) => `${dir}/${name}`);
const filters = process.argv.slice(2);
const files = [...list("tests", /\.mjs$/), ...list("supabase/tests", /\.test\.mjs$/)].filter((file) => !filters.length || filters.some((filter) => file.includes(filter)));
if (!files.length) { console.error("No test file matches."); process.exit(2); }

const known = new Set(JSON.parse(readFileSync(join(root, "tests", "known-failures.json"), "utf8")).failures
  .filter((item) => item.platform === process.platform).map((item) => `${item.file} › ${item.test}`));
const passed = [], failed = [], knownFailed = [], fixed = [];
const key = (data) => `${data.file ? slash(relative(root, data.file)) : "(no file)"} › ${data.name}`;
const isSuite = (data) => data.details?.type === "suite";

const stream = run({ files: files.map((file) => join(root, file)), concurrency: true });
stream.on("test:pass", (data) => { if (isSuite(data) || data.skip || data.todo) return; const id = key(data); (known.has(id) ? fixed : passed).push(id); });
stream.on("test:fail", (data) => {
  if (isSuite(data)) return;
  const id = key(data);
  if (known.has(id)) { knownFailed.push(id); return; }
  // A file whose only failures are known ones still ends with a failing exit; that entry is not a test.
  if (data.details?.error?.failureType === "subtestsFailed" || (data.file && slash(data.file).endsWith(data.name))) return;
  failed.push({ id, message: String(data.details?.error?.cause?.message ?? data.details?.error?.message ?? "failed").split("\n")[0] });
});
stream.on("end", () => {
  const total = passed.length + failed.length + knownFailed.length + fixed.length;
  for (const item of failed) console.log(`FAIL  ${item.id}\n      ${item.message}`);
  for (const id of fixed) console.log(`FIXED ${id}\n      it passes now: take it off tests/known-failures.json`);
  for (const id of knownFailed) console.log(`KNOWN ${id}`);
  console.log(`\n${files.length} file(s), ${total} test(s): ${passed.length} passed, ${failed.length} failed, ${knownFailed.length} known failure(s) on ${process.platform}${fixed.length ? `, ${fixed.length} known failure(s) now passing` : ""}`);
  const ok = failed.length === 0 && fixed.length === 0 && total > 0;
  console.log(ok ? "PASS" : "FAIL");
  process.exitCode = ok ? 0 : 1;
});
stream.resume();
