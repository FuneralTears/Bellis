import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import {
  processGoogleCalendarSyncJobs,
  type GoogleCalendarSyncJob,
  type GoogleCalendarSyncResult,
} from "../_shared/google-calendar-events.ts";
import { googleOAuthConfigFromEnv, supabaseGoogleConnectionStore } from "../_shared/google-calendar-oauth.ts";
import { logEvent } from "../_shared/payment-errors.ts";

const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } });
const connections = supabaseGoogleConnectionStore(db);
const config = googleOAuthConfigFromEnv((name) => Deno.env.get(name), Deno.env.get("BELLIS_SITE_ORIGIN") ?? "");
const configuredSecret = Deno.env.get("GOOGLE_CALENDAR_SYNC_SECRET") ?? "";
const log = (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}) =>
  logEvent("bellis-google-calendar-sync", level, event, fields);

const encode = (value: string) => new TextEncoder().encode(value);
async function secretMatches(candidate: string) {
  if (configuredSecret.length < 32 || candidate.length !== configuredSecret.length) return false;
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode(candidate)),
    crypto.subtle.digest("SHA-256", encode(configuredSecret)),
  ]);
  const left = new Uint8Array(actual), right = new Uint8Array(expected);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

const firstErrorCode = (error: unknown) => {
  const value = String((error as { message?: unknown } | null)?.message ?? "database_error");
  return /^[a-z0-9_]{1,64}$/.test(value) ? value : "database_error";
};

function rowToJob(row: Record<string, unknown>): GoogleCalendarSyncJob {
  return {
    id: String(row.id ?? ""), appointmentId: String(row.appointment_id ?? ""),
    professionalId: String(row.professional_id ?? ""), calendarId: String(row.calendar_id ?? ""),
    eventId: typeof row.event_id === "string" ? row.event_id : null,
    generation: Number(row.generation), desiredAction: row.desired_action === "delete" ? "delete" : "upsert",
    desiredRevision: Number(row.desired_revision), startsAt: String(row.starts_at ?? ""),
    endsAt: String(row.ends_at ?? ""), timeZone: String(row.time_zone ?? ""),
  };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  if (!await secretMatches(request.headers.get("x-bellis-sync-secret") ?? "")) {
    log("warn", "sync_refused", { status: "unauthorized" });
    return new Response("Unauthorized", { status: 401 });
  }
  if (!config.clientId || !config.clientSecret) {
    log("error", "config_missing", { error_code: "google_config_missing" });
    return Response.json({ error: "not_configured" }, { status: 503 });
  }

  const lease = crypto.randomUUID();
  const { data, error } = await db.rpc("claim_google_calendar_event_sync", { p_lease_token: lease, p_limit: 25 });
  if (error) {
    log("error", "sync_claim_failed", { error_code: firstErrorCode(error) });
    return Response.json({ error: "claim_failed" }, { status: 500 });
  }
  const jobs = (Array.isArray(data) ? data : []).map((row) => rowToJob(row as Record<string, unknown>));
  const store = {
    complete: async (job: GoogleCalendarSyncJob, result: GoogleCalendarSyncResult) => {
      const { error: completeError } = await db.rpc("complete_google_calendar_event_sync", {
        p_id: job.id, p_lease_token: lease, p_revision: job.desiredRevision, p_outcome: result.outcome,
        p_event_id: result.eventId, p_generation: result.generation,
      });
      if (completeError) throw new Error(firstErrorCode(completeError));
    },
    fail: async (job: GoogleCalendarSyncJob, errorCode: string, retryable: boolean) => {
      const { error: failError } = await db.rpc("fail_google_calendar_event_sync", {
        p_id: job.id, p_lease_token: lease, p_revision: job.desiredRevision,
        p_error_code: errorCode, p_retryable: retryable,
      });
      if (failError) throw new Error(firstErrorCode(failError));
    },
  };
  try {
    const totals = await processGoogleCalendarSyncJobs(jobs, store, connections, config);
    log(totals.failed ? "warn" : "info", "sync_batch_completed", { status: "completed", count: jobs.length,
      completed: totals.completed, retry: totals.retried, failed: totals.failed });
    return Response.json({ claimed: jobs.length, ...totals });
  } catch (caught) {
    // No appointment, calendar, token or account identifiers enter logs. Claimed leases recover after 90 seconds.
    log("error", "sync_batch_failed", { error_code: firstErrorCode(caught), count: jobs.length });
    return Response.json({ error: "sync_failed" }, { status: 500 });
  }
});
