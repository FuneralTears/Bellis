# Bellis development database

Supabase project: `pinfdbvfzoratsntjgah` (`sa-east-1`), created for Bellis on 27 September 2026. The SQL files in `migrations/` match the migration versions already applied to this project. Do not reapply them manually to this database.

The database currently has no professional account, tenant, patient, payment, appointment or questionnaire response data. The deployed public patient flow still uses sample data and does not send form responses to Supabase. Professional signup and `/mis-formularios` use Supabase Auth and store questionnaire configuration.

Before accepting real patient responses, allowlist the Bellis `/ingresar` URL in Supabase Auth URL Configuration, implement trusted rate-limited public questionnaire read and intake endpoints around the service-role-only write RPC, test tenant isolation with separate users, provide privacy notices and retention/deletion procedures, and connect payment confirmation before enabling scheduling. Keep service-role credentials server-side only.

The security advisor currently reports only informational `rls_enabled_no_policy` findings for server-only tables. These tables intentionally have no client policies; review the [advisor guidance](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) when adding server workflows.
