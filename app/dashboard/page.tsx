"use client";

import AppMobileNav from "@/components/layout/AppMobileNav";
import AppTopbar from "@/components/layout/AppTopbar";
import { dashboardSections, navItems, profileTabFromQuery, profileTabs, type NavKey, type ProfileSectionTab } from "@/components/layout/AppNav";
import { Tabs } from "@/components/crm/CrmUi";
import AgendaCalendar, { AgendaDetails } from "@/components/agenda/AgendaCalendar";
import BookingPreferences, { type BookingPreferencesValue } from "@/components/agenda/BookingPreferences";
import { ManualAppointmentForm, type ManualAppointmentInput, type ManualPatient, type ManualProfessional, type ManualService } from "@/components/agenda/ManualAppointmentForm";
import { canCancelAppointment, canRecordPayment, chargeLabel, describeCancelError, describePaymentError, type CancelArgs, type PaymentMethod as OfflineMethod } from "@/lib/manual-appointment";
import { CancelManualAppointment } from "@/components/agenda/CancelManualAppointment";
import { RecordOfflinePayment } from "@/components/payments/RecordOfflinePayment";
import type { NewPatientValues } from "@/components/crm/NewPatientForm";
import { createManualPatient, lookupPatientDuplicates } from "../pacientes/manual-patient";
import BellisLogo from "@/components/brand/BellisLogo";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, CalendarDays, Clock3, CreditCard, LogOut, Plus, Users } from "lucide-react";
import { getSupabase } from "@/lib/supabase/browser";
import PaymentSettings, { LatePayments, PendingPayments, mercadoPagoReturnNotice, type MercadoPagoConnection, type PaymentMethod, type PaymentNotice } from "@/components/payments/PaymentSettings";
import { disconnectMercadoPago, mercadoPagoAccess, startMercadoPagoConnection } from "@/lib/mercado-pago";
import { latePayments } from "@/lib/late-payments";
import { landingRouteForUser } from "@/lib/auth/navigation";
import { formatDateTime, formatMoney } from "@/lib/market";
import OpportunitySummary from "./OpportunitySummary";
import AutomationSummary from "./AutomationSummary";
import NotificationBell from "../components/NotificationBell";
import "../demo/demo.css";
import "../mis-formularios/forms.css";
import "./live.css";
import "../pacientes/crm.css";
import "../pacientes/crm-phase2.css";

type Section = "Resumen" | "Agenda" | "Pacientes" | "Servicios" | "Disponibilidad" | "Perfil";
type Service = { id: string; workspace_id: string; professional_id: string; name: string; description: string | null; price_minor: number; currency_code: string; duration_minutes: number; modality: string; min_notice_minutes: number; external_payment_url: string | null; active: boolean };
type Appointment = { id: string; booking_intent_id: string; patient_id: string; service_id?: string; starts_at: string; ends_at: string; status: string };
type Patient = { id: string; first_name: string; last_name: string; email: string | null; phone: string | null; created_at: string };
type Intent = { id: string; service_id: string; patient_id: string; status: string; price_minor: number; currency_code: string; created_at: string; expires_at: string; /** 'manual' when the practice loaded the appointment itself. */ source: string };
type Payment = { id: string; booking_intent_id: string; provider: string; /** Only for charges recorded by the practice (provider 'offline'). */ method: string | null; amount_minor: number; currency_code: string; status: string; manual_reference: string | null; approved_at: string | null };
type Answer = { booking_intent_id: string; question_title: string; section_label: string; answer: unknown };
type Rule = { id: string; weekday: number; starts_at: string; ends_at: string; buffer_minutes: number };
type Block = { id: string; starts_at: string; ends_at: string; reason: string | null };
type Workspace = { id: string; name: string; timezone: string; currency_code: string; locale: string; payment_provider: string; external_payment_url: string | null; status: string; trial_ends_at: string };
type Professional = { id: string; workspace_id: string; display_name: string; specialty: string; biography: string | null; public_slug: string; province: string | null; city: string | null; address: string | null; offers_online: boolean; offers_in_person: boolean; slot_interval_minutes: number; max_appointments_per_day: number | null };
type Data = { workspace: Workspace; professional: Professional; services: Service[]; appointments: Appointment[]; patients: Patient[]; intents: Intent[]; payments: Payment[]; answers: Answer[]; rules: Rule[]; blocks: Block[]; /** When this was read, to tell open requests from ones that ran out of time. */ loadedAt: number };
const sections: Section[] = [...dashboardSections, "Pacientes"];
const weekdayNames = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const blankService = { name: "", description: "", price: "", duration: "60", modality: "online", notice: "24", paymentUrl: "" };

