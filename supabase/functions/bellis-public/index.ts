import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const db = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } },
);
const siteOrigin = Deno.env.get("BELLIS_SITE_ORIGIN") ?? "https://bellis-agenda.pint-solutio-0057.chatgpt.site";

function cors(request: Request) {
  const origin = request.headers.get("origin") ?? "";
  const allowed = origin === siteOrigin || /^http:\/\/localhost:\d+$/.test(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : siteOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-bellis-intent, apikey, authorization",
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
}
function json(request: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors(request), "Content-Type": "application/json" } });
}
async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function limit(request: Request, action: string, max: number, windowMinutes: number) {
  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown";
  const fingerprint = await sha256(`${action}:${ip}`);
  const { data, error } = await db.rpc("consume_public_request_limit", {
    p_fingerprint: fingerprint, p_max: max, p_window_minutes: windowMinutes,
  });
  if (error) throw new Error("rate_limit_unavailable");
  return data === true;
}
async function getIntent(request: Request) {
  const token = request.headers.get("x-bellis-intent") ?? "";
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const hash = await sha256(token);
  const { data } = await db.from("booking_intents")
    .select("id,workspace_id,professional_id,service_id,patient_id,status,price_minor,currency_code,duration_minutes,expires_at")
    .eq("access_token_hash", hash).maybeSingle();
  if (!data || new Date(data.expires_at).getTime() < Date.now()) return null;
  return data;
}
async function profile(request: Request, slug: string) {
  if (!/^[a-z0-9-]{3,100}$/.test(slug)) return json(request, { error: "Perfil no encontrado" }, 404);
  const { data: professional, error } = await db.from("professionals")
    .select("id,workspace_id,display_name,specialty,biography,province,city,address,offers_online,offers_in_person,public_slug")
    .eq("public_slug", slug).eq("active", true).maybeSingle();
  if (error || !professional) return json(request, { error: "Perfil no encontrado" }, 404);
  const { data: workspace } = await db.from("workspaces")
    .select("id,name,timezone,currency_code,locale,status,trial_ends_at,payment_provider,external_payment_url")
    .eq("id", professional.workspace_id).single();
  if (!workspace || workspace.status === "suspended" ||
    (workspace.status === "trial" && new Date(workspace.trial_ends_at).getTime() < Date.now()))
    return json(request, { error: "Esta agenda no está disponible" }, 404);
  const { data: services, error: serviceError } = await db.from("services")
    .select("id,name,description,price_minor,currency_code,duration_minutes,modality,external_payment_url")
    .eq("workspace_id", professional.workspace_id).eq("professional_id", professional.id).eq("active", true)
    .order("created_at");
  if (serviceError) throw serviceError;
  const serviceIds = (services ?? []).map((item) => item.id);
  const { data: forms } = serviceIds.length ? await db.from("questionnaires")
    .select("id,service_id,title").in("service_id", serviceIds).eq("active", true) : { data: [] };
  const formIds = (forms ?? []).map((item) => item.id);
  const [sectionResult, questionResult, conditionResult] = formIds.length ? await Promise.all([
    db.from("questionnaire_sections").select("questionnaire_id,section_key,visible_name,sort_order").in("questionnaire_id", formIds),
    db.from("questionnaire_questions").select("id,questionnaire_id,section_key,title,description,type,options,required,sort_order,active").in("questionnaire_id", formIds),
    db.from("questionnaire_conditions").select("id,questionnaire_id,target_question_id,question_id,operator,value,action").in("questionnaire_id", formIds),
  ]) : [{ data: [] }, { data: [] }, { data: [] }];
  const questionnaires = Object.fromEntries((forms ?? []).map((form) => [form.service_id, {
    id: form.id, serviceId: form.service_id, title: form.title,
    sections: (sectionResult.data ?? []).filter((item) => item.questionnaire_id === form.id)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((item) => ({ key: item.section_key, label: item.visible_name, order: item.sort_order })),
    questions: (questionResult.data ?? []).filter((item) => item.questionnaire_id === form.id)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((item) => ({ id: item.id, section: item.section_key, title: item.title, description: item.description ?? "",
        type: item.type, options: item.options, required: item.required, order: item.sort_order, active: item.active,
        conditions: (conditionResult.data ?? []).filter((rule) => rule.target_question_id === item.id)
          .map((rule) => ({ id: rule.id, questionId: rule.question_id, operator: rule.operator, value: rule.value, action: rule.action })) })),
  }]));
  return json(request, {
    professional: { ...professional, workspace_id: undefined, id: undefined },
    services: (services ?? []).map(({ external_payment_url, ...item }) => ({ ...item,
      can_checkout: workspace.payment_provider === "external_link" && !!(external_payment_url || workspace.external_payment_url) })), questionnaires,
    market: { timezone: workspace.timezone, currency: workspace.currency_code.trim(), locale: workspace.locale },
    canCheckout: workspace.payment_provider === "external_link",
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  const origin = request.headers.get("origin");
  if (origin && origin !== siteOrigin && !/^http:\/\/localhost:\d+$/.test(origin))
    return json(request, { error: "Origen no permitido" }, 403);
  const action = new URL(request.url).searchParams.get("action") ?? "";
  try {
    if (action === "profile" && request.method === "GET") {
      if (!await limit(request, action, 120, 10)) return json(request, { error: "Intentá nuevamente más tarde" }, 429);
      return profile(request, new URL(request.url).searchParams.get("slug") ?? "");
    }
    if (action === "create_intent" && request.method === "POST") {
      if (!await limit(request, action, 8, 60)) return json(request, { error: "Intentá nuevamente más tarde" }, 429);
      if (Number(request.headers.get("content-length") ?? "0") > 100000) return json(request, { error: "Formulario demasiado grande" }, 413);
      const body = await request.json();
      if (!/^[a-f0-9-]{36}$/i.test(body.serviceId ?? "") || !Array.isArray(body.answers) || body.answers.length > 50)
        return json(request, { error: "Revisá los datos de la preconsulta" }, 400);
      const token = [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const { data: intentId, error } = await db.rpc("create_checkout_intent", {
        p_service: body.serviceId,
        p_first_name: body.patient?.firstName,
        p_last_name: body.patient?.lastName,
        p_email: body.patient?.email,
        p_phone: body.patient?.phone,
        p_answers: body.answers,
        p_token_hash: await sha256(token),
      });
      if (error) return json(request, { error: "No pudimos crear la solicitud. Revisá el formulario y que el cobro esté configurado." }, 400);
      const { data: intent } = await db.from("booking_intents").select("workspace_id,service_id").eq("id", intentId).single();
      const [{ data: workspace }, { data: service }] = await Promise.all([
        db.from("workspaces").select("external_payment_url").eq("id", intent.workspace_id).single(),
        db.from("services").select("external_payment_url").eq("id", intent.service_id).single(),
      ]);
      return json(request, { token, checkoutUrl: service?.external_payment_url || workspace?.external_payment_url });
    }
    if (["status", "slots", "book"].includes(action)) {
      if (!await limit(request, action, action === "book" ? 15 : 120, 10))
        return json(request, { error: "Intentá nuevamente más tarde" }, 429);
      const intent = await getIntent(request);
      if (!intent) return json(request, { error: "La solicitud venció o no existe" }, 404);
      if (action === "status" && request.method === "GET") {
        const { data: payment } = await db.from("payments").select("status").eq("booking_intent_id", intent.id).maybeSingle();
        return json(request, { status: intent.status, paymentStatus: payment?.status ?? "pending" });
      }
      if (intent.status !== "awaiting_schedule" && intent.status !== "payment_confirmed" && action !== "book")
        return json(request, { error: "El pago todavía no está confirmado" }, 403);
      if (action === "slots" && request.method === "GET") {
        const day = new URL(request.url).searchParams.get("day") ?? "";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(request, { error: "Fecha inválida" }, 400);
        const { data, error } = await db.rpc("available_slots_for_intent", { p_intent: intent.id, p_day: day });
        if (error) throw error;
        return json(request, { slots: [...new Set((data ?? []).map((item: { starts_at: string }) => item.starts_at))].sort() });
      }
      if (action === "book" && request.method === "POST") {
        const body = await request.json();
        if (typeof body.startsAt !== "string" || !Number.isFinite(Date.parse(body.startsAt)))
          return json(request, { error: "Elegí un horario válido" }, 400);
        if (intent.status === "scheduled") {
          const { data: existing } = await db.from("appointments").select("starts_at,ends_at").eq("booking_intent_id", intent.id).maybeSingle();
          return json(request, { appointment: existing });
        }
        const { data: appointmentId, error } = await db.rpc("schedule_paid_intent", {
          p_intent: intent.id, p_starts_at: body.startsAt,
        });
        if (error) return json(request, { error: "Ese horario ya no está disponible. Elegí otro." }, 409);
        const { data: appointment } = await db.from("appointments").select("starts_at,ends_at").eq("id", appointmentId).single();
        return json(request, { appointment });
      }
    }
    return json(request, { error: "Acción no disponible" }, 404);
  } catch {
    return json(request, { error: "No pudimos completar la solicitud. Intentá nuevamente." }, 500);
  }
});
