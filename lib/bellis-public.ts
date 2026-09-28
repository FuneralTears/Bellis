import type { Questionnaire, QuestionnaireAnswers } from "./questionnaires/model";
import type { PatientDraft } from "@/app/profesional/ana-lopez/questionnaire-flow";

type PublicConfig = { url: string; publishableKey: string };
let configPromise: Promise<PublicConfig> | null = null;
function config() {
  if (!configPromise) configPromise = fetch("/api/supabase-config", { cache: "no-store" })
    .then((response) => { if (!response.ok) throw new Error("Bellis no está disponible"); return response.json(); });
  return configPromise;
}
export type PublicService = { id: string; name: string; description: string | null; price_minor: number; currency_code: string; duration_minutes: number; modality: string; can_checkout: boolean };
export type PublicProfile = {
  professional: { display_name: string; specialty: string; biography: string | null; province: string | null; city: string | null; address: string | null; offers_online: boolean; offers_in_person: boolean; public_slug: string };
  services: PublicService[];
  questionnaires: Record<string, Questionnaire>;
  market: { timezone: string; currency: string; locale: string };
  canCheckout: boolean;
};

export async function publicRequest<T>(action: string, options: { method?: "GET" | "POST"; body?: unknown; token?: string; params?: Record<string, string> } = {}): Promise<T> {
  const { url, publishableKey } = await config();
  const endpoint = new URL(`${url}/functions/v1/bellis-public`);
  endpoint.searchParams.set("action", action);
  for (const [key, value] of Object.entries(options.params ?? {})) endpoint.searchParams.set(key, value);
  const response = await fetch(endpoint, {
    method: options.method ?? "GET",
    headers: { apikey: publishableKey, ...(options.body ? { "content-type": "application/json" } : {}), ...(options.token ? { "x-bellis-intent": options.token } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "No pudimos completar la solicitud");
  return result;
}

export function submittedAnswers(answers: QuestionnaireAnswers) {
  return Object.entries(answers).map(([question_id, answer]) => ({ question_id, answer }));
}
export type CheckoutInput = { serviceId: string; patient: PatientDraft; answers: ReturnType<typeof submittedAnswers> };