async function loadData(): Promise<Data> {
  const client = await getSupabase();
  const { data: auth, error: authError } = await client.auth.getUser();
  if (authError || !auth.user) throw new Error("Tu sesión venció. Volvé a ingresar.");
  if (await landingRouteForUser(client, auth.user.id) === "/onboarding") throw new Error("onboarding_required");
  const { data: professional, error: profileError } = await client.from("professionals")
    .select("id,workspace_id,display_name,specialty,biography,public_slug,province,city,address,offers_online,offers_in_person,slot_interval_minutes,max_appointments_per_day")
    .eq("user_id", auth.user.id).limit(1).maybeSingle();
  if (profileError || !professional) throw new Error("No encontramos tu espacio profesional.");
  const workspaceId = professional.workspace_id;
  const results = await Promise.all([
    client.from("workspaces").select("id,name,timezone,currency_code,locale,payment_provider,external_payment_url,status,trial_ends_at").eq("id", workspaceId).single(),
    client.from("services").select("*").eq("workspace_id", workspaceId).eq("professional_id", professional.id).order("created_at"),
    client.from("appointments").select("id,booking_intent_id,patient_id,starts_at,ends_at,status").eq("workspace_id", workspaceId).order("starts_at", { ascending: false }).limit(300),
    client.from("patients").select("id,first_name,last_name,email,phone,created_at").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(300),
    client.from("booking_intents").select("id,service_id,patient_id,status,price_minor,currency_code,created_at,expires_at,source").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(300),
    client.from("payments").select("id,booking_intent_id,provider,method,amount_minor,currency_code,status,manual_reference,approved_at").eq("workspace_id", workspaceId).limit(300),
    client.from("questionnaire_answers").select("booking_intent_id,question_title,section_label,answer").eq("workspace_id", workspaceId).limit(500),
    client.from("availability_rules").select("id,weekday,starts_at,ends_at,buffer_minutes").eq("professional_id", professional.id).order("weekday"),
    client.from("availability_blocks").select("id,starts_at,ends_at,reason").eq("professional_id", professional.id).order("starts_at"),
  ]);
  for (const result of results) if (result.error) throw result.error;
  return { workspace: results[0].data as Workspace, professional: professional as Professional,
    services: results[1].data as Service[] ?? [], appointments: results[2].data as Appointment[] ?? [],
    patients: results[3].data as Patient[] ?? [], intents: results[4].data as Intent[] ?? [],
    loadedAt: Date.now(), payments: results[5].data as Payment[] ?? [], answers: results[6].data as Answer[] ?? [],
    rules: results[7].data as Rule[] ?? [], blocks: results[8].data as Block[] ?? [] };
}

