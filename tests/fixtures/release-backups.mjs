/**
 * Backups for the tests of the release tooling: dump files with nothing real in them, and a fake pg_restore whose
 * table of contents is made from a schema capture (the same keys the validator expects). Nothing here reads a real
 * backup.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectedEntries } from "../../scripts/release/backup/validate.mjs";
import { buildCapture } from "../../scripts/release/drift/capture.mjs";
import { schemaAnswer } from "./release-project.mjs";
import { scratch } from "./release-harness.mjs";

export const capture = (raw) => buildCapture(raw, { environment: "staging", label: "base", capturedAt: "2026-10-14T00:00:00Z" });
export const base = () => capture(schemaAnswer());
export const pad = (value) => String(value).padStart(2, "0");
export const local = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
export const stamp = (date) => `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
const types = ["MATERIALIZED VIEW", "FK CONSTRAINT", "ROW SECURITY", "TABLE DATA", "CONSTRAINT", "SEQUENCE", "FUNCTION", "PROCEDURE", "AGGREGATE", "TRIGGER", "POLICY", "DOMAIN", "TABLE", "INDEX", "VIEW", "TYPE"];
/** A table of contents like pg_restore --list prints, holding `keys` of `schema`. */
export function toc(schema, keys, { created = new Date(Date.now() - 10 * 60_000), format = "CUSTOM", extraLines = [], dbname = "postgres" } = {}) {
  const lines = [";", `; Archive created at ${local(created)}`, `;     dbname: ${dbname}`, ";     TOC Entries: 99", ";     Compression: gzip", ";     Dump Version: 1.16-0", `;     Format: ${format}`, ";     Dumped from database version: 17.6", ";     Dumped by pg_dump version: 18.6", ";", "; Selected TOC Entries:", ";", `13; 2615 2200 SCHEMA - ${schema} postgres`];
  let n = 100;
  for (const key of keys) { const type = types.find((name) => key.startsWith(`${name} `)); const rest = key.slice(type.length + 1); lines.push(`${n++}; 1259 ${n} ${type} ${schema} ${["FUNCTION", "PROCEDURE", "AGGREGATE"].includes(type) ? `${rest}()` : rest} postgres`); }
  return [...lines, ...extraLines].join("\n") + "\n";
}
/** A backups folder with a dump per schema, and the fake pg_restore that reads it. */
export function backups(t, { dir = scratch(t, "bellis-backups-"), release = "h2-9", captureOf = base, created = new Date(Date.now() - 10 * 60_000), change = {}, size = 4000 } = {}) {
  const tocs = new Map(); const files = {};
  for (const schema of ["public", "private"]) {
    const name = change[schema]?.name ?? `bellis-prod-${schema}-${stamp(created)}-pre-${release}.dump`;
    const keys = [...expectedEntries(captureOf(), schema)].filter((key) => !(change[schema]?.drop ?? []).includes(key)).concat(change[schema]?.add ?? []);
    writeFileSync(join(dir, name), Buffer.alloc(change[schema]?.size ?? size, 7)); files[schema] = join(dir, name);
    tocs.set(name, change[schema]?.toc ?? toc(schema, keys, { created: change[schema]?.created ?? created, ...(change[schema]?.options ?? {}) }));
  }
  const listToc = (file) => { const name = file.split(/[\\/]/).pop(); if (change.corrupt === name) return { code: 1, stdout: "" }; return tocs.has(name) ? { code: 0, stdout: tocs.get(name) } : { code: 1, stdout: "" }; };
  return { dir, files, listToc, tocs };
}
