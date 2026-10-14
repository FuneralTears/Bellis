/**
 * Release tooling: compares two schema captures object by object.
 * After the same migrations have been applied to both environments there must be no difference at all: any object
 * that is in one and not in the other, or whose definition differs, is drift and fails.
 * What is reported is the category, the object and what happened to it (ADDED, REMOVED or CHANGED, and for a change
 * which of its attributes differ). Definitions are shown only when asked for, and then with credentials removed.
 */
import { readFileSync } from "node:fs";
import { CheckFailed, PreconditionError, redact } from "../lib/report.mjs";
import { captureProblems, categories } from "./capture.mjs";

/** Checks a capture read from anywhere. Accepts the document itself or the file the state folder wraps it in. */
export function acceptCapture(value, name = "schema") {
  const document = value && typeof value === "object" && value.format === undefined && value.data && typeof value.data === "object" ? value.data : value;
  const problems = captureProblems(document);
  if (problems.length) throw new CheckFailed(`The ${name} capture is not a valid schema capture.`, { stage: "schema compare", details: problems.slice(0, 10) });
  return document;
}
export function readCaptureFile(path, name = "schema") {
  let value; try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new PreconditionError(`The ${name} capture could not be read.`); }
  return acceptCapture(value, name);
}

/**
 * { ok, differences, counts }. Each difference: { category, id, change, parts }, where change is "REMOVED" (only in
 * the first), "ADDED" (only in the second) or "CHANGED" (in both, with `parts` naming the attributes that differ).
 */
export function compareSchemas(first, second) {
  const differences = [];
  for (const category of Object.keys(categories)) {
    const a = new Map(first.objects[category].map((item) => [item.id, item])), b = new Map(second.objects[category].map((item) => [item.id, item]));
    for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      const before = a.get(id), after = b.get(id);
      if (!after) differences.push({ category, id, change: "REMOVED", parts: [] });
      else if (!before) differences.push({ category, id, change: "ADDED", parts: [] });
      else if (before.hash !== after.hash) differences.push({ category, id, change: "CHANGED", parts: [...new Set([...Object.keys(before.parts), ...Object.keys(after.parts)])].filter((part) => before.parts[part] !== after.parts[part]).sort() });
    }
  }
  const counts = Object.fromEntries(Object.keys(categories).map((category) => [category, { first: first.objects[category].length, second: second.objects[category].length, different: differences.filter((item) => item.category === category).length }]));
  return { ok: differences.length === 0, differences, counts };
}

const short = (text, max) => { const clean = redact(text, max); return clean === "" ? "(empty)" : clean; };
/** One line for a difference: what a person reads by default. No definition in it. */
export function differenceLine(difference, names = ["first", "second"]) {
  const where = difference.change === "ADDED" ? ` (only in ${names[1]})` : difference.change === "REMOVED" ? ` (only in ${names[0]})` : difference.parts.length ? ` (${difference.parts.join(", ")})` : "";
  return `${difference.change.padEnd(7)}  ${difference.category}  ${redact(difference.id, 160)}${where}`;
}
/** The lines of the verbose view of a difference: each attribute that differs, as each side has it, cut short. */
export function differenceDetail(difference, first, second, names = ["first", "second"], max = 600) {
  if (difference.change !== "CHANGED") return [];
  const a = first.objects[difference.category].find((item) => item.id === difference.id), b = second.objects[difference.category].find((item) => item.id === difference.id);
  const show = (value) => short(typeof value === "string" ? value : JSON.stringify(value ?? null), max);
  return difference.parts.flatMap((part) => [`    ${part} in ${names[0]}: ${show(a.definition[part])}`, `    ${part} in ${names[1]}: ${show(b.definition[part])}`]);
}
