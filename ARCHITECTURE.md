# Bellis: implementation boundary

The deployed experience is a visual, interactive prototype. It uses sample data only. Registration, payments, booking and notifications do **not** write data or perform real transactions.

## Production path

- Frontend: React/TypeScript UI. Connect a new Supabase project using server-side environment values; do not expose the service role key.
- Identity: Supabase Auth for professional users. Create workspace and owner membership atomically in a trusted function after signup. Keep `/admin` behind a separate server-side Super Admin allowlist.
- Storage: apply `supabase/migrations/202609260001_bellis_core.sql`, review RLS with integration tests, and add field-level access controls for preconsultation answers. Do not store clinical notes or diagnosis by default.
- Public patient flow: use a limited Edge Function for public profile/forms, another to create an intent and payment order, a signed webhook to confirm payment, and a short-lived intent-bound token for slot selection. Never trust browser payment state.
- External payment links create only a pending order. A redirect back from the external checkout is insufficient proof of payment. Enable scheduling only after a trusted provider callback or an authorized verification process.
- Booking: compute slots in the professional timezone, account for breaks, holidays, notice and buffer, then recheck at commit. The PostgreSQL exclusion constraint enforces the final no-overlap rule. The RPC locks the intent and checks a confirmed payment.
- Notifications: write confirmation and reminder jobs to an outbox in the same transaction as appointment creation. Dispatch email first; WhatsApp and SMS can implement the same interface later.
- Privacy: define data retention, export/deletion flow, access logging, encryption strategy, and jurisdiction-specific notices before using real patient responses. Trial and subscription billing are separate from patient payments.

## Gaps before live use

Supabase project and credentials, Mercado Pago application and webhook secret, email provider, production domain, privacy/terms, and legal review for sensitive health information. The current `/profesional/ana-lopez` and `/admin` routes contain fictitious public sample data; they are not connected to real tenants.
