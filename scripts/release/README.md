# Bellis release tooling

One entry point, `scripts/release/cli.mjs`. Every command ends with the same report and an exit code that says
whether to go on.

## Commands

| Command | What it does | Touches |
| --- | --- | --- |
| `npm run bellis:status` | Where things are: linked project, repository, local migrations. | Nothing. Reads local files. |
| `npm run bellis:status -- --remote` | The same, and confirms the link with the account's list of projects. | One read-only request. |
| `npm run bellis:check-core` | The tooling's own guardrails, and a rehearsal of the target guard against a simulated CLI. | Nothing. No request is sent. |
| `npm test` | Every unit test of the repository (`scripts/run-tests.mjs`). | Nothing. The SQL smokes are not run from here. |

Add `-- --json` to get the report as JSON.

`check`, `staging`, `prod-precheck` and `prod-release` are **not available yet** and answer with exit 2. Nothing in
this folder links the CLI to production, applies a migration, deploys or moves a branch today.

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

`tests/release-*.mjs`, with a fake CLI (`tests/fixtures/fake-supabase.mjs`). They never reach Supabase.
