/**
 * H3.1B: one privacy-minimal Google event for one Bellis appointment.
 *
 * This module knows Google's reconciliation rules but nothing about HTTP callers or Supabase rows. The worker passes
 * claimed jobs and records the result through a store, which keeps the network call outside the booking transaction.
 */

import {
  getValidGoogleAccessToken,
  GoogleOAuthError,
  type Clock,
  type GoogleConnectionStore,
  type GoogleOAuthConfig,
} from "./google-calendar-oauth.ts";

export const googleEventSummary = "Turno Bellis";
export const maxEventGeneration = 8;
const maxReconciliationSteps = 24;

export type GoogleCalendarSyncAction = "upsert" | "delete";
export type GoogleCalendarSyncOutcome = "created" | "updated" | "deleted" | "reconciled";
export type GoogleCalendarSyncJob = {
  id: string;
  appointmentId: string;
  professionalId: string;
  calendarId: string;
  eventId: string | null;
  generation: number;
  desiredAction: GoogleCalendarSyncAction;
  desiredRevision: number;
  startsAt: string;
  endsAt: string;
  timeZone: string;
};
export type GoogleCalendarSyncResult = {
  outcome: GoogleCalendarSyncOutcome;
  eventId: string | null;
  generation: number;
};

export type GoogleCalendarSyncStore = {
  complete(job: GoogleCalendarSyncJob, result: GoogleCalendarSyncResult): Promise<void>;
  fail(job: GoogleCalendarSyncJob, errorCode: string, retryable: boolean): Promise<void>;
};

type Fetch = typeof fetch;
type GoogleEvent = { id?: unknown; status?: unknown };

export class GoogleCalendarSyncError extends Error {
  retryable: boolean;
  refreshAccessToken: boolean;
  constructor(code: string, { retryable = false, refreshAccessToken = false } = {}) {
    super(code);
    this.retryable = retryable;
    this.refreshAccessToken = refreshAccessToken;
  }
}

/** Google accepts base32hex ids. A UUID without hyphens uses only 0-9/a-f, so the deterministic form is valid. */
export function googleEventId(appointmentId: string, generation: number): string {
  const normalized = appointmentId.toLowerCase().replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/.test(normalized) || !Number.isSafeInteger(generation) || generation < 0 || generation > maxEventGeneration)
    throw new GoogleCalendarSyncError("invalid_event_identity");
  return `bellis${normalized}g${generation}`;
}

/** No patient data enters this object. Empty optional fields make that guarantee explicit on every update. */
export function googleEventPayload(job: GoogleCalendarSyncJob, eventId: string) {
  if (!job.timeZone || job.timeZone.length > 64 || Number.isNaN(Date.parse(job.startsAt)) || Number.isNaN(Date.parse(job.endsAt))
    || Date.parse(job.endsAt) <= Date.parse(job.startsAt)) throw new GoogleCalendarSyncError("invalid_appointment_time");
  return {
    id: eventId,
    summary: googleEventSummary,
    description: "",
    location: "",
    attendees: [],
    visibility: "private",
    start: { dateTime: job.startsAt, timeZone: job.timeZone },
    end: { dateTime: job.endsAt, timeZone: job.timeZone },
    reminders: { useDefault: false },
    extendedProperties: { private: { bellisAppointmentId: job.appointmentId.replaceAll("-", ""), bellisGeneration: String(job.generation) } },
  };
}

const shortGoogleReason = async (response: Response) => {
  const body = await response.clone().json().catch(() => null) as { error?: { errors?: Array<{ reason?: unknown }> } } | null;
  const reason = body?.error?.errors?.[0]?.reason;
  return typeof reason === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(reason) ? reason : "";
};

async function googleError(response: Response): Promise<GoogleCalendarSyncError> {
  const reason = await shortGoogleReason(response);
  if (response.status === 401) return new GoogleCalendarSyncError("google_calendar_unauthorized", { refreshAccessToken: true });
  if (response.status === 408 || response.status === 429 || response.status >= 500
    || (response.status === 403 && /rateLimit|quota/i.test(reason)))
    return new GoogleCalendarSyncError(`google_calendar_http_${response.status}`, { retryable: true });
  return new GoogleCalendarSyncError(`google_calendar_http_${response.status}`);
}

async function request(fetchImpl: Fetch, url: string, accessToken: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", ...init.headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (caught) {
    const timeout = (caught as { name?: unknown } | null)?.name === "TimeoutError";
    throw new GoogleCalendarSyncError(timeout ? "google_calendar_timeout" : "google_calendar_unreachable", { retryable: true });
  }
}

