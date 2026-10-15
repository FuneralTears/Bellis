# Bellis release tooling

One entry point, `scripts/release/cli.mjs`. Every command ends with the same report and an exit code that says
whether to go on.

## Commands

| Command | What it does | Touches |
| --- | --- | --- |
| `npm run bellis:status` | Where things are: linked project, repository, local migrations. | Nothing. Reads local files. |
| `npm run bellis:status -- --remote` | The same, and confirms the link with the account's list of projects. | One read-only request. |
| `npm run bellis:check-core` | The tooling's own guardrails, and a rehearsal of the target guard against a simulated CLI. | Nothing. No request is sent. |
| `npm run bellis:smoke` | Every SQL smoke of `supabase/tests`, against staging. | Staging, inside transactions that are rolled back. Nothing is kept. |
| `npm run bellis:smoke -- --group core` | Only the smokes of a group: `core`, `crm`, `plans`, `admin`, `release`. Several groups run each smoke once. | The same. |
| `npm run bellis:smoke -- --list` | Which smokes would run. | Nothing. |
| `npm run bellis:snapshot -- --release <id> --label pre` | Takes a data snapshot: counts and fingerprints, never a row. | One read-only transaction. Writes a file in the release's folder, outside the repository. |
| `npm run bellis:snapshot -- --release <id> --compare pre post` | Compares two snapshots. Any difference fails. | Nothing. Reads two files. |
| `npm run bellis:drift -- --capture --release <id> --env staging` | Captures the schema (also `--env production`). | One read-only transaction on the catalogs. Writes a file in the release's folder. |
| `npm run bellis:drift -- --release <id> --compare staging production` | Compares two captures exactly. Any difference fails. | Nothing. Reads two files. |
| `npm run bellis:drift -- --rehearse --release <id>` | Measures what the release's migrations change, on staging, before they are applied there. | Staging, one transaction that is rolled back and verified. |
| `npm run bellis:drift -- --expected --release <id>` | Is the difference between staging and production exactly the release? | Nothing. Reads four captures. |
| `npm run bellis:check -- --release <id>` | Everything about a release that can be checked on this machine. | Nothing. Never touches Supabase. |
| `npm run bellis:staging -- --release <id>` | Takes the release to staging: rehearsal, smokes, dry run, apply, verification. | Staging only (applies the release's migrations). Production is read, never written. |
| `npm run bellis:staging -- --release <id> --confirm-preview <id>` | A person confirms they looked at the Preview. | The release's state, nothing else. |
| `npm run bellis:staging -- --release <id> --reuse-rehearsal <folder>` | Resumes an applied release whose state lost its rehearsal, reusing an earlier one only after every check passes. | Staging is only read for it; then the usual run. |
| `npm run bellis:backup-check -- --release <id>` | Checks the two production backups a person made. | Nothing. Local files, read with `pg_restore --list`. |
| `npm run bellis:prod-precheck -- --release <id>` | Everything about production before a release. | Production, read-only. Never written. |
| `npm run bellis:deploy-check -- --release <id> --expected-env preview` | What a deployment serves: commit, environment, Supabase project. | Nothing. Public URLs, no credentials. |
| `CONFIRM_PROD_RELEASE=<id>@<short commit> npm run bellis:prod-release -- --release <id>` | The release to production. Asks for the release id in the terminal. | Production (its migrations), and origin's main (a fast-forward). |
| `npm test` | Every unit test of the repository (`scripts/run-tests.mjs`). | Nothing. The SQL smokes are not run from here. |

Add `-- --json` to get the report as JSON. `bellis:smoke` also takes `--only <id...>`, `--all` and `--ndjson` (one JSON
event per line, the report last).

Only `prod-release` writes to production or moves main, and only with a person's approval (below). Nothing in this
folder deploys, promotes or changes an alias; `bellis:staging` is the only command that applies migrations, and only to
staging (`lib/target.mjs` `assertWritable` refuses any other target before the write).

## A release (`releases/<id>.json`, `stages/`)

The manifest is versioned in git and checked strictly (`lib/manifest.mjs`; an unknown field is an error):

```json
{
  "releaseId": "h2-9",
  "sourceCommit": "<40-character SHA of the code being released>",
  "expectedMainBase": "<40-character SHA where main is now>",
  "migrations": [{ "file": "20261020090000_name.sql", "sha256": "<hash with Unix line endings>" }],
  "smokeGroups": ["release"],
  "previewRequired": true,
  "createdAt": "2026-10-14T00:00:00Z",
  "branch": "feat/...",
  "notes": "optional"
}
```

`migrations` can be empty. The manifest is committed on top of the source commit, so the repository is accepted at the
source commit or at a descendant whose only change is the manifest.

`bellis:check` runs the manifest, git (clean tree, branch, source commit, main where the manifest says, main can
fast-forward, `supabase/.temp` not tracked), the migrations (present, hashes, order, safe to rehearse), the smokes'
files, the tooling's self-test, `npm test`, TypeScript, ESLint (the tooling and every file changed since main's base)
and the build. It never touches Supabase.

