import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { createMercadoPagoCheckout, mercadoPagoAccount, recordVerifiedPayment, withSellerAccount } from "../_shared/bellis-payment.ts";
import { ExternalPaymentLinkProvider } from "../_shared/mercado-pago.ts";
import { getValidMercadoPagoAccessToken, oauthConfigFromEnv, supabaseConnectionStore, type ValidAccount } from "../_shared/mercado-pago-oauth.ts";
import { checkoutReturnOrigin, configuredOrigins, isAllowedOrigin } from "../_shared/origin-policy.ts";
import { checkoutReturnUrls, newResumeToken, resumeAnswer, resumeTokenPattern } from "../_shared/bellis-return.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } },
);
const siteOrigin = Deno.env.get("BELLIS_SITE_ORIGIN") ?? "https://bellis-agenda.pint-solutio-0057.chatgpt.site";
const allowedOrigins = configuredOrigins(siteOrigin, Deno.env.get("BELLIS_ADDITIONAL_ORIGINS") ?? "");
// Seller tokens are read, and renewed when they are about to expire, only here on the server.
const connections = supabaseConnectionStore(db);
const oauth = oauthConfigFromEnv((name) => Deno.env.get(name), siteOrigin);
const paymentUnavailable = "No pudimos iniciar el pago en este momento. Intentá nuevamente más tarde.";
/** Short code for the log. Never a token, a request body or what Mercado Pago answered. */
const reason = (caught: unknown) => caught instanceof Error ? caught.message.slice(0, 60) : "unknown";

