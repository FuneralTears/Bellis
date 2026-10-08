import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { evaluate, parseEnv, projectRef, projects, resolveSetting, verdict } from "../scripts/assert-staging-env.mjs";

const prod = `https://${projects.production}.supabase.co`;
const staging = `https://${projects.staging}.supabase.co`;
const files = (map) => (name) => name in map ? map[name] : null;
const all = ["dev", "build", "cli"];

test("guarda de entorno: reconoce el proyecto de una dirección y no confunde lo que no conoce", () => {
  assert.equal(projectRef(prod), projects.production);
  assert.equal(projectRef(`${staging}/`), projects.staging);
  assert.equal(projectRef("http://localhost:54321"), "local");
  assert.equal(projectRef(""), "");
  assert.equal(projectRef("https://example.com"), "unknown");
  assert.equal(projectRef(`https://${projects.production}.supabase.co.evil.example`), "unknown");
});

test("guarda de entorno: lee los archivos en el orden de Next.js y un valor vacío también gana", () => {
  assert.deepEqual(parseEnv('# nota\nSUPABASE_URL="https://x"\nexport OTHER = y \nroto'), { SUPABASE_URL: "https://x", OTHER: "y" });
  const read = files({ ".env.local": `SUPABASE_URL=${prod}`, ".env.development.local": `SUPABASE_URL=${staging}` });
  assert.deepEqual(resolveSetting("SUPABASE_URL", "development", read), { value: staging, source: ".env.development.local" });
  // Without an override for that mode, .env.local is what the site uses.
  assert.deepEqual(resolveSetting("SUPABASE_URL", "production", read), { value: prod, source: ".env.local" });
  assert.equal(resolveSetting("SUPABASE_URL", "development", read, { SUPABASE_URL: prod }).source, "process environment");
  assert.deepEqual(resolveSetting("SUPABASE_URL", "development", files({ ".env.development.local": "SUPABASE_URL=", ".env.local": `SUPABASE_URL=${prod}` })),
    { value: "", source: ".env.development.local" });
});

test("guarda de entorno: en una rama que no es main, producción se rechaza por cualquiera de los tres caminos", () => {
  // The situation this workspace started from: `vercel env pull` wrote production into .env.local.
  const pulled = evaluate({ branch: "staging", targets: all, readFile: files({ ".env.local": `SUPABASE_URL=${prod}`, "supabase/.temp/project-ref": projects.staging }) });
  assert.equal(pulled.ok, false);
  assert.deepEqual(pulled.checks.map((check) => check.ok), [false, false, true]);
  // With both overrides in place it passes, whatever .env.local says.
  const guarded = evaluate({ branch: "staging", targets: all, readFile: files({ ".env.local": `SUPABASE_URL=${prod}`,
    ".env.development.local": `SUPABASE_URL=${staging}`, ".env.production.local": `SUPABASE_URL=${staging}`, "supabase/.temp/project-ref": `${projects.staging}\n` }) });
  assert.equal(guarded.ok, true);
  // Only one override: the other mode still reaches production.
  const half = evaluate({ branch: "staging", targets: all, readFile: files({ ".env.local": `SUPABASE_URL=${prod}`, ".env.development.local": `SUPABASE_URL=${staging}` }) });
  assert.deepEqual(half.checks.map((check) => check.ok), [true, false, true]);
  // The CLI linked to production: a `db push` or a deploy from this branch would land there.
  const linked = evaluate({ branch: "feature/x", targets: ["cli"], readFile: files({ "supabase/.temp/project-ref": projects.production }) });
  assert.equal(linked.ok, false);
  assert.equal(evaluate({ branch: "staging", targets: ["cli"], readFile: files({ "supabase/.temp/project-ref": projects.staging }), environment: { SUPABASE_PROJECT_ID: projects.production } }).ok, false);
  // An exported variable beats every file.
  assert.equal(evaluate({ branch: "staging", targets: ["dev"], readFile: files({ ".env.development.local": `SUPABASE_URL=${staging}` }), environment: { SUPABASE_URL: prod } }).ok, false);
});

test("guarda de entorno: main puede usar producción; staging, local o nada pasan en cualquier rama; lo desconocido no", () => {
  assert.equal(verdict("main", projects.production).ok, true);
  for (const branch of ["staging", "feature/x", "unknown", "HEAD"]) {
    assert.equal(verdict(branch, projects.production).ok, false, branch);
    assert.equal(verdict(branch, projects.staging).ok, true);
    assert.equal(verdict(branch, "local").ok, true);
    assert.equal(verdict(branch, "").ok, true);
    assert.equal(verdict(branch, "unknown").ok, false);
    assert.equal(verdict(branch, "abcdefghijklmnopqrst").ok, false);
  }
  assert.equal(evaluate({ branch: "main", targets: all, readFile: files({ ".env.local": `SUPABASE_URL=${prod}`, "supabase/.temp/project-ref": projects.production }) }).ok, true);
});

test("guarda de entorno: como comando falla con código 1, no imprime claves y rechaza opciones desconocidas", () => {
  const run = (args, env) => spawnSync(process.execPath, ["scripts/assert-staging-env.mjs", ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  const refused = run(["--dev"], { BELLIS_BRANCH: "staging", SUPABASE_URL: prod, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_do-not-print" });
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /FAIL {2}next dev/);
  assert.doesNotMatch(refused.stdout + refused.stderr, /do-not-print/);
  const allowed = run(["--dev"], { BELLIS_BRANCH: "staging", SUPABASE_URL: staging });
  assert.equal(allowed.status, 0);
  assert.equal(run(["--dev"], { BELLIS_BRANCH: "main", SUPABASE_URL: prod }).status, 0);
  assert.equal(run(["--nope"], {}).status, 2);
});
