"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Badge, BookingAlert, BookingCard, BookingContext, BookingLoading, BookingMessage, BookingPanel, BookingShell, BookingStepper, HowItWorks, PaymentStep, ProfessionalIntro, ServiceCard, SlotPicker, SuccessMark, SummaryList, paymentNeedsRetry, paymentStatusInfo } from "@/components/booking/BookingUi";
import { formatMoney, formatDateTime } from "@/lib/market";
import { publicRequest, submittedAnswers, type PublicProfile, type PublicService, type ResumedBooking } from "@/lib/bellis-public";
import { QuestionnaireFlow, type PatientDraft } from "@/app/profesional/ana-lopez/questionnaire-flow";
import type { QuestionnaireAnswers } from "@/lib/questionnaires/model";

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
  // Coming back from the checkout with ?resume=: the request is recovered from the server, never from this address.
  const [recovery, setRecovery] = useState<"none" | "verifying" | "invalid" | "expired">(() =>
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("resume") ? "verifying" : "none");
  const [returned, setReturned] = useState(false);
  // How the checkout said it ended. Wording only: it never decides the step.
  const [hint, setHint] = useState<string | null>(null);
  const resumed = useRef(false);
  useEffect(() => {
    if (!profile || resumed.current) return;
    const query = new URLSearchParams(window.location.search);
    const resume = query.get("resume");
    if (!resume) return;
    resumed.current = true;
    const arrivedWith = query.get("mp");
    // The token must not stay in the address bar or the browser history.
    window.history.replaceState(null, "", window.location.pathname);
    publicRequest<ResumedBooking>("resume", { method: "POST", body: { resume, slug } }).then((result) => {
      setService({ ...result.service, description: null, can_checkout: true });
      setToken(resume); setCheckoutUrl(result.checkoutUrl ?? ""); setPaymentStatus(result.paymentStatus);
      setReturned(true); setHint(arrivedWith);
      if (result.step === "done" && result.appointment) { window.sessionStorage.removeItem(`bellis-intent:${slug}`); setAppointment(result.appointment); setStep(5); }
      else {
        window.sessionStorage.setItem(`bellis-intent:${slug}`, JSON.stringify({ token: resume, checkoutUrl: result.checkoutUrl ?? "", serviceId: result.service.id }));
        setStep(result.step === "schedule" ? 4 : 3);
      }
      setRecovery("none");
    }).catch((caught) => setRecovery((caught as { code?: string }).code === "expired" ? "expired" : "invalid"));
  }, [profile, slug]);
  useEffect(() => {
    let active = true;
    publicRequest<PublicProfile>("profile", { params: { slug } })
      .then((result) => { if (active) setProfile(result); })
      .catch((caught) => { if (active) setError(caught.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [slug]);
  useEffect(() => {
    if (!profile || token || recovery !== "none") return;
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(`bellis-intent:${slug}`) ?? "null") as { token?: string; checkoutUrl?: string; serviceId?: string } | null;
      if (saved?.token && /^[a-f0-9]{64}$/.test(saved.token)) {
        const previousService = profile.services.find((item) => item.id === saved.serviceId);
        if (previousService) { setService(previousService); setToken(saved.token); setCheckoutUrl(saved.checkoutUrl ?? ""); setStep(3); }
      }
    } catch { window.sessionStorage.removeItem(`bellis-intent:${slug}`); }
  }, [profile, slug, token, recovery]);
  const refreshStatus = useCallback(async () => {
    if (!token) return;
    let result: { status: string; paymentStatus: string };
    try { result = await publicRequest<{ status: string; paymentStatus: string }>("status", { token }); }
    catch (caught) {
      // The request is gone or expired: stop asking, and say so instead of waiting forever.
      if ((caught as { status?: number }).status === 404) { window.sessionStorage.removeItem(`bellis-intent:${slug}`); setToken(""); setRecovery("expired"); return; }
      throw caught;
    }
    setPaymentStatus(result.paymentStatus);
    if (result.status === "awaiting_schedule" || result.status === "payment_confirmed") setStep(4);
  }, [token, slug]);
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
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "No pudimos confirmar el turno";
      setError(message);
      await loadSlots(day);
      // loadSlots clears the error when it starts: put it back so the patient knows why the slot was deselected.
      setError(message);
    }
    finally { setBusy(false); }
  };
  const market = profile ? { country: "AR", currency: profile.market.currency, locale: profile.market.locale, timezone: profile.market.timezone, paymentProvider: "external_link" } : undefined;
  const money = (amount: number) => formatMoney(amount / 100, market);
  const selectedQuestionnaire = service ? profile?.questionnaires[service.id] : undefined;
  const fullName = profile?.professional.display_name ?? "Profesional";
  const modalityLabel = (item: PublicService) => item.modality === "online" ? "Online" : item.modality === "both" ? "Online o presencial" : "Presencial";
  const location = profile ? [profile.professional.city, profile.professional.province].filter(Boolean).join(", ") : "";
  const modalities = profile ? [profile.professional.offers_online && "Online", profile.professional.offers_in_person && "Presencial"].filter((item): item is string => !!item) : [];
  const payment = paymentStatusInfo(paymentStatus);
  const alert = error ? <BookingAlert>{error}</BookingAlert> : null;
  // Stage shown in the stepper for each internal step: the review before paying belongs to "Pago".
  const stage = [0, 1, 2, 2, 3, 4][step];
  return <BookingShell professional={profile ? fullName : undefined}>
    {loading ? <BookingLoading label="Cargando agenda…" /> : !profile ? <BookingMessage title="Agenda no disponible">{error || "No encontramos este perfil."}</BookingMessage>
      : recovery === "verifying" ? <BookingLoading label="Estamos verificando tu pago…" />
      : recovery !== "none" ? <BookingMessage title={recovery === "expired" ? "Esta reserva venció" : "No pudimos recuperar esta reserva"} action={<button className="bk-button" type="button" onClick={() => { setRecovery("none"); setStep(0); setError(""); }}>Volver a empezar <ArrowRight size={17}/></button>}>{recovery === "expired" ? "Pasó el tiempo para completar el pago. Empezá de nuevo para elegir un turno." : "El enlace no es válido o la reserva ya no está disponible. Si ya pagaste, escribile al profesional."}</BookingMessage>
      : step === 0 ? <>
      <ProfessionalIntro name={fullName} specialty={profile.professional.specialty} modalities={modalities} location={location} />
      <div className="bk-profile-grid"><div className="bk-profile-main">
        {profile.professional.biography && <BookingPanel title="Sobre la consulta"><p>{profile.professional.biography}</p></BookingPanel>}
        <BookingPanel title="Servicios disponibles"><div className="bk-services">
          {profile.services.length ? profile.services.map((item) => <ServiceCard key={item.id} name={item.name} description={item.description} duration={item.duration_minutes} modality={modalityLabel(item)} price={money(item.price_minor)} disabled={!item.can_checkout || !profile.questionnaires[item.id]} onReserve={() => { setService(item); setAnswers({}); setStep(1); window.scrollTo(0, 0); }} />) : <p>Todavía no hay servicios disponibles.</p>}
          {!profile.services.some((item) => item.can_checkout) && <p>Esta agenda está esperando que el profesional configure su cobro.</p>}
        </div></BookingPanel>
      </div><HowItWorks points={["Información disponible solo para el equipo autorizado", "Horarios calculados según disponibilidad real"]} /></div>
    </> : <div className="bk-flow">{step < 3 && <button className="bk-back" type="button" onClick={() => setStep(step - 1)}><ArrowLeft size={17}/> Volver</button>}<BookingStepper current={stage} complete={step === 5} />
      {service && step < 5 && <BookingContext name={fullName} detail={`${service.name} · ${service.duration_minutes} min · ${money(service.price_minor)}`} />}
      {step === 1 && selectedQuestionnaire && <QuestionnaireFlow key={service?.id} questionnaire={selectedQuestionnaire} initialAnswers={answers} initialPatient={patient} onAnswersChange={setAnswers} onPatientChange={setPatient} onBack={() => setStep(0)} onComplete={(nextAnswers, nextPatient) => { setAnswers(nextAnswers); setPatient(nextPatient); setStep(2); window.scrollTo(0, 0); }} demoNote={false} />}
      {step === 2 && service && <BookingCard eyebrow="Revisá tu solicitud" title="Antes de pagar" description="El horario se habilita cuando se confirme el cobro.">
        <SummaryList rows={[["Servicio", service.name], ["Duración", `${service.duration_minutes} minutos`], ["Paciente", `${patient.firstName} ${patient.lastName}`]]} total={["Total", money(service.price_minor)]} />
        <label className="bk-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /> <span>Autorizo compartir mis respuestas de preconsulta con este profesional para preparar mi turno.</span></label>
        {alert}
        <div className="bk-actions"><button className="bk-button" type="button" disabled={!consent || busy} onClick={startPayment}>{busy ? "Preparando cobro…" : "Continuar al pago"} <ArrowRight size={17}/></button></div>
      </BookingCard>}
      {step === 3 && <PaymentStep status={paymentStatus} returned={returned} hint={hint} guidance={profile.paymentFlow.guidance} alert={alert}
        summary={service && <SummaryList rows={[["Servicio", service.name], ["Estado del pago", <Badge key="status" tone={payment.tone}>{payment.label}</Badge>]]} total={["Total", money(service.price_minor)]} />}>
        {checkoutUrl && <a className="bk-button" href={checkoutUrl} target="_blank" rel="noopener noreferrer">{paymentNeedsRetry(paymentStatus, returned, hint) ? "Reintentar el pago" : profile.paymentFlow.actionLabel} <ArrowRight size={17}/></a>}
        <button className="bk-button bk-button-secondary" type="button" onClick={() => refreshStatus().catch((caught) => setError(caught.message))}>Consultar estado del pago</button>
      </PaymentStep>}
      {step === 4 && <BookingCard eyebrow="Horario" badge={<Badge tone="success">Pago confirmado</Badge>} title="Elegí el horario de tu turno" description="Estos horarios se calculan a partir de la disponibilidad real y se verifican de nuevo al confirmar.">
        <SlotPicker day={day} onDay={loadSlots} busy={busy} slots={slots.map((item) => ({ value: item, label: new Intl.DateTimeFormat(profile.market.locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: profile.market.timezone }).format(new Date(item)) }))} selected={slot} onSelect={(value) => { setSlot(value); setError(""); }} />
        {alert}
        <div className="bk-actions"><button className="bk-button" type="button" disabled={!slot || busy} onClick={book}>Confirmar turno <ArrowRight size={17}/></button></div>
      </BookingCard>}
      {step === 5 && appointment && service && <BookingCard center icon={<SuccessMark />} title="¡Tu turno está confirmado!" description="Guardá estos datos. La confirmación por email estará disponible cuando el profesional active el envío de mensajes.">
        <SummaryList rows={[["Profesional", fullName], ["Servicio", service.name], ["Fecha y hora", formatDateTime(appointment.starts_at, market)], ["Modalidad", modalityLabel(service)], service.modality !== "online" && profile.professional.address && ["Dirección", profile.professional.address], ["Pago", profile.paymentFlow.confirmationLabel]]} />
      </BookingCard>}
      {(step === 1 || step === 5) && alert}
    </div>}
  </BookingShell>;
}