`bellis:staging` (`stages/staging.mjs`) runs every block inside `withTarget`, so the CLI ends on staging whatever
happens: preconditions (the local checks are reused for the same commit and manifest), staging's migration history
(nothing unknown applied, pending exactly the release), data snapshot `pre`, rehearsal (base and expected), production's
schema read-only (it has to be exactly base), smokes with the pending migrations, a dry run that has to list exactly the
release, the apply (target, history and hashes checked again right before, then the write guard), the history after,
smokes without pending migrations, snapshot `post` (identical, or a person reviews it: data changes are never accepted
automatically), residue, and production read again: staging exactly expected, production still exactly base. A release
without migrations has no rehearsal and no apply, and staging and production have to match exactly.

Its state (`<release folder>/release-state.json`) moves `CHECKED → REHEARSED → STAGING_APPLIED → STAGING_VERIFIED →
PREVIEW_PENDING → STAGING_COMPLETE`; a release without migrations skips the two in the middle, and one with
`previewRequired: false` goes straight to `STAGING_COMPLETE`. Every step is written down with its time, commit,
environment and result; nothing can be skipped, and a state written for another version of the manifest is refused.
Run again before the apply, it starts over; after the apply, it does not apply again and goes on verifying, but only if
this release was rehearsed; with part of the release applied, it stops. The Preview is never checked automatically: a
person confirms it with `--confirm-preview <id>`, at the commit that was verified.

An applied release whose state lost its rehearsal (its folder was moved aside because the source commit changed with
no migration touched) stops and asks for a person. The one explicit way on is `--reuse-rehearsal <folder>`
(`stages/rehearsal-reuse.mjs`): the earlier rehearsal kept in that folder of the releases directory is reused only if
its state is this release's (inside the files, not by folder name) and its rehearsal finished; its base and expected
captures are there and valid, of staging, at one commit; it rehearsed exactly the manifest's migrations, in order, with
the same SHA-256; that commit descends from the main base, is an ancestor of HEAD, and no migration changed since; the
whole release is applied on staging with nothing pending or unknown; and staging, captured now (read only), is an
EXACT MATCH of the earlier expected schema. Anything else fails closed and nothing is saved. When it passes, the base and
expected are kept as this release's, `rehearsal-reuse.json` records where they came from (`mode: reused`, source,
commits, migration hashes, schema hashes, `verifiedAt`, `actor: tooling`), `REHEARSED` is written down as reused, the
data snapshot before is taken then, and the rest of the run (smokes, snapshot, residue, expected drift, Preview) is the
usual one. Nothing is written to a database.

## Backups (`backup/validate.mjs`)

