#!/usr/bin/env node
/**
 * A stand-in for the Supabase CLI, for the tests of the release tooling. It never opens a connection: its whole
 * world is a JSON file (FAKE_SUPABASE_STATE) that says which project is linked and how it should misbehave.
 * It deliberately prints things a real tool might print and that must never reach a report: a connection string
 * with a password on failures, and extra fields with credentials in the list of projects.
 *
 *   link --project-ref <ref>     projects list     --version
 *
 * State: { workdir, linked, projects: [{ ref, name }], failLink: [ref], failProjects, marks: "linked"|"none"|"both"|<ref>,
 *          linkLands: { <asked ref>: <ref it ends on> }, noJson, log: [] }
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const file = process.env.FAKE_SUPABASE_STATE;
if (!file) { process.stderr.write("FAKE_SUPABASE_STATE is not set\n"); process.exit(64); }
const state = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
const leak = "failed to connect to postgres://postgres:hunter2-secret@db.example.supabase.co:5432/postgres token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
state.log = [...(state.log ?? []), args.join(" ")];

if (args[0] === "--version") { save(); process.stdout.write("2.120.0\n"); process.exit(0); }
if (args[0] === "link" && args[1] === "--project-ref") {
  const ref = args[2];
  if ((state.failLink ?? []).includes(ref)) { save(); process.stderr.write(`Initialising login role...\n${leak}\n`); process.exit(1); }
  state.linked = state.linkLands?.[ref] ?? ref;
  mkdirSync(join(state.workdir, "supabase", ".temp"), { recursive: true });
  writeFileSync(join(state.workdir, "supabase", ".temp", "project-ref"), state.linked);
  save(); process.stdout.write(JSON.stringify({ project_ref: ref, message: "", db_password: "hunter2-secret" }) + "\n"); process.exit(0);
}
if (args[0] === "projects" && args[1] === "list") {
  save();
  if (state.failProjects) { process.stderr.write(`${leak}\n`); process.exit(1); }
  if (state.noJson) { process.stdout.write("LINKED | ORG | REFERENCE ID | NAME\n"); process.exit(0); }
  const marks = state.marks ?? "linked";
  const projects = (state.projects ?? []).map((item) => ({ id: item.ref, ref: item.ref, name: item.name, status: "ACTIVE_HEALTHY", organization_id: "org",
    linked: marks === "both" ? true : marks === "none" ? false : marks === "linked" ? item.ref === state.linked : item.ref === marks,
    database: { host: "db.example.supabase.co", password: "hunter2-secret" }, service_role_key: "sb_secret_never_show_this" }));
  process.stderr.write("Initialising login role...\n");
  process.stdout.write(JSON.stringify({ projects }) + "\n"); process.exit(0);
}
save(); process.stderr.write(`unknown command: ${args.join(" ")}\n`); process.exit(2);