export default function LiveDashboard() {
  const [data, setData] = useState<Data | null>(null);
  const [section, setSection] = useState<Section>("Resumen");
  const [profileTab, setProfileTab] = useState<ProfileSectionTab>("perfil");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [serviceForm, setServiceForm] = useState(blankService);
  const [editingService, setEditingService] = useState<string | null>(null);
  const [selectedAppointment, setSelectedAppointment] = useState<string | null>(null);
  const [selectedPatient, setSelectedPatient] = useState<string | null>(null);
  const [calendarView, setCalendarView] = useState<"Día" | "Semana" | "Mes">("Semana");
  const [payAccess, setPayAccess] = useState<{ canManage: boolean; connection: MercadoPagoConnection }>({ canManage: false, connection: { status: "loading" } });
  const [payNotice, setPayNotice] = useState<PaymentNotice | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [profileForm, setProfileForm] = useState({ display_name: "", specialty: "", biography: "", province: "", city: "", address: "", offers_online: true, offers_in_person: false });
  const [weekly, setWeekly] = useState<{ weekday: number; enabled: boolean; starts_at: string; ends_at: string; buffer_minutes: number }[]>([]);
  const [bookingPrefs, setBookingPrefs] = useState<BookingPreferencesValue>({ slotInterval: 30, maxPerDay: null });
  // "Nuevo turno": the agendas and services this person can load. Null while the form is closed.
  const [manual, setManual] = useState<{ professionals: ManualProfessional[]; services: ManualService[] } | null>(null);
  const [blockDay, setBlockDay] = useState("");
  const [blockReason, setBlockReason] = useState("");
  useEffect(() => { loadData().then((result) => { setData(result); const query = new URLSearchParams(window.location.search); if (query.has("mp")) { /* Feedback only: the real state comes from the status below. */ setPayNotice(mercadoPagoReturnNotice(query.get("mp"))); const kept = new URLSearchParams(query); kept.delete("mp"); window.history.replaceState(null, "", `${window.location.pathname}?${kept}`); } mercadoPagoAccess(result.workspace.id).then(setPayAccess); const requested = query.get("section"); const requestedTab = profileTabFromQuery(requested, query.get("tab")); if (requestedTab) { setSection("Perfil"); setProfileTab(requestedTab); } else if (requested && sections.includes(requested as Section)) setSection(requested as Section); setProfileForm({ display_name: result.professional.display_name, specialty: result.professional.specialty, biography: result.professional.biography ?? "", province: result.professional.province ?? "", city: result.professional.city ?? "", address: result.professional.address ?? "", offers_online: result.professional.offers_online, offers_in_person: result.professional.offers_in_person }); setBookingPrefs({ slotInterval: result.professional.slot_interval_minutes, maxPerDay: result.professional.max_appointments_per_day }); setWeekly(Array.from({ length: 7 }, (_, weekday) => { const rule = result.rules.find((item) => item.weekday === weekday); return { weekday, enabled: !!rule, starts_at: rule?.starts_at.slice(0, 5) ?? "09:00", ends_at: rule?.ends_at.slice(0, 5) ?? "18:00", buffer_minutes: rule?.buffer_minutes ?? 15 }; })); }).catch((caught) => { if (caught.message === "onboarding_required") window.location.replace("/onboarding"); else if (String(caught.message).includes("sesión")) window.location.replace("/ingresar"); else setError(caught.message); }); }, []);
  const refresh = async () => { const next = await loadData(); setData(next); return next; };
  const action = async (work: () => Promise<void>, success: string) => { setBusy(true); setError(""); setNotice(""); try { await work(); await refresh(); setNotice(success); } catch (caught) { setError(caught instanceof Error ? caught.message : "No pudimos guardar los cambios."); } finally { setBusy(false); } };
  const market = data ? { country: "AR", currency: data.workspace.currency_code.trim(), timezone: data.workspace.timezone, locale: data.workspace.locale, paymentProvider: data.workspace.payment_provider } : undefined;
  const money = (minor: number) => formatMoney(minor / 100, market);
  const date = (value: string) => formatDateTime(value, market);
  const patientById = (id: string) => data?.patients.find((item) => item.id === id);
  const intentById = (id: string) => data?.intents.find((item) => item.id === id);
  const paymentByIntent = (id: string) => data?.payments.find((item) => item.booking_intent_id === id);
  const serviceById = (id: string) => data?.services.find((item) => item.id === id);
  const appointment = data?.appointments.find((item) => item.id === selectedAppointment);
  const patient = data?.patients.find((item) => item.id === selectedPatient);
  const nowDate = new Intl.DateTimeFormat("en-CA", { timeZone: data?.workspace.timezone ?? "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const dayOf = (instant: string) => new Intl.DateTimeFormat("en-CA", { timeZone: data?.workspace.timezone ?? "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
  const todayAppointments = data?.appointments.filter((item) => dayOf(item.starts_at) === nowDate) ?? [];
  const revenue = data?.payments.filter((item) => item.status === "approved").reduce((sum, item) => sum + item.amount_minor, 0) ?? 0;
  const upcoming = data?.appointments.filter((item) => item.status === "scheduled" && new Date(item.starts_at) >= new Date()).sort((a, b) => a.starts_at.localeCompare(b.starts_at)) ?? [];
  const visibleAppointments = useMemo(() => { if (!data) return []; const now = new Date(); const start = calendarView === "Día" ? nowDate : calendarView === "Semana" ? new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10) : now.toISOString().slice(0, 7); return data.appointments.filter((item) => calendarView === "Día" ? dayOf(item.starts_at) === start : calendarView === "Mes" ? dayOf(item.starts_at).startsWith(start) : dayOf(item.starts_at) >= start).sort((a, b) => a.starts_at.localeCompare(b.starts_at)); }, [calendarView, data, nowDate]);
  const saveService = () => action(async () => { if (!data) return; const client = await getSupabase(); const price = Number(serviceForm.price); if (!serviceForm.name.trim() || !Number.isFinite(price) || price <= 0) throw new Error("Completá el nombre y un precio válido."); const payload = { workspace_id: data.workspace.id, professional_id: data.professional.id, name: serviceForm.name.trim(), description: serviceForm.description.trim(), price_minor: Math.round(price * 100), currency_code: data.workspace.currency_code, duration_minutes: Number(serviceForm.duration), modality: serviceForm.modality, min_notice_minutes: Number(serviceForm.notice) * 60, external_payment_url: serviceForm.paymentUrl.trim() || null, active: true }; const result = editingService ? await client.from("services").update(payload).eq("id", editingService).eq("workspace_id", data.workspace.id) : await client.from("services").insert(payload); if (result.error) throw result.error; setServiceForm(blankService); setEditingService(null); }, "Servicio guardado.");
  const toggleService = (item: Service) => action(async () => { const client = await getSupabase(); const result = await client.from("services").update({ active: !item.active }).eq("id", item.id).eq("workspace_id", item.workspace_id); if (result.error) throw result.error; }, item.active ? "Servicio desactivado." : "Servicio activado.");
  const saveWeekly = () => action(async () => { if (!data) return; const client = await getSupabase(); const { error: rpcError } = await client.rpc("save_weekly_availability", { p_professional: data.professional.id, p_rules: weekly.filter((item) => item.enabled).map(({ weekday, starts_at, ends_at, buffer_minutes }) => ({ weekday, starts_at, ends_at, buffer_minutes })) }); if (rpcError) throw rpcError; }, "Disponibilidad actualizada.");
  // Frequency of the offered start times and the daily maximum. Neither is the duration nor the buffer.
  const saveBookingPrefs = () => action(async () => { if (!data) return; const client = await getSupabase(); const { data: updated, error: updateError } = await client.from("professionals").update({ slot_interval_minutes: bookingPrefs.slotInterval, max_appointments_per_day: bookingPrefs.maxPerDay }).eq("id", data.professional.id).eq("workspace_id", data.workspace.id).select("id"); if (updateError) throw updateError; if (!updated?.length) throw new Error("No tenés permiso para cambiar esta agenda."); }, "Preferencias de reserva actualizadas.");
  const workspaceId = data?.workspace.id ?? "";
  // Owner and admin load turns for any professional of the workspace; everyone else, only for their own agenda.
  const openManual = async () => { if (!data) return; setError(""); setNotice(""); try { const client = await getSupabase(); const { data: auth } = await client.auth.getUser(); const [member, professionals, services] = await Promise.all([
      client.from("workspace_members").select("role").eq("workspace_id", data.workspace.id).eq("user_id", auth.user?.id ?? "").maybeSingle(),
      client.from("professionals").select("id,display_name").eq("workspace_id", data.workspace.id).eq("active", true).order("display_name"),
      client.from("services").select("id,professional_id,name,duration_minutes,price_minor").eq("workspace_id", data.workspace.id).eq("active", true).order("name")]);
    if (professionals.error || services.error) throw new Error("load");
    const manager = member.data?.role === "owner" || member.data?.role === "admin";
    const allowed = (professionals.data ?? []).filter((item) => manager || item.id === data.professional.id);
    const agendas = allowed.length ? allowed : [{ id: data.professional.id, display_name: data.professional.display_name }];
    setManual({ professionals: agendas, services: (services.data ?? []).filter((item) => agendas.some((agenda) => agenda.id === item.professional_id)) });
  } catch { setError("No pudimos abrir el formulario de turno. Intentá de nuevo."); } };
  const searchManualPatients = useCallback(async (query: string): Promise<ManualPatient[]> => {
    // Nothing typed reaches the filter with its own syntax; a phone is also looked up by its digits alone.
    const safe = query.replace(/[(),%*"\\]/g, " ").trim(); if (!safe || !workspaceId) return [];
    const digits = safe.replace(/\D/g, "");
    const client = await getSupabase();
    const { data: rows, error: searchError } = await client.from("patient_crm_overview").select("id,full_name,phone,email").eq("workspace_id", workspaceId)
      .or([`full_name.ilike.%${safe}%`, `email.ilike.%${safe}%`, `phone.ilike.%${safe}%`, ...(digits.length >= 4 ? [`phone.ilike.%${digits}%`] : [])].join(",")).order("created_at", { ascending: false }).limit(8);
    if (searchError) throw searchError;
    return (rows ?? []) as ManualPatient[];
  }, [workspaceId]);
  const createQuickPatient = async (values: NewPatientValues): Promise<ManualPatient> => ({ id: await createManualPatient(workspaceId, values), full_name: `${values.firstName} ${values.lastName}`, phone: values.phone, email: values.email });
  const loadManualSlots = async (professionalId: string, serviceId: string, day: string) => { const client = await getSupabase(); const { data: rows, error: slotsError } = await client.rpc("manual_available_slots", { p_professional: professionalId, p_service: serviceId, p_day: day }); if (slotsError) throw slotsError; return ((rows ?? []) as { starts_at: string }[]).map((row) => row.starts_at); };
  // The server checks the role, the patient, the service and the time again, and creates everything in one transaction. No email is sent.
  const createManual = async (input: ManualAppointmentInput) => { const client = await getSupabase(); const { data: created, error: createError } = await client.rpc("create_manual_appointment", { p_professional: input.professional.id, p_patient: input.patient.id, p_service: input.service.id, p_starts_at: input.startsAt, p_payment_method: input.method, p_amount_minor: input.amountMinor });
    if (createError || !created) throw new Error(createError?.message ?? "unknown");
    setManual(null); await refresh(); setCalendarView("Semana"); setSelectedAppointment(created as string); setNotice("Turno creado."); };
  // A charge made outside Bellis on a turn the practice loaded. The server allows one payment per turn; if someone
  // recorded it first, the agenda is reloaded so the button is no longer offered.
  const recordPayment = async (appointmentId: string, method: OfflineMethod, amountMinor: number) => { setError(""); setNotice(""); const client = await getSupabase();
    const { error: payError } = await client.rpc("record_offline_payment", { p_appointment: appointmentId, p_method: method, p_amount_minor: amountMinor });
    if (payError) { if (describePaymentError(payError.message).alreadyPaid) await refresh(); throw new Error(payError.message); }
    await refresh(); setNotice("Cobro registrado."); };
  // Cancels a turn the practice loaded, charging it or not, in one server operation. If it changed meanwhile
  // (already cancelled, or its charge was recorded first), the agenda is reloaded to show what is true now.
  const cancelManual = async (appointmentId: string, args: CancelArgs) => { setError(""); setNotice(""); const client = await getSupabase();
    const { error: cancelError } = await client.rpc("cancel_manual_appointment", { p_appointment: appointmentId, p_mode: args.mode, p_payment_method: args.method, p_amount_minor: args.amountMinor });
    if (cancelError) { if (describeCancelError(cancelError.message).reload) await refresh(); throw new Error(cancelError.message); }
    await refresh(); setNotice(args.mode === "record_payment" ? "Turno cancelado. El cobro quedó registrado." : "Turno cancelado. El horario volvió a quedar libre."); };
  const addBlock = () => action(async () => { if (!data || !blockDay) return; const client = await getSupabase(); const { error: rpcError } = await client.rpc("block_professional_day", { p_professional: data.professional.id, p_day: blockDay, p_reason: blockReason }); if (rpcError) throw rpcError; setBlockDay(""); setBlockReason(""); }, "Día bloqueado.");
  const removeBlock = (id: string) => action(async () => { if (!data) return; const client = await getSupabase(); const { error: deleteError } = await client.from("availability_blocks").delete().eq("id", id).eq("workspace_id", data.workspace.id); if (deleteError) throw deleteError; }, "Bloqueo eliminado.");
  const payAction = async (work: () => Promise<void>, success: string, failure: (message: string) => string) => { setBusy(true); setPayNotice(null); try { await work(); const next = await refresh(); setPayAccess(await mercadoPagoAccess(next.workspace.id)); setPayNotice({ tone: "success", text: success }); } catch (caught) { setPayNotice({ tone: "error", text: failure(String((caught as { message?: unknown } | null)?.message ?? "")) }); } finally { setBusy(false); } };
  // The database refuses Mercado Pago as the method while no account is connected; the message is a short code that picks the wording.
  const savePaymentMethod = (method: PaymentMethod, url: string) => payAction(async () => { if (!data) return; const client = await getSupabase(); const { error: updateError } = await client.from("workspaces").update(method === "mercado_pago_ar" ? { payment_provider: "mercado_pago_ar" } : { payment_provider: "external_link", external_payment_url: url.trim() || null }).eq("id", data.workspace.id); if (updateError) throw updateError; },
    method === "mercado_pago_ar" ? "Listo: tus pacientes van a pagar con Mercado Pago." : "Link de pago guardado.",
    (message) => message.includes("mercado_pago_not_connected") ? "Primero conectá tu cuenta de Mercado Pago." : message.includes("invalid_payment_link") ? "Revisá el link: tiene que empezar con https://" : "No pudimos guardar el método de cobro. Intentá nuevamente.");
  const connectMercadoPago = async () => { setConnecting(true); setPayNotice(null); try { window.location.assign(await startMercadoPagoConnection()); } catch { setPayNotice({ tone: "error", text: "No pudimos iniciar la conexión con Mercado Pago. Intentá nuevamente." }); setConnecting(false); } };
  const disconnectPayments = () => payAction(async () => { if (data) await disconnectMercadoPago(data.workspace.id); }, data?.workspace.payment_provider === "mercado_pago_ar" && data.workspace.external_payment_url ? "Mercado Pago quedó desconectado. Tus pacientes vuelven a pagar con tu link de pago." : "Mercado Pago quedó desconectado.", () => "No pudimos desconectar Mercado Pago. Intentá nuevamente.");
  const approvePayment = (intentId: string, reference: string) => action(async () => { const client = await getSupabase(); const { error: rpcError } = await client.rpc("confirm_external_payment", { p_intent: intentId, p_reference: reference }); if (rpcError) throw rpcError; }, "Pago registrado. El paciente ya puede elegir horario.");
  const saveProfile = () => action(async () => { if (!data) return; const client = await getSupabase(); const { error: updateError } = await client.from("professionals").update(profileForm).eq("id", data.professional.id).eq("workspace_id", data.workspace.id); if (updateError) throw updateError; }, "Perfil actualizado.");
  const signOut = async () => { const client = await getSupabase(); const { error: signOutError } = await client.auth.signOut(); if (signOutError) { setError("No pudimos cerrar la sesión. Intentá nuevamente."); return; } setData(null); window.location.replace("/ingresar"); };
  // Same list the old Cobros section showed; now also the badge on Perfil → Cobros y pagos.
  // Requests still open and waiting for a payment. One that ran out of time can no longer be paid or approved.
  const openPending = data?.intents.filter((item) => item.status === "pending_payment" && paymentByIntent(item.id)?.status === "pending" && Date.parse(item.expires_at) > data.loadedAt) ?? [];
  // Only payments through an external link wait for the professional; Mercado Pago confirms its own.
  const pendingPayments = openPending.filter((item) => paymentByIntent(item.id)?.provider === "external_link");
  const pendingMercadoPago = openPending.filter((item) => paymentByIntent(item.id)?.provider === "mercado_pago_ar").length;
  // Approved by Mercado Pago after the request closed: money received with no appointment, for the professional to review.
  const late = data ? latePayments(data.intents, data.payments) : [];
  const local = Object.fromEntries(dashboardSections.map((name) => [name, () => { setSection(name); setError(""); setNotice(""); }])) as Partial<Record<NavKey, () => void>>;
  return <div className="demo-shell bellis-phase-a"><aside className="demo-sidebar"><Link className="brand" href="/"><BellisLogo /></Link><div className="workspace-label">MI ESPACIO</div><div className="workspace-card"><span className="workspace-avatar">{data?.professional.display_name.slice(0, 2).toUpperCase() ?? "B"}</span><span><b>{data?.professional.display_name ?? "Cargando…"}</b><small>{data?.professional.specialty ?? "Profesional"}</small></span></div><nav aria-label="Panel profesional">{navItems({ active: section, variant: "sidebar", local })}</nav><div className="demo-side-bottom">{data && <a href={`/p/${data.professional.public_slug}`} target="_blank" rel="noreferrer">Ver página pública <ArrowRight size={16}/></a>}<button onClick={signOut}><LogOut size={16}/> Cerrar sesión</button></div></aside><div className="demo-content"><AppTopbar breadcrumb={section}><NotificationBell workspaceId={data?.workspace.id ?? null}/>{data && <a className="demo-top-link" href={`/p/${data.professional.public_slug}`} target="_blank" rel="noreferrer">Ver mi página pública <ArrowRight size={16}/></a>}{data && <button className="app-user" onClick={() => setSection("Perfil")} aria-label="Ver mi perfil"><span className="app-user-avatar">{data.professional.display_name.slice(0, 1).toUpperCase()}</span><span className="app-user-name">{data.professional.display_name.split(" ")[0]}</span></button>}</AppTopbar><AppMobileNav activeKey={section}>{navItems({ active: section, variant: "mobile", local })}{data && <a href={`/p/${data.professional.public_slug}`} target="_blank" rel="noreferrer">Página pública <ArrowRight size={14}/></a>}<button onClick={signOut}><LogOut size={14}/> Cerrar sesión</button></AppMobileNav><main className={section === "Resumen" ? "demo-main bellis-dashboard" : section === "Agenda" ? "demo-main bellis-agenda" : "demo-main"}>
    {!data ? <div className="demo-panel live-state" role={error ? "alert" : "status"}>{error || "Cargando tus datos…"}{error && <a href="/ingresar">Ingresar</a>}</div> : <>{section !== "Agenda" && <div className="demo-title-row"><div>{section !== "Resumen" && <p className="demo-date">ESPACIO PROFESIONAL · ARGENTINA</p>}<h1>{section === "Resumen" ? `Hola, ${data.professional.display_name.split(" ")[0]}` : section}</h1><p>{section === "Resumen" ? "Acá tenés un resumen de tu consulta." : "Gestioná tu consultorio desde acá."}</p></div>{section === "Resumen" && <span className="dashboard-date"><CalendarDays size={16}/>{new Intl.DateTimeFormat(data.workspace.locale, { timeZone: data.workspace.timezone, day: "numeric", month: "long" }).format(new Date())}</span>}</div>}{error && <p className="live-error" role="alert">{error}</p>}{notice && <p className="live-success" role="status">{notice}</p>}
      {section === "Resumen" && <>
        <div className="metric-grid">
          {[
            { label: "Turnos de hoy", value: todayAppointments.length, detail: "Agendados para hoy", Icon: CalendarDays, tone: "coral" },
            { label: "Ingresos cobrados", value: money(revenue), detail: "Pagos aprobados · total cargado", Icon: CreditCard, tone: "sage" },
            { label: "Pacientes registrados", value: data.patients.length, detail: "En tu consultorio · total cargado", Icon: Users, tone: "blue" },
            { label: "Próximos turnos", value: upcoming.length, detail: "Reservas programadas", Icon: Clock3, tone: "lilac" },
          ].map(({ label, value, detail, Icon, tone }) => <section className="demo-panel live-metric" key={label}><div className="live-metric-head"><span>{label}</span><span className={`metric-icon ${tone}`}><Icon size={17}/></span></div><strong>{value}</strong><small>{detail}</small></section>)}
        </div>
        <div className="dashboard-primary-grid">
          <section className="demo-panel dashboard-appointments"><div className="panel-head"><h2>Próximos turnos</h2><button onClick={() => setSection("Agenda")}>Ver agenda <ArrowRight size={15}/></button></div>
            {upcoming.length ? upcoming.slice(0, 6).map((item) => <button className="appt-row" key={item.id} onClick={() => { setSelectedAppointment(item.id); setSection("Agenda"); }}><span className="appt-time"><b>{new Intl.DateTimeFormat(data.workspace.locale, { timeZone: data.workspace.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(item.starts_at))}</b><small>{new Intl.DateTimeFormat(data.workspace.locale, { timeZone: data.workspace.timezone, day: "numeric", month: "short" }).format(new Date(item.starts_at))}</small></span><span className="appt-details"><b>{patientById(item.patient_id)?.first_name} {patientById(item.patient_id)?.last_name}</b><small>{serviceById(intentById(item.booking_intent_id)?.service_id ?? "")?.name}</small></span><span className="status paid">Confirmado</span></button>) : <p className="live-empty">Todavía no tenés turnos agendados.</p>}
          </section>
          <OpportunitySummary workspaceId={data.workspace.id}/>
        </div>
        <div className="dashboard-secondary-grid">
          <AutomationSummary workspaceId={data.workspace.id} timezone={data.workspace.timezone}/>
          <section className="demo-panel quick-panel"><div className="panel-head"><h2>Tu página de turnos</h2><ArrowRight size={16}/></div><p>Compartí este link con tus pacientes:</p><a className="live-link" href={`/p/${data.professional.public_slug}`} target="_blank" rel="noreferrer">{typeof window !== "undefined" ? window.location.origin : ""}/p/{data.professional.public_slug}</a><p className="dashboard-payment-state">{data.workspace.payment_provider === "external_link" && data.workspace.external_payment_url ? "El cobro externo está configurado." : "Configurá el cobro para habilitar reservas."}</p></section>
        </div>
      </>}
      {section === "Servicios" && <div className="live-grid"><section className="demo-panel"><div className="panel-head"><h2>Mis servicios</h2></div>{data.services.length ? data.services.map((item) => <div className="live-row" key={item.id}><div><b>{item.name}</b><small>{item.duration_minutes} minutos · {money(item.price_minor)} · {item.active ? "Activo" : "Inactivo"}</small></div><div><button onClick={() => { setEditingService(item.id); setServiceForm({ name: item.name, description: item.description ?? "", price: String(item.price_minor / 100), duration: String(item.duration_minutes), modality: item.modality, notice: String(item.min_notice_minutes / 60), paymentUrl: item.external_payment_url ?? "" }); }}>Editar</button><button disabled={busy} onClick={() => toggleService(item)}>{item.active ? "Desactivar" : "Activar"}</button></div></div>) : <p className="live-empty">Todavía no creaste servicios.</p>}</section><section className="demo-panel"><h2>{editingService ? "Editar servicio" : "Nuevo servicio"}</h2><div className="live-fields"><label>Nombre<input value={serviceForm.name} onChange={(event) => setServiceForm({ ...serviceForm, name: event.target.value })} /></label><label>Descripción<textarea value={serviceForm.description} onChange={(event) => setServiceForm({ ...serviceForm, description: event.target.value })} /></label><label>Precio en ARS<input type="number" min="1" value={serviceForm.price} onChange={(event) => setServiceForm({ ...serviceForm, price: event.target.value })} /></label><label>Duración en minutos<input type="number" min="15" max="480" value={serviceForm.duration} onChange={(event) => setServiceForm({ ...serviceForm, duration: event.target.value })} /></label><label>Modalidad<select value={serviceForm.modality} onChange={(event) => setServiceForm({ ...serviceForm, modality: event.target.value })}><option value="online">Online</option><option value="in_person">Presencial</option><option value="both">Ambas</option></select></label><label>Link de pago de este servicio<input type="url" placeholder="https://..." value={serviceForm.paymentUrl} onChange={(event) => setServiceForm({ ...serviceForm, paymentUrl: event.target.value })} /></label><label>Anticipación mínima (horas)<input type="number" min="0" max="720" value={serviceForm.notice} onChange={(event) => setServiceForm({ ...serviceForm, notice: event.target.value })} /></label></div><button className="demo-primary" disabled={busy} onClick={saveService}>Guardar servicio</button>{editingService && <button className="live-secondary" onClick={() => { setEditingService(null); setServiceForm(blankService); }}>Cancelar edición</button>}</section></div>}
      {section === "Disponibilidad" && <div className="live-grid"><section className="demo-panel"><h2>Horarios semanales</h2><p>Los espacios se calculan según duración, anticipación y pausa entre turnos.</p>{weekly.map((item, index) => <div className="live-rule" key={item.weekday}><label><input type="checkbox" checked={item.enabled} onChange={(event) => setWeekly(weekly.map((rule, i) => i === index ? { ...rule, enabled: event.target.checked } : rule))} /> {weekdayNames[item.weekday]}</label><input aria-label={`Inicio ${weekdayNames[item.weekday]}`} type="time" disabled={!item.enabled} value={item.starts_at} onChange={(event) => setWeekly(weekly.map((rule, i) => i === index ? { ...rule, starts_at: event.target.value } : rule))} /><input aria-label={`Fin ${weekdayNames[item.weekday]}`} type="time" disabled={!item.enabled} value={item.ends_at} onChange={(event) => setWeekly(weekly.map((rule, i) => i === index ? { ...rule, ends_at: event.target.value } : rule))} /><input aria-label={`Pausa en minutos ${weekdayNames[item.weekday]}`} type="number" min="0" max="240" disabled={!item.enabled} value={item.buffer_minutes} onChange={(event) => setWeekly(weekly.map((rule, i) => i === index ? { ...rule, buffer_minutes: Number(event.target.value) } : rule))} /></div>)}<button className="demo-primary" disabled={busy} onClick={saveWeekly}>Guardar horarios</button></section><section className="demo-panel"><h2>Días bloqueados</h2><div className="live-fields"><label>Fecha<input type="date" value={blockDay} onChange={(event) => setBlockDay(event.target.value)} /></label><label>Motivo<input value={blockReason} onChange={(event) => setBlockReason(event.target.value)} placeholder="Vacaciones, feriado, pausa…" /></label></div><button className="demo-primary" disabled={busy || !blockDay} onClick={addBlock}>Bloquear día</button>{data.blocks.length ? data.blocks.map((item) => <div className="live-row" key={item.id}><span>{date(item.starts_at)} — {date(item.ends_at)}</span><small>{item.reason}</small><button className="live-secondary" disabled={busy} onClick={() => removeBlock(item.id)}>Quitar</button></div>) : <p className="live-empty">No hay días bloqueados.</p>}<p>Horarios especiales disponibles próximamente.</p></section><BookingPreferences value={bookingPrefs} onChange={setBookingPrefs} onSave={saveBookingPrefs} busy={busy}/></div>}
      {section === "Agenda" && <>
        <AgendaCalendar view={calendarView} selectedId={selectedAppointment} onSelect={setSelectedAppointment}
          actions={<button className="demo-primary agenda-new" type="button" disabled={!!manual} onClick={() => void openManual()}><Plus size={16}/> Nuevo turno</button>}
          panel={manual && <ManualAppointmentForm professionals={manual.professionals} services={manual.services} timezone={data.workspace.timezone} locale={data.workspace.locale} today={nowDate} formatMoney={money}
            searchPatients={searchManualPatients} lookupDuplicates={(phone, email) => lookupPatientDuplicates(workspaceId, phone, email)} createPatient={createQuickPatient} loadSlots={loadManualSlots} onCreate={createManual} onCancel={() => setManual(null)}/>} todayLabel={new Intl.DateTimeFormat(data.workspace.locale, { timeZone: data.workspace.timezone, day: "numeric", month: "short", year: "numeric" }).format(new Date())} timezone={data.workspace.timezone}
          appointments={visibleAppointments.map((item) => ({
            id: item.id, dateKey: dayOf(item.starts_at),
            weekday: new Intl.DateTimeFormat(data.workspace.locale, { timeZone: data.workspace.timezone, weekday: "long" }).format(new Date(item.starts_at)),
            dateLabel: new Intl.DateTimeFormat(data.workspace.locale, { timeZone: data.workspace.timezone, day: "numeric", month: "short", year: "numeric" }).format(new Date(item.starts_at)),
            startTime: new Intl.DateTimeFormat(data.workspace.locale, { timeZone: data.workspace.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(item.starts_at)),
            endTime: new Intl.DateTimeFormat(data.workspace.locale, { timeZone: data.workspace.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(item.ends_at)),
            patient: [patientById(item.patient_id)?.first_name, patientById(item.patient_id)?.last_name].filter(Boolean).join(" "),
            service: serviceById(intentById(item.booking_intent_id)?.service_id ?? "")?.name,
            status: item.status, paid: paymentByIntent(item.booking_intent_id)?.status === "approved",
          }))}
          viewControls={(["Día", "Semana", "Mes"] as const).map((value) => <button key={value} className={calendarView === value ? "on" : ""} aria-pressed={calendarView === value} onClick={() => setCalendarView(value)}>{value}</button>)}
        />
        <AgendaDetails focusKey={selectedAppointment}>{appointment ? <><div className="live-detail"><b>{date(appointment.starts_at)}</b><p>{patientById(appointment.patient_id)?.first_name} {patientById(appointment.patient_id)?.last_name}</p><p>{[patientById(appointment.patient_id)?.email, patientById(appointment.patient_id)?.phone].filter(Boolean).join(" · ")}</p><p>{serviceById(intentById(appointment.booking_intent_id)?.service_id ?? "")?.name}</p>{appointment.status === "cancelled" && <p className="agenda-cancelled-line">Estado: <b>Cancelado</b></p>}<p>{appointment.status === "cancelled" ? "Cobro" : "Pago"}: {chargeLabel(paymentByIntent(appointment.booking_intent_id), appointment.status)}{paymentByIntent(appointment.booking_intent_id) && ` · ${money(paymentByIntent(appointment.booking_intent_id)!.amount_minor)}`}</p>
            {intentById(appointment.booking_intent_id)?.source === "manual" && <span className="agenda-manual-tag">Cargado manualmente</span>}
            {canRecordPayment({ source: intentById(appointment.booking_intent_id)?.source, appointmentStatus: appointment.status, hasPayment: !!paymentByIntent(appointment.booking_intent_id) }) && <RecordOfflinePayment key={appointment.id} priceMinor={intentById(appointment.booking_intent_id)?.price_minor ?? 0} formatMoney={money} onSave={(method, amountMinor) => recordPayment(appointment.id, method, amountMinor)}/>}
            {canCancelAppointment({ source: intentById(appointment.booking_intent_id)?.source, appointmentStatus: appointment.status }) && <CancelManualAppointment key={`cancel-${appointment.id}`} charge={paymentByIntent(appointment.booking_intent_id) ? `${chargeLabel(paymentByIntent(appointment.booking_intent_id))} · ${money(paymentByIntent(appointment.booking_intent_id)!.amount_minor)}` : null} priceMinor={intentById(appointment.booking_intent_id)?.price_minor ?? 0} formatMoney={money} onCancel={(args) => cancelManual(appointment.id, args)}/>}</div><h3>Preconsulta</h3>{!data.answers.some((item) => item.booking_intent_id === appointment.booking_intent_id) && <p className="live-empty">Sin respuestas de preconsulta.</p>}{data.answers.filter((item) => item.booking_intent_id === appointment.booking_intent_id).map((item, index) => <div className="live-answer" key={index}><small>{item.section_label}</small><b>{item.question_title}</b><p>{Array.isArray(item.answer) ? item.answer.join(", ") : String(item.answer)}</p></div>)}</> : <p className="live-empty">Seleccioná un turno para ver los detalles.</p>}</AgendaDetails>
      </>}
      {section === "Pacientes" && <div className="live-grid"><section className="demo-panel"><h2>Pacientes</h2>{data.patients.length ? data.patients.map((item) => <button className="live-row live-patient" key={item.id} onClick={() => setSelectedPatient(item.id)}><div><b>{item.first_name} {item.last_name}</b><small>{[item.email, item.phone].filter(Boolean).join(" · ")}</small></div><span>{data.appointments.filter((appointmentItem) => appointmentItem.patient_id === item.id).length} turnos</span></button>) : <p className="live-empty">Todavía no hay pacientes registrados.</p>}</section><section className="demo-panel"><h2>Perfil del paciente</h2>{patient ? <><p><b>{patient.first_name} {patient.last_name}</b></p><p>{[patient.email, patient.phone].filter(Boolean).join(" · ")}</p><h3>Historial de turnos</h3>{data.appointments.filter((item) => item.patient_id === patient.id).map((item) => <div className="live-answer" key={item.id}><b>{date(item.starts_at)}</b><p>{serviceById(intentById(item.booking_intent_id)?.service_id ?? "")?.name} · {item.status}</p>{data.answers.filter((answer) => answer.booking_intent_id === item.booking_intent_id).map((answer, index) => <p key={index}>{answer.question_title}: {Array.isArray(answer.answer) ? answer.answer.join(", ") : String(answer.answer)}</p>)}</div>)}</> : <p className="live-empty">Seleccioná un paciente para ver su historial.</p>}</section></div>}
      {section === "Perfil" && <>
        <Tabs label="Secciones del perfil" active={profileTab} onChange={setProfileTab} tabs={profileTabs.map((item) => item.id === "cobros" && pendingPayments.length + late.length ? { ...item, count: pendingPayments.length + late.length } : item)}/>
        {profileTab === "perfil" && <div className="live-grid" role="tabpanel" aria-labelledby="crm-tab-perfil"><section className="demo-panel"><h2>Tu perfil público</h2><div className="live-fields"><label>Nombre visible<input value={profileForm.display_name} onChange={(event) => setProfileForm({ ...profileForm, display_name: event.target.value })} /></label><label>Especialidad<input value={profileForm.specialty} onChange={(event) => setProfileForm({ ...profileForm, specialty: event.target.value })} /></label><label>Descripción<textarea value={profileForm.biography} onChange={(event) => setProfileForm({ ...profileForm, biography: event.target.value })} /></label><label>Provincia<input value={profileForm.province} onChange={(event) => setProfileForm({ ...profileForm, province: event.target.value })} /></label><label>Ciudad<input value={profileForm.city} onChange={(event) => setProfileForm({ ...profileForm, city: event.target.value })} /></label><label>Dirección<input value={profileForm.address} onChange={(event) => setProfileForm({ ...profileForm, address: event.target.value })} /></label><label><input type="checkbox" checked={profileForm.offers_online} onChange={(event) => setProfileForm({ ...profileForm, offers_online: event.target.checked })} /> Atiendo online</label><label><input type="checkbox" checked={profileForm.offers_in_person} onChange={(event) => setProfileForm({ ...profileForm, offers_in_person: event.target.checked })} /> Atiendo presencial</label></div><button className="demo-primary" disabled={busy} onClick={saveProfile}>Guardar perfil</button></section></div>}
        {profileTab === "pagina" && <div className="live-grid" role="tabpanel" aria-labelledby="crm-tab-pagina"><section className="demo-panel"><h2>Compartí tu link</h2><a className="live-link" href={`/p/${data.professional.public_slug}`} target="_blank" rel="noreferrer">/p/{data.professional.public_slug}</a><p>Zona horaria: {data.workspace.timezone}</p><p>Moneda: {data.workspace.currency_code}</p><p>Estado: {data.workspace.status}</p><p>Fin de prueba: {date(data.workspace.trial_ends_at)}</p></section></div>}
        {profileTab === "cobros" && <div role="tabpanel" aria-labelledby="crm-tab-cobros">
          <PaymentSettings key={`${data.workspace.payment_provider}:${payAccess.connection.status}`} method={data.workspace.payment_provider === "mercado_pago_ar" ? "mercado_pago_ar" : "external_link"} paymentUrl={data.workspace.external_payment_url ?? ""} hasServiceLinks={data.services.some((item) => item.active && !!item.external_payment_url)}
            connection={payAccess.connection} canManage={payAccess.canManage} notice={payNotice} connecting={connecting} busy={busy} pendingMercadoPago={pendingMercadoPago}
            onConnect={connectMercadoPago} onDisconnect={disconnectPayments} onSaveMethod={savePaymentMethod} formatDate={(value) => new Intl.DateTimeFormat(data.workspace.locale, { timeZone: data.workspace.timezone, day: "numeric", month: "long", year: "numeric" }).format(new Date(value))} />
          <LatePayments items={late.map(({ intent, payment }) => ({ id: payment.id, patient: `${patientById(intent.patient_id)?.first_name ?? ""} ${patientById(intent.patient_id)?.last_name ?? ""}`.trim() || "Paciente", detail: `${serviceById(intent.service_id)?.name ?? "Consulta"} · ${money(payment.amount_minor)}`, approved: date(payment.approved_at ?? intent.created_at), href: `/pacientes/${intent.patient_id}` }))} />
          <PendingPayments busy={busy} onApprove={approvePayment} items={pendingPayments.map((item) => ({ id: item.id, patient: `${patientById(item.patient_id)?.first_name ?? ""} ${patientById(item.patient_id)?.last_name ?? ""}`.trim(), detail: `${serviceById(item.service_id)?.name ?? "Consulta"} · ${money(item.price_minor)}` }))} />
        </div>}
      </>}
    </>}</main></div></div>;
}