Before production, a person makes two backups in `C:\Users\<user>\Bellis-Backups\` (or `BELLIS_BACKUPS_DIR`), with
`pg_dump --format=custom --no-privileges --schema=<public|private>`, named
`bellis-prod-<public|private>-YYYYMMDD-HHMM-pre-<release>.dump`. The tooling never makes them and never asks for a
password. `auth` and `vault` are not in them: known debt.

A backup passes when it exists, is not empty, `pg_restore --list` reads it, it is a custom archive, it is at most 24
hours old (`--max-age-hours`), its name matches the release, the schema and the time inside the archive, it holds
only its schema and the data of every table, and it holds exactly the objects production has in that schema. Those
objects are not listed by hand: they come from the release's schema captures (`schema-base`, and `schema-expected` for
what only the release's migrations create, which must not be there). Its size is compared with the previous backup of
the same schema: below 80% or above 250% it is a question for a person (exit 4), never a pass on size alone.

## Production precheck (`stages/prod-precheck.mjs`)

Needs the release at `STAGING_COMPLETE`. In order: the release's static checks; both backups (one missing is exit 4,
before anything is linked or read); staging read, still what the release left; then production, inside `withTarget`
and only through `lib/guard.mjs` `readOnly` (a real push or any SQL that is not a read-only transaction is refused
before the CLI runs): migration history (pending exactly the release), schema (exactly the release's base, and with
staging exactly what the release explains), a data snapshot, the dry run (exactly the release's migrations), and a
second snapshot that has to be identical. Only when everything passed it writes `PROD_PRECHECK_COMPLETE` and
`prod-precheck.json` (commit, manifest, migration set, backups with their hashes, schema and snapshot hashes, dry
run), valid for 2 hours. `--reuse` reuses it while it is valid for the same commit, manifest, migrations and backup
files, with the CLI on staging; otherwise a full precheck runs.

## Deployments (`deploy/verify.mjs`, `stages/deploy-check.mjs`)

Every deployment answers `/api/version` (`app/api/version/route.ts`, built by `versionPayload` in
`lib/supabase-target.ts`): `service`, `commit`, `environment`, `supabaseRef`, `branch`, `deploymentId`, `consistent` and
`problem`. Nothing else: no key, no address, no setting. The commit comes from Vercel's build metadata
(`VERCEL_GIT_COMMIT_SHA`), and outside Vercel from git; anything that is not a full SHA is `UNKNOWN`. The environment
comes from `VERCEL_ENV` (outside Vercel it is `development`), never from a host name. The project ref comes from the
address the app uses, and the same guard that protects `/api/supabase-config` says whether the three agree (a
production deployment on staging, or a preview on production, is `consistent: false`).

`bellis:deploy-check` reads `/api/version` from the exact URL of a deployment (`--url`, or found through GitHub's public
deployments of the commit, with no token), and for production also from the alias (`https://bellis-six.vercel.app` by
default, `--alias`), which has to serve the same commit and project. The shape has to be exact, and commit,
environment and project have to be the expected ones (with `--release`, the commit verified on staging). It also opens
`/`, `/ingresar` and `/api/supabase-config` without credentials: they have to answer and carry nothing secret. A
deployment behind Vercel's login is never a pass: it is exit 4, and a person who looked at it in their browser
records it with `--confirm-human <release-id> --url <exact URL>` (Preview only). The result is kept as
`DEPLOY_PREVIEW_VERIFIED` or `DEPLOY_PROD_VERIFIED` in `deploy-state.json` (URL, alias, expected and observed commit,
environment, project, time, automatic or human); these are records next to the release's state, not steps of it.
It never pushes, deploys, promotes, changes an alias or touches Vercel's settings, and keeps no cookie or token.

