"use client";

import BellisLogo from "@/components/brand/BellisLogo";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, CalendarDays, Check, Clock3, CreditCard, Globe2, MapPin, ShieldCheck } from "lucide-react";
import { formatMoney, formatDateTime } from "@/lib/market";
import { publicRequest, submittedAnswers, type PublicProfile, type PublicService } from "@/lib/bellis-public";
import { QuestionnaireFlow, type PatientDraft } from "@/app/profesional/ana-lopez/questionnaire-flow";
import type { QuestionnaireAnswers } from "@/lib/questionnaires/model";
import "../../profesional/ana-lopez/profile.css";

const emptyPatient = { firstName: "", lastName: "", email: "", phone: "" };
type AppointmentResult = { appointment: { starts_at: string; ends_at: string } };

export function LivePublicProfile({ slug }: { slug: string }) {
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [step, setStep] = useState(0);
  const [service, setService] = useState<PublicService | null>(null);
  const [answers, setAnswers] = useState<QuestionnaireAnswers>({});
  const [patient, setPatient] = useState<PatientDraft>(emptyPatient);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [checkoutUrl, setCheckoutUrl] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("pending");
  const [day, setDay] = useState("");
  const [slots, setSlots] = useState<string[]>([]);
  const [slot, setSlot] = useState("");
  const [appointment, setAppointment] = useState<AppointmentResult["appointment"] | null>(null);
  useEffect(() => {
    let active = true;
    publicRequest<PublicProfile>("profile", { params: { slug } })
      .then((result) => { if (active) setProfile(result); })
      .catch((caught) => { if (active) setError(caught.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [slug]);
  useEffect(() => {
    if (!profile || token) return;
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(`bellis-intent:${slug}`) ?? "null") as { token?: string; checkoutUrl?: string; serviceId?: string } | null;
      if (saved?.token && /^[a-f0-9]{64}$/.test(saved.token)) {
        const previousService = profile.services.find((item) => item.id === saved.serviceId);
        if (previousService) { setService(previousService); setToken(saved.token); setCheckoutUrl(saved.checkoutUrl ?? ""); setStep(3); }
      }
    } catch { window.sessionStorage.removeItem(`bellis-intent:${slug}`); }
  }, [profile, slug, token]);
  const refreshStatus = useCallback(async () => {
    if (!token) return;
    const result = await publicRequest<{ status: string; paymentStatus: string }>("status", { token });
    setPaymentStatus(result.paymentStatus);
    if (result.status === "awaiting_schedule" || result.status === "payment_confirmed") setStep(4);
  }, [token]);
  useEffect(() => {
    if (step !== 3 || !token) return;
    const timer = window.setInterval(() => { refreshStatus().catch(() => undefined); }, 8000);
    return () => window.clearInterval(timer);
  }, [step, token, refreshStatus]);
  const startPayment = async () => {
    if (!service || !consent) return;
    setBusy(true); setError("");
    try {
      const result = await publicRequest<{ token: string; checkoutUrl: string }>("create_intent", {
        method: "POST", body: { serviceId: service.id, patient, answers: submittedAnswers(answers) },
      });
      window.sessionStorage.setItem(`bellis-intent:${slug}`, JSON.stringify({ token: result.token, checkoutUrl: result.checkoutUrl, serviceId: service.id }));
      setToken(result.token); setCheckoutUrl(result.checkoutUrl); setStep(3);
      window.scrollTo(0, 0);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "No pudimos iniciar el cobro"); }
    finally { setBusy(false); }
  };
  const loadSlots = async (nextDay: string) => {
    setDay(nextDay); setSlot(""); setSlots([]); setError("");
    if (!nextDay) return;
    setBusy(true);
    try {
      const result = await publicRequest<{ slots: string[] }>("slots", { token, params: { day: nextDay } });
      setSlots(result.slots);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "No pudimos cargar horarios"); }
    finally { setBusy(false); }
  };
  const book = async () => {
    if (!slot) return;
    setBusy(true); setError("");
    try {
      const result = await publicRequest<AppointmentResult>("book", { method: "POST", token, body: { startsAt: slot } });
      window.sessionStorage.removeItem(`bellis-intent:${slug}`);
      setAppointment(result.appointment); setStep(5); window.scrollTo(0, 0);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "No pudimos confirmar el turno"); await loadSlots(day); }
    finally { setBusy(false); }
  };
  const market = profile ? { country: "AR", currency: profile.market.currency, locale: profile.market.locale, timezone: profile.market.timezone, paymentProvider: "external_link" } : undefined;
  const money = (amount: number) => formatMoney(amount / 100, market);
  const selectedQuestionnaire = service ? profile?.questionnaires[service.id] : undefined;
  const fullName = profile?.professional.display_name ?? "Profesional";
  const initials = fullName.split(" ").slice(-2).map((part) => part[0]).join("").toUpperCase();
  return <main className="public-shell"><header className="public-header"><a className="brand" href="/"><BellisLogo /></a><span>Turnos simples y seguros</span></header><div className="public-wrap">
    {loading ? <section className="booking-card" role="status">Cargando agenda…</section> : !profile ? <section className="booking-card" role="alert"><h1>Agenda no disponible</h1><p>{error || "No encontramos este perfil."}</p></section> : step === 0 ? <>
      <div className="profile-top"><div className="profile-avatar">{initials}</div><div><span className="profile-label">PERFIL PROFESIONAL</span><h1>{fullName}</h1><p>{profile.professional.specialty}</p><div className="profile-meta"><span><Globe2 size={17}/> {profile.professional.offers_online ? "Online" : "Presencial"}</span><span><MapPin size={17}/> {[profile.professional.city, profile.professional.province].filter(Boolean).join(", ")}</span></div></div></div>
      <div className="profile-grid"><div><section className="public-card"><h2>Un espacio para vos</h2><p>{profile.professional.biography || "Conocé los servicios disponibles y reservá tu turno."}</p></section><section className="public-card services-card"><h2>Servicios disponibles</h2>{profile.services.length ? profile.services.map((item) => <div className="public-service" key={item.id}><span className="service-symbol"><CalendarDays size={22}/></span><div><h3>{item.name}</h3><p>{item.description}</p><span><Clock3 size={15}/> {item.duration_minutes} minutos</span></div><div className="service-action"><strong>{money(item.price_minor)}</strong><button disabled={!item.can_checkout || !profile.questionnaires[item.id]} onClick={() => { setService(item); setAnswers({}); setStep(1); window.scrollTo(0, 0); }}>Reservar turno <ArrowRight size={16}/></button></div></div>) : <p>Todavía no hay servicios disponibles.</p>}{!profile.services.some((item) => item.can_checkout) && <p>Esta agenda está esperando que el profesional configure su cobro.</p>}</section></div><aside className="profile-aside public-card"><span className="aside-icon"><ShieldCheck size={25}/></span><h3>Tu turno, paso a paso</h3><p>Elegí un servicio, completá la preconsulta, pagá y seleccioná tu horario cuando el cobro esté confirmado.</p><div><Check size={16}/> Información disponible solo para el equipo autorizado</div><div><Check size={16}/> Horarios calculados según disponibilidad real</div></aside></div>
    </> : <div className="booking-wrap">{step < 3 && <button className="booking-back" onClick={() => setStep(step - 1)}><ArrowLeft size={17}/> Volver</button>}<div className="booking-progress">{["Servicio", "Preconsulta", "Pago", "Horario", "Confirmación"].map((label, index) => <span key={label} className={index <= step - 1 ? "on" : ""}><b>{index + 1}</b>{label}</span>)}</div>
      {step === 1 && selectedQuestionnaire && <QuestionnaireFlow key={service?.id} questionnaire={selectedQuestionnaire} initialAnswers={answers} initialPatient={patient} onAnswersChange={setAnswers} onPatientChange={setPatient} onBack={() => setStep(0)} onComplete={(nextAnswers, nextPatient) => { setAnswers(nextAnswers); setPatient(nextPatient); setStep(2); window.scrollTo(0, 0); }} demoNote={false} />}
      {step === 2 && service && <section className="booking-card"><span className="profile-label">REVISÁ TU SOLICITUD</span><h1>Antes de pagar</h1><p>El horario se habilita cuando se confirme el cobro.</p><div className="booking-summary"><div><span>Servicio</span><b>{service.name}</b></div><div><span>Duración</span><b>{service.duration_minutes} minutos</b></div><div><span>Paciente</span><b>{patient.firstName} {patient.lastName}</b></div><div className="summary-total"><span>Total</span><strong>{money(service.price_minor)}</strong></div></div><label className="payment-check"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /> Autorizo compartir mis respuestas de preconsulta con este profesional para preparar mi turno.</label><button className="book-next" disabled={!consent || busy} onClick={startPayment}>{busy ? "Preparando cobro…" : "Continuar al pago"} <ArrowRight size={17}/></button></section>}
      {step === 3 && <section className="booking-card"><span className="profile-label">PAGO PENDIENTE</span><h1>Realizá el pago</h1><p>{profile.paymentFlow.guidance}</p><div className="payment-demo"><CreditCard size={21}/><div><b>El turno todavía no está reservado</b><p>Volvé a esta pantalla después de pagar y consultá el estado.</p></div></div><a className="book-next" href={checkoutUrl} target="_blank" rel="noopener noreferrer">{profile.paymentFlow.actionLabel} <ArrowRight size={17}/></a><button className="book-next" onClick={() => refreshStatus().catch((caught) => setError(caught.message))}>Consultar estado del pago</button><p>Estado: {paymentStatus === "pending" ? "pendiente" : paymentStatus}</p></section>}
      {step === 4 && <section className="booking-card"><span className="profile-label">PAGO CONFIRMADO</span><h1>Elegí el horario de tu turno</h1><p>Estos horarios se calculan a partir de la disponibilidad real y se verifican de nuevo al confirmar.</p><label className="live-day-label">Fecha <input type="date" value={day} onChange={(event) => loadSlots(event.target.value)} /></label><h3>Horarios disponibles</h3>{busy ? <p>Cargando horarios…</p> : !day ? <p>Elegí una fecha para ver horarios.</p> : !slots.length ? <p>No hay horarios disponibles ese día.</p> : <div className="slot-options">{slots.map((item) => <button key={item} className={slot === item ? "on" : ""} onClick={() => setSlot(item)}>{new Intl.DateTimeFormat(profile.market.locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: profile.market.timezone }).format(new Date(item))}</button>)}</div>}<button className="book-next" disabled={!slot || busy} onClick={book}>Confirmar turno <ArrowRight size={17}/></button></section>}
      {step === 5 && appointment && service && <section className="booking-card booking-success"><span className="success-mark"><Check size={34}/></span><h1>¡Tu turno está confirmado!</h1><p>Guardá estos datos. La confirmación por email estará disponible cuando el profesional active el envío de mensajes.</p><div className="booking-summary"><div><span>Profesional</span><b>{fullName}</b></div><div><span>Servicio</span><b>{service.name}</b></div><div><span>Fecha y hora</span><b>{formatDateTime(appointment.starts_at, market)}</b></div><div><span>Modalidad</span><b>{service.modality === "online" ? "Online" : service.modality === "both" ? "Online o presencial" : "Presencial"}</b></div>{service.modality !== "online" && profile.professional.address && <div><span>Dirección</span><b>{profile.professional.address}</b></div>}<div><span>Pago</span><b>{profile.paymentFlow.confirmationLabel}</b></div></div></section>}
      {error && <p className="smart-error" role="alert">{error}</p>}
    </div>}
  </div><footer className="public-footer">Bellis · Turnos para profesionales</footer></main>;
}