function eventUrl(config: GoogleOAuthConfig, calendarId: string, eventId?: string) {
  const base = `${config.endpoints.calendar}/calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
}

async function readEvent(response: Response): Promise<"active" | "cancelled"> {
  const body = await response.json().catch(() => null) as GoogleEvent | null;
  if (!body || typeof body.id !== "string" || (body.status !== "confirmed" && body.status !== "tentative" && body.status !== "cancelled"))
    throw new GoogleCalendarSyncError("invalid_google_event_response", { retryable: true });
  return body.status === "cancelled" ? "cancelled" : "active";
}

/**
 * Reconciles one claimed row. GET-before-CREATE and GET-after-409 make uncertain responses idempotent. A cancelled
 * event id is a tombstone and is never reused: the deterministic generation advances, with a hard fail-closed cap.
 */
export async function syncGoogleCalendarEvent(
  config: GoogleOAuthConfig,
  job: GoogleCalendarSyncJob,
  accessToken: string,
  { fetch: fetchImpl = fetch, timeoutMs = 8000 }: Pick<Clock, "fetch" | "timeoutMs"> = {},
): Promise<GoogleCalendarSyncResult> {
  if (!job.calendarId || job.calendarId.length > 1024) throw new GoogleCalendarSyncError("google_calendar_missing");
  let generation = job.generation;
  let candidate = job.eventId ?? googleEventId(job.appointmentId, generation);

  if (job.desiredAction === "delete") {
    if (!job.eventId) return { outcome: "deleted", eventId: null, generation };
    const response = await request(fetchImpl, eventUrl(config, job.calendarId, job.eventId), accessToken, { method: "DELETE" }, timeoutMs);
    if (response.ok || response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => undefined);
      return { outcome: "deleted", eventId: job.eventId, generation };
    }
    throw await googleError(response);
  }

  for (let step = 0; step < maxReconciliationSteps; step++) {
    const found = await request(fetchImpl, eventUrl(config, job.calendarId, candidate), accessToken, { method: "GET" }, timeoutMs);
    if (found.ok) {
      const state = await readEvent(found);
      if (state === "cancelled") {
        generation += 1;
        if (generation > maxEventGeneration) throw new GoogleCalendarSyncError("google_event_generation_exhausted");
        candidate = googleEventId(job.appointmentId, generation);
        continue;
      }
      const payload = googleEventPayload({ ...job, generation }, candidate);
      const updated = await request(fetchImpl, eventUrl(config, job.calendarId, candidate), accessToken,
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, timeoutMs);
      if (updated.ok) {
        await readEvent(updated);
        return { outcome: job.eventId === candidate ? "updated" : "reconciled", eventId: candidate, generation };
      }
      // It was deleted between GET and UPDATE. The old id is now a tombstone; advance exactly as above.
      if (updated.status === 404 || updated.status === 410) {
        generation += 1;
        if (generation > maxEventGeneration) throw new GoogleCalendarSyncError("google_event_generation_exhausted");
        candidate = googleEventId(job.appointmentId, generation);
        continue;
      }
      if (updated.status === 409 || updated.status === 412) continue;
      throw await googleError(updated);
    }
    if (found.status === 410) {
      await found.body?.cancel().catch(() => undefined);
      generation += 1;
      if (generation > maxEventGeneration) throw new GoogleCalendarSyncError("google_event_generation_exhausted");
      candidate = googleEventId(job.appointmentId, generation);
      continue;
    }
    if (found.status !== 404) throw await googleError(found);
    await found.body?.cancel().catch(() => undefined);

    const payload = googleEventPayload({ ...job, generation }, candidate);
    const created = await request(fetchImpl, eventUrl(config, job.calendarId), accessToken,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, timeoutMs);
    if (created.ok) {
      const body = await created.json().catch(() => null) as GoogleEvent | null;
      if (body?.id !== candidate || body.status === "cancelled") throw new GoogleCalendarSyncError("invalid_google_event_response", { retryable: true });
      return { outcome: "created", eventId: candidate, generation };
    }
    // A prior uncertain INSERT can finish after Bellis timed out. Never call 409 success: loop back through GET.
    if (created.status === 409) continue;
    throw await googleError(created);
  }
  throw new GoogleCalendarSyncError("google_event_reconciliation_exhausted", { retryable: true });
}

/** Processes independently claimed jobs. One bad calendar/account cannot prevent the remaining rows from settling. */
export async function processGoogleCalendarSyncJobs(
  jobs: GoogleCalendarSyncJob[],
  store: GoogleCalendarSyncStore,
  connections: GoogleConnectionStore,
  config: GoogleOAuthConfig,
  clock: Clock = {},
): Promise<{ completed: number; retried: number; failed: number }> {
  const totals = { completed: 0, retried: 0, failed: 0 };
  for (const job of jobs) {
    try {
      let token = await getValidGoogleAccessToken(connections, config, job.professionalId, clock);
      let result: GoogleCalendarSyncResult;
      try {
        result = await syncGoogleCalendarEvent(config, job, token.accessToken, clock);
      } catch (caught) {
        if (!(caught instanceof GoogleCalendarSyncError) || !caught.refreshAccessToken) throw caught;
        token = await getValidGoogleAccessToken(connections, config, job.professionalId, { ...clock, force: true });
        result = await syncGoogleCalendarEvent(config, job, token.accessToken, clock);
      }
      await store.complete(job, result);
      totals.completed += 1;
    } catch (caught) {
      const permanentGrant = caught instanceof GoogleOAuthError && caught.permanent;
      const retryable = caught instanceof GoogleCalendarSyncError ? caught.retryable
        : caught instanceof GoogleOAuthError ? !caught.permanent : true;
      const code = permanentGrant ? "google_needs_reconnect"
        : caught instanceof GoogleCalendarSyncError || caught instanceof GoogleOAuthError ? caught.message : "google_calendar_sync_failed";
      await store.fail(job, /^[a-z0-9_]{1,64}$/.test(code) ? code : "google_calendar_sync_failed", retryable);
      if (retryable) totals.retried += 1; else totals.failed += 1;
    }
  }
  return totals;
}