In production the exact URL of a deployment is behind Vercel's login while the alias is public. The alias is always
read: if it serves exactly the release and the exact URL is protected, the result is `DEPLOY_PROD_PARTIAL_VERIFIED`
(exit 4), never a pass for the protected URL. prod-release then stops recoverably at `MAIN_ADVANCED` (nothing is
written again), and a person who looked at the exact URL confirms it with
`bellis:deploy-check -- --release <id> --expected-env production --url <exact URL> --confirm-human <id>`. That is
accepted only at `MAIN_ADVANCED`, for the release's commit and the deployment that was partially verified, with the
alias read again; it records `DEPLOY_PROD_VERIFIED` (human, with the alias's automatic reading), runs the public QA
and completes the release. A deployment verified automatically at `MAIN_ADVANCED` closes the release the same way.

## Production release (`stages/prod-release.mjs`)

It cannot start by accident: it needs, at once, `CONFIRM_PROD_RELEASE=<release-id>@<short commit>` in the
environment, a valid precheck (`PROD_PRECHECK_COMPLETE` for this commit, manifest and migrations, not expired), and
the release id typed again in an interactive terminal. Any of them missing is exit 4, before anything is linked.
None of them is kept. The commit is the release commit: the one verified on staging (source commit plus manifest).

Before writing, it checks again that nothing moved since the precheck: the release locally (git, state, backups by
hash), staging (still exactly `expected`) and production (history, schema exactly `base`, dry run, data exactly the
precheck's snapshot). Then the apply, the only database write, inside `lib/guard.mjs` `withProdWriteAuthorization`
(a grant for one listed operation that exists only while it runs; without it `assertWritable` refuses any production
write). Then: history, schema (production = staging = expected), the manifest's smokes on production (each a
transaction that is rolled back, self-test first), data identical to the precheck's and no residue → `PROD_VERIFIED`;
main fast-forwarded on origin to the release commit, only if origin's main is still the manifest's base, never forced
→ `MAIN_ADVANCED`; the deployment of that commit found through GitHub and waited for, verified with the production
alias (which may lag for a few tries, never on another project) → `DEPLOY_PROD_VERIFIED`; and the public pages
without a login → `RELEASE_COMPLETE`. Once production or main has been written, any failure is exit 5 and the state
shows how far it got; a release that went further than its precheck is not started again without a person.

## SQL smokes (`smoke/`)

`smoke/manifest.json` lists every smoke, its groups and what it has to answer. A smoke file that is not listed is an
error, and so is a listed file that does not exist.

A smoke passes only when all of this is true:

1. Before anything is sent, the file is read by a tokenizer (`smoke/sql.mjs`) that tells code apart from comments,
   strings and dollar-quoted bodies: `BEGIN` is its first statement, there is no `COMMIT` or other transaction
   control, and a plain `ROLLBACK` is its last statement. One file in doubt stops the whole run before connecting.
2. The CLI exits 0 with no SQL error.
3. The answer is exactly one row, the one this run asked for. The runner writes it as the last statement inside the
   smoke's transaction (`bellis_smoke_v1`: smoke id, `PASS`, a value made up for the run, the transaction id), so
   reaching it means every statement before it succeeded.
4. That row says `PASS`.
5. PostgreSQL reports the smoke's transaction as aborted afterwards (`txid_status`).

Every run starts with the runner's self-test: a smoke with `COMMIT` and one without `ROLLBACK` have to be refused
without being sent, and a smoke that raises an error has to fail. If any of them gets through, no smoke runs.

The runner only works against staging, with the CLI already there; it never links.

### Trying a migration before applying it

`npm run bellis:smoke -- --with-pending 20270101000000_name.sql [more...]` runs those migrations inside each
smoke's transaction, before the smoke, and rolls everything back. Each migration is named explicitly by its file
name in `supabase/migrations` (no paths, no patterns), and one with transaction control of its own is refused. With
`--release <id>`, each one also has to be listed in `releases/<id>.json` (`{ "migrations": [{ "file", "sha256" }] }`)
with the same hash. Not wired into any other command yet.

### Writing a smoke

Synthetic data only, created inside the transaction (`@example.invalid` users, fixed `fNNNNNNN-0000-4000-8000-…`
ids): never read or pick an existing user or workspace, and count against what was there before, not against an
empty database. Raise an exception when something is wrong. Add the file to `smoke/manifest.json`.

## Data snapshots (`snapshot/`)

A snapshot answers one question: is the data the same as before? It holds counts, fingerprints and technical
metadata (environment, project ref, commit, time, configuration version). It never holds a row: no names, emails,
phones, notes, answers or tokens. `snapshotProblems` (`snapshot/capture.mjs`) accepts a document only if every field
is one it knows and every value has the shape it expects, both before it is written and when it is read back.

`snapshot/tables.json` says what is covered: each table with its schema, its mode (`fingerprint` or `count`) and the
key that identifies a row. `auth.users` is only counted. A column is left out of a fingerprint only with a reason
written next to it; `created_at` and `updated_at` are not left out by default. Tables that are not snapshotted are
listed under `ignored`, each with its reason, and a table of `public` or `private` that is in neither list shows up
as a warning in every snapshot.

The fingerprint of a table (`snapshot/build-sql.mjs`): each row becomes JSONB minus the excluded columns and is
hashed with SHA-256; each hash is cut into four 60-bit numbers and each of the four is added up over the table; the
row count and the four sums are hashed once more. Adding gives the same result in any order, so the fingerprint
cannot depend on the order rows come back in, and nothing is concatenated. The declared key is checked on every
capture (never null, never repeated). Every capture also asks the database to fingerprint a few made-up rows four
ways (as they are, reordered, with one field changed, with only an excluded column changed) and is refused unless
the results behave as they must.

Taking a snapshot:

- `--env staging` (default) or `--env production`. The CLI has to be on that project already, confirmed with the
  account's list; the command never links. The SQL is a `read only` transaction in UTC that ends in `ROLLBACK`.
- It is saved as `<release folder>/snapshot-<label>.json`. An existing label is not overwritten without `--replace`.
  `--output <file>` writes a copy somewhere else, never inside the repository.
- It fails closed: a target in doubt, an invalid configuration, a table or a column that does not exist, a key that
  repeats, a fingerprint that is not a hash.

Comparing: `--compare <a> <b>` takes two labels of `--release`, or two files. The two have to be of the same
environment and the same configuration; then every table has to have the same count, the same fingerprint and the
same columns. Any difference is exit 1. What is shown is which tables differ and their counts, never a hash or a
row. There is no list of expected differences yet.

Background jobs keep running while a release does: the hourly automations (minute 5), the expiry of stale booking
requests (every 15 minutes) and the hourly plan expirations (minute 20) can change data between two snapshots for
reasons that have nothing to do with the release. A difference in those tables is still a failure, to be looked at.

## Schema drift (`drift/`)

`drift/schema.sql` reads PostgreSQL's catalogs in a read-only transaction with an empty search path (so every name
comes out in full) and returns, for `public` and `private`: schemas and their grants, tables (columns in order, type,
nullability, default, identity, generated, collation, column grants, row-level security, owner, grants), constraints,
indexes, policies, functions (arguments, result, language, volatility, security, leakproof, parallel, strictness,
settings such as search_path, owner, body, grants), views (definition, options such as security_invoker, owner,
grants), triggers, enums, domains and composite types, sequences, default privileges; the triggers on `auth`'s
tables that call a function of ours; the extensions the migrations install (`btree_gist`, `pg_cron`; their version is
kept as information and not compared, since the platform updates it); the pg_cron jobs named `bellis-*`; and the
list of applied migrations. Objects that belong to an extension are left out. No row of a table of the product is
read, and `auth.users` is never read. Owners are compared because a `security definer` function or a view runs with
its owner's rights.

