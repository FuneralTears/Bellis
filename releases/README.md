# releases/

One versioned manifest per release: what it contains (commit, migrations, functions, smokes) and nothing else.

Only manifests live here. What a release produces while it runs (reports, data snapshots, the result of a precheck) is written outside the repository, in `C:\Users\<user>\Bellis-Releases\<release-id>\` (or wherever `BELLIS_RELEASES_DIR` says), and the tooling refuses a state folder inside the repository.

No manifest exists yet. The one field already read is `migrations`: `[{ "file": "<name in supabase/migrations>", "sha256": "<hash of the file with Unix line endings>" }]`, which `bellis:smoke --with-pending ... --release <id>` checks.