function cors(request: Request) {
  const origin = request.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": isAllowedOrigin(origin, allowedOrigins) ? origin : siteOrigin,
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
  // The request is reached with the token its first tab holds, or with the one that came back from the checkout.
  const { data } = await db.from("booking_intents")
    .select("id,workspace_id,professional_id,service_id,patient_id,status,price_minor,currency_code,duration_minutes,expires_at")
    .or(`access_token_hash.eq.${hash},resume_token_hash.eq.${hash}`).maybeSingle();
  if (!data || new Date(data.expires_at).getTime() < Date.now()) return null;
  return data;
}
type Intent = NonNullable<Awaited<ReturnType<typeof getIntent>>>;
/** Asks Mercado Pago whether the request has been paid and records what it verifies. A slow or failed answer leaves it pending. */
async function reconcile(intent: Intent) {
  const { data: stored } = await db.from("payments").select("status,provider,provider_order_id")
    .eq("booking_intent_id", intent.id).maybeSingle();
  if (stored?.provider !== "mercado_pago_ar" || !stored.provider_order_id || stored.status === "approved") return;
  try {
    const account = await getValidMercadoPagoAccessToken(connections, oauth, intent.workspace_id);
    const matches = await withSellerAccount(connections, intent.workspace_id, account, (provider) => provider.findPayments(intent.id));
    const selected = matches.filter((item) => item.preferenceId === stored.provider_order_id)
      .sort((a, b) => Number(b.status === "approved") - Number(a.status === "approved"))[0];
    if (selected) await recordVerifiedPayment(db, intent, account, selected, `status:${selected.id}:${selected.status}`);
  } catch { /* A delayed provider response leaves the order pending. */ }
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
  const mercadoPagoReady = workspace.payment_provider === "mercado_pago_ar" &&
    !!Deno.env.get("MERCADO_PAGO_WEBHOOK_SECRET") &&
    !!await mercadoPagoAccount(db, workspace.id);
  const externalReady = workspace.payment_provider === "external_link";
  return json(request, {
    professional: { ...professional, workspace_id: undefined, id: undefined },
    services: (services ?? []).map(({ external_payment_url, ...item }) => ({ ...item,
      can_checkout: mercadoPagoReady || (externalReady && !!(external_payment_url || workspace.external_payment_url)) })), questionnaires,
    market: { timezone: workspace.timezone, currency: workspace.currency_code.trim(), locale: workspace.locale },
    canCheckout: mercadoPagoReady || externalReady,
    paymentFlow: mercadoPagoReady
      ? { guidance: "Pagá con Mercado Pago. Cuando confirme el pago, vas a poder elegir un horario.",
          actionLabel: "Abrir Mercado Pago", confirmationLabel: "Confirmado por Mercado Pago" }
      : { guidance: "Pagá en el enlace configurado por el profesional. Después verificará el cobro para habilitar los horarios.",
          actionLabel: "Abrir enlace de pago", confirmationLabel: "Registrado por el profesional" },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  const origin = request.headers.get("origin");
  if (origin && !isAllowedOrigin(origin, allowedOrigins))
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
      // With Mercado Pago, make sure the workspace's own account has a usable token before creating anything.
      // The workspace comes from the service stored on the server, never from the request.
      const { data: target } = await db.from("services").select("workspace_id").eq("id", body.serviceId).maybeSingle();
      const { data: method } = target
        ? await db.from("workspaces").select("payment_provider").eq("id", target.workspace_id).maybeSingle() : { data: null };
      let account: ValidAccount | null = null;
      if (target && method?.payment_provider === "mercado_pago_ar") {
        try {
          if (!Deno.env.get("MERCADO_PAGO_WEBHOOK_SECRET")) throw new Error("webhook_secret_missing");
          account = await getValidMercadoPagoAccessToken(connections, oauth, target.workspace_id);
        } catch (caught) {
          console.warn(`bellis-public checkout unavailable: ${reason(caught)}`);
          return json(request, { error: paymentUnavailable }, 503);
        }
      }
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
      const { data: intent } = await db.from("booking_intents")
        .select("id,workspace_id,service_id,professional_id,price_minor,currency_code,expires_at").eq("id", intentId).single();
      if (!intent) throw new Error("intent_unavailable");
      const [{ data: workspace }, { data: service }, { data: professional }] = await Promise.all([
        db.from("workspaces").select("payment_provider,external_payment_url").eq("id", intent.workspace_id).single(),
        db.from("services").select("name,external_payment_url").eq("id", intent.service_id).single(),
        db.from("professionals").select("public_slug").eq("id", intent.professional_id).single(),
      ]);
      if (!workspace || !service || !professional) throw new Error("checkout_unavailable");
      if (workspace.payment_provider === "external_link") {
        const checkout = await new ExternalPaymentLinkProvider(service.external_payment_url || workspace.external_payment_url || "")
          .createCheckout({ intentId: intent.id });
        return json(request, { token, checkoutUrl: checkout.redirectUrl });
      }
      if (workspace.payment_provider !== "mercado_pago_ar" || !account || intent.workspace_id !== target?.workspace_id)
        throw new Error("checkout_unavailable");
      try {
        // Amount, currency and service come from the stored request; the seller is the workspace's own account.
        // The return address carries only the slug and an opaque token for this request.
        const resumeToken = newResumeToken();
        const returnOrigin = checkoutReturnOrigin(origin, siteOrigin, allowedOrigins);
        const checkoutUrl = await createMercadoPagoCheckout(connections, account, {
          intentId: intent.id, workspaceId: intent.workspace_id, serviceId: intent.service_id, title: service.name,
          amountMinor: intent.price_minor, currency: intent.currency_code, expiresAt: intent.expires_at,
          returnUrl: `${returnOrigin}/p/${professional.public_slug}`,
          returnUrls: checkoutReturnUrls(returnOrigin, professional.public_slug, resumeToken),
          notificationUrl: `${Deno.env.get("SUPABASE_URL")}/functions/v1/bellis-mp-webhook?intent=${intent.id}`,
        }, async (preferenceId, redirectUrl) => {
          const { error: attachError } = await db.rpc("attach_mercado_pago_checkout", {
            p_intent: intent.id, p_preference: preferenceId, p_checkout_url: redirectUrl, p_resume_hash: await sha256(resumeToken),
          });
          if (attachError) throw new Error("checkout_not_saved");
        }, async (intentId) => { await db.rpc("cancel_unpaid_intent", { p_intent: intentId }); });
        return json(request, { token, checkoutUrl });
      } catch (caught) {
        console.warn(`bellis-public checkout failed: ${reason(caught)}`);
        return json(request, { error: paymentUnavailable }, 503);
      }
    }
    if (action === "resume" && request.method === "POST") {
      if (!await limit(request, action, 60, 10)) return json(request, { error: "Intentá nuevamente más tarde" }, 429);
      const body = await request.json().catch(() => null) as { resume?: unknown; slug?: unknown } | null;
      const resume = typeof body?.resume === "string" && resumeTokenPattern.test(body.resume) ? body.resume : "";
      const slug = typeof body?.slug === "string" ? body.slug : "";
      // Who the request belongs to, what it costs and whether it is paid all come from the stored request.
      const { data: found } = resume ? await db.from("booking_intents")
        .select("id,workspace_id,professional_id,service_id,patient_id,status,price_minor,currency_code,duration_minutes,expires_at")
        .eq("resume_token_hash", await sha256(resume)).maybeSingle() : { data: null };
      const { data: owner } = found ? await db.from("professionals").select("public_slug").eq("id", found.professional_id).maybeSingle() : { data: null };
      if (!found || !owner || owner.public_slug !== slug) return json(request, { error: "No pudimos recuperar esta reserva.", code: "invalid" }, 404);
      if (found.status === "pending_payment" && new Date(found.expires_at).getTime() > Date.now()) await reconcile(found);
      const [{ data: latest }, { data: payment }, { data: service }, { data: appointment }] = await Promise.all([
        db.from("booking_intents").select("status,expires_at,price_minor,currency_code,duration_minutes,service_id").eq("id", found.id).single(),
        db.from("payments").select("status,checkout_url").eq("booking_intent_id", found.id).maybeSingle(),
        db.from("services").select("name,modality").eq("id", found.service_id).maybeSingle(),
        db.from("appointments").select("starts_at,ends_at").eq("booking_intent_id", found.id).maybeSingle(),
      ]);
      const answer = resumeAnswer(latest && service ? { intent: latest, slug: owner.public_slug, service, payment, appointment } : null, slug, Date.now());
      return answer.ok ? json(request, answer.body) : json(request, answer.body, answer.status);
    }
    if (["status", "slots", "book"].includes(action)) {
      if (!await limit(request, action, action === "book" ? 15 : 120, 10))
        return json(request, { error: "Intentá nuevamente más tarde" }, 429);
      const intent = await getIntent(request);
      if (!intent) return json(request, { error: "La solicitud venció o no existe" }, 404);
      if (action === "status" && request.method === "GET") {
        await reconcile(intent);
        const [{ data: latestIntent }, { data: payment }] = await Promise.all([
          db.from("booking_intents").select("status").eq("id", intent.id).single(),
          db.from("payments").select("status").eq("booking_intent_id", intent.id).maybeSingle(),
        ]);
        return json(request, { status: latestIntent?.status ?? intent.status, paymentStatus: payment?.status ?? "pending" });
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