Each object is kept with a SHA-256 of its normalized definition, whole and attribute by attribute, computed from
what the database said; the definition itself is kept with anything that looks like a credential removed, only to
be shown. What is normalized is written at the top of `drift/capture.mjs`: line endings; whitespace in the code of
function bodies, views and cron commands (never inside strings, quoted names, dollar-quoted text or comments); the
order of lists that have none (grants, policy roles, function settings, options). The order of columns and of enum
values, letter case and comments are not normalized.

**Exact** (`--compare`): after the same migrations, staging and production must be identical. Each difference is
shown as `ADDED`, `REMOVED` or `CHANGED` with the category, the object and, for a change, which attributes differ.
`--verbose` shows both sides of each attribute, redacted and cut short.

**Expected** (before production): what the migrations change is measured, not guessed from their text.

1. `--rehearse` (staging, before the migrations are applied there): captures `base`, runs the release's migrations
   (from `releases/<id>.json`, by name, hash and order) in one transaction that captures `expected` and is rolled
   back, checks with PostgreSQL that it was aborted, and captures again to check the schema is still `base`. It
   refuses a migration that cannot be rehearsed safely (CONCURRENTLY, VACUUM, extensions, ALTER SYSTEM, COPY,
   `setval`, `dblink`, outside requests, session locks, transaction control), with exit 4, before sending anything.
