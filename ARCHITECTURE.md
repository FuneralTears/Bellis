# Bellis: implementation boundary

The deployed experience is a visual, interactive prototype. It uses sample data only. Registration, payments, booking and notifications do **not** write data or perform real transactions.

## Argentina-first defaults

The MVP market configuration is `country=AR`, `currency=ARS`, `timezone=America/Argentina/Buenos_Aires`, `locale=es-AR`, and `payment_provider=mercado_pago_ar`. These are workspace defaults, not universal constants. Prices are stored in minor units together with a currency code; timestamps are stored as `timestamptz` and displayed in the workspace timezone. The UI uses Argentine pesos, 24-hour times, Argentine phone examples and "turno" terminology. Province and city are separate fields, so the experience does not assume Buenos Aires.

## Production path

- Frontend: React/TypeScript UI. Connect a new Supabase project using server-side environment values; do not expose the service role key.
- Identity: Supabase Auth for professional users. Create workspace and owner membership atomically in a trusted function after signup. Keep `/admin` behind a separate server-side Super Admin allowlist.
- Storage: apply `supabase/migrations/202609260001_bellis_core.sql` and then `supabase/migrations/202609270001_intelligent_preconsultation.sql`. The second migration models one active progressive questionnaire per service, four internal sections, ordered questions and intent-bound answers. Its RLS permits staff reads according to role and denies browser writes to answers. Review and test policies against a real Supabase project before use. Do not store clinical notes or diagnosis by default.
- Preconsultation: the current professional builder and patient flow are browser demonstrations. The builder holds changes in memory, and the patient flow holds answers in memory; neither writes to Supabase. A trusted API must validate the current question version and answers, create or locate the patient, create the booking intent, and insert answers in one transaction before initiating payment. A public questionnaire read endpoint should expose only active questions and visible section labels, with rate limits and no patient answers. Preserve historical question wording when forms are edited after responses arrive.
- Public patient flow: use a limited Edge Function for public profile/forms, another to create an intent and payment order, a signed webhook to confirm payment, and a short-lived intent-bound token for slot selection. Never trust browser payment state.
- External payment links create only a pending order. A redirect back from the external checkout is insufficient proof of payment. Enable scheduling only after a trusted provider callback or an authorized verification process.
- Booking: compute slots in the professional timezone, account for breaks, holidays, notice and buffer, then recheck at commit. The PostgreSQL exclusion constraint enforces the final no-overlap rule. The RPC locks the intent and checks an approved payment.
- Notifications: write confirmation and reminder jobs to an outbox in the same transaction as appointment creation. Dispatch email first; WhatsApp and SMS can implement the same interface later.
- Privacy: define data retention, export/deletion flow, access logging, encryption strategy, and jurisdiction-specific notices before using real patient responses. Trial and subscription billing are separate from patient payments.

## Gaps before live use

Supabase project and credentials, trusted questionnaire API, Mercado Pago application and webhook secret, email provider, production domain, privacy/terms, and legal review for sensitive health information. The current `/profesional/ana-lopez`, `/demo` and `/admin` routes contain fictitious sample data; they are not connected to real tenants.
