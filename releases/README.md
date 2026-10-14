# releases/

One versioned manifest per release: what it contains (commit, migrations, functions, smokes) and nothing else.

Only manifests live here. What a release produces while it runs (reports, data snapshots, the result of a precheck) is written outside the repository, in `C:\Users\<user>\Bellis-Releases\<release-id>\` (or wherever `BELLIS_RELEASES_DIR` says), and the tooling refuses a state folder inside the repository.

Each manifest is releases/<release-id>.json, checked strictly by scripts/release/lib/manifest.mjs (fields: releaseId, sourceCommit, expectedMainBase, migrations, smokeGroups, previewRequired, createdAt, and optionally branch and notes). See scripts/release/README.md.
