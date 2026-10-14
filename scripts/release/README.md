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
| `npm test` | Every unit test of the repository (`scripts/run-tests.mjs`). | Nothing. The SQL smokes are not run from here. |

Add `-- --json` to get the report as JSON. `bellis:smoke` also takes `--only <id...>`, `--all` and `--ndjson` (one JSON
event per line, the report last).

`check`, `staging`, `prod-precheck` and `prod-release` are **not available yet** and answer with exit 2. Nothing in
this folder links the CLI to production, applies a migration, deploys or moves a branch today.

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
