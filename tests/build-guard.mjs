import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { evaluate, projects } from "../scripts/assert-staging-env.mjs";
import { deploymentTargetProblem, productionProjectRef, refusesProductionProject } from "../lib/supabase-target.ts";

const prod = `https://${projects.production}.supabase.co`;
const staging = `https://${projects.staging}.supabase.co`;
const none = () => null;

test("build: se revisa antes de compilar, también en Vercel", () => {
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  // npm corre `prebuild` antes de `build`: es lo que ejecuta Vercel con `npm run build`.
  assert.equal(scripts.prebuild, "node scripts/assert-staging-env.mjs --build");
  assert.equal(scripts.build, "next build");
  // La protección de `npm run dev` sigue donde estaba.
  assert.equal(scripts.predev, "node scripts/assert-staging-env.mjs --dev");
});

test("build: una rama que no es main no compila contra producción; main sí; staging siempre", () => {
  // En Vercel las variables llegan por el entorno del proceso, no por archivos.
  const build = (branch, url) => evaluate({ branch, targets: ["build"], readFile: none, environment: url === undefined ? {} : { SUPABASE_URL: url } });
  for (const branch of ["staging", "feat/h2-7-free-pro-core", "preview-x", "HEAD", "unknown"]) {
    assert.equal(build(branch, prod).ok, false, branch);
    assert.equal(build(branch, staging).ok, true, branch);
  }
  assert.equal(build("main", prod).ok, true);
  assert.equal(build("main", staging).ok, true);
  // Sin variable no se llega a ningún proyecto: no hay nada que rechazar.
  assert.equal(build("staging", undefined).ok, true);
  // Un proyecto que nadie anotó tampoco pasa fuera de main.
  assert.equal(build("staging", "https://abcdefghijklmnopqrst.supabase.co").ok, false);
});

test("build: como comando, con las variables que pone Vercel, corta con código 1 y no imprime claves", () => {
  const run = (env) => spawnSync(process.execPath, ["scripts/assert-staging-env.mjs", "--build"], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  // Preview de la rama staging con las variables de producción: el caso que pasó.
  const refused = run({ VERCEL: "1", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "staging", SUPABASE_URL: prod, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_do-not-print" });
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /FAIL {2}next build/);
  assert.match(refused.stderr, /Preview environment/);
  assert.doesNotMatch(refused.stdout + refused.stderr, /do-not-print/);
  assert.equal(run({ VERCEL: "1", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "staging", SUPABASE_URL: staging }).status, 0);
  assert.equal(run({ VERCEL: "1", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main", SUPABASE_URL: prod }).status, 0);
});

test("config en ejecución: un deploy de Vercel que no es de main no entrega el proyecto de producción", () => {
  assert.equal(productionProjectRef, projects.production);
  const preview = { VERCEL: "1", VERCEL_GIT_COMMIT_REF: "staging" };
  assert.equal(refusesProductionProject(prod, preview), true);
  assert.equal(refusesProductionProject(`${prod}/`, preview), true);
  assert.equal(refusesProductionProject(staging, preview), false);
  assert.equal(refusesProductionProject(prod, { VERCEL: "1", VERCEL_GIT_COMMIT_REF: "main" }), false);
  // Un deploy de Vercel que no dice de qué rama es no es main.
  assert.equal(refusesProductionProject(prod, { VERCEL: "1" }), true);
  // Fuera de Vercel no decide nada acá: el trabajo local se revisa antes de `next dev` y de `next build`.
  assert.equal(refusesProductionProject(prod, {}), false);
  assert.equal(refusesProductionProject(undefined, preview), false);
  // Solo el proyecto exacto: una dirección parecida no es producción.
  assert.equal(refusesProductionProject(`https://${projects.production}.supabase.co.evil.example`, preview), false);
});

test("runtime config rejects production from every Preview, even with main branch metadata", () => {
  assert.equal(deploymentTargetProblem(prod, {
    VERCEL: "1",
    VERCEL_ENV: "preview",
    VERCEL_GIT_COMMIT_REF: "main",
  }), "preview_with_production_project");
  assert.equal(deploymentTargetProblem(staging, {
    VERCEL: "1",
    VERCEL_ENV: "preview",
    VERCEL_GIT_COMMIT_REF: "feat/h3-1b-google-calendar-events",
  }), null);
  assert.equal(deploymentTargetProblem(prod, {
    VERCEL: "1",
    VERCEL_ENV: "production",
    VERCEL_GIT_COMMIT_REF: "main",
  }), null);

  const route = readFileSync("app/api/supabase-config/route.ts", "utf8");
  assert.match(route, /deploymentTargetProblem\(url, process\.env\)/);
  assert.doesNotMatch(route, /if \(refusesProductionProject\(/);
});