2. Apply the migrations to staging, then `--capture` staging and production.
3. `--expected`: production must equal `base` (otherwise it is drift), staging must equal `expected` (otherwise
   staging has something the migrations do not explain), the migration files must be the ones rehearsed, and the
   versions staging has and production lacks must be exactly those of the release. Without a rehearsal it is exit 4.

Captures are kept in the release's folder as `schema-<label>.json`. Nothing here links the CLI or writes to
production, and the rehearsal refuses anything but staging.

## Exit codes

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | `PASS` | Everything that was asked was checked and is fine. |
| 1 | `CHECK_FAILED` | A check ran and failed. Nothing was written to production. |
| 2 | `PRECONDITION_OR_USAGE` | The command could not start: bad arguments, a missing tool, a step not available yet. |
| 3 | `TARGET_NOT_CONFIRMED` | The environment could not be confirmed, or the CLI could not be left on staging. Stop and look. |
| 4 | `HUMAN_ACTION_REQUIRED` | Something only a person can do is missing: a backup, an approval, a login. |
| 5 | `FAILURE_AFTER_PROD_WRITE` | Something failed after production was written. The report says how far it got. |

They are defined once, in `lib/report.mjs`.

## Report

Always these sections, in this order; a stage with nothing to say prints `N/A`:

`## TARGET` · `## GIT` · `## MIGRATIONS` · `## DRIFT` · `## SNAPSHOT` · `## SMOKES` · `## DEPLOY` · `## CLI FINAL TARGET` · `## RESULT`

## The core (`lib/`)

- `target.mjs`: which project a command is about to touch. `withTarget(supabase, env, fn)` links, reads the ref
  back, checks the account's list of projects, runs `fn`, links back to staging and confirms it. Any doubt stops
  everything before `fn` runs. The refs come from `scripts/assert-staging-env.mjs`: there is one list of them.
- `supabase.mjs`: the only place that runs the Supabase CLI. No shell, and its output is never printed: each call
  returns named fields, and a failure is one redacted line.
- `git.mjs`: reads the repository (clean tree, branch, commits, whether `main` could fast-forward, the link folder
  not tracked). It never fetches, pushes, commits or moves a branch.
- `state.mjs`: what a release remembers between commands, outside the repository. Atomic writes; credentials refused.
- `report.mjs`: exit codes, errors, redaction and the report.

## Decisions

- **Backups.** Made by a person, never by the tooling. The validation (phase 4) will require the `public` and
  `private` schemas. `auth` and `vault` are not covered: explicit debt.
- **Vercel Preview.** Protected by Vercel SSO. No bypass token and no new secret: a protected Preview is reported
  as `HUMAN VERIFICATION REQUIRED` (exit 4).
- **Release state.** `C:\Users\<user>\Bellis-Releases\<release-id>\`, or `BELLIS_RELEASES_DIR`. Never inside the
  repository; `releases/` holds versioned manifests only.
- **Branch `staging`.** Legacy, deprecated. Nothing here reads it or depends on it: the tooling works against an
  explicit commit or branch. It has not been deleted.
- **Supabase CLI.** Not a dependency of the project: it is found in the npx cache (or wherever `BELLIS_SUPABASE_CLI`
  points). The version is not pinned: known debt.
- **`supabase/.temp/`.** The CLI's link state. Ignored by git, and `git.mjs` fails if it is ever tracked.

## Tests

`tests/release-*.mjs`, with a fake CLI (`tests/fixtures/fake-supabase.mjs`). They never reach Supabase. The SQL smokes
are a different thing and are never run by `npm test`.
