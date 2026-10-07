"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Badge, BookingAlert, BookingCard, BookingContext, BookingLoading, BookingMessage, BookingPanel, BookingShell, BookingStepper, HowItWorks, Notice, PaymentStep, ProfessionalIntro, ServiceCard, SlotPicker, SuccessMark, SummaryList, paymentNeedsRetry, paymentStatusInfo } from "@/components/booking/BookingUi";
import { formatMoney, formatDateTime } from "@/lib/market";
import { publicRequest, submittedAnswers, type PublicProfile, type PublicService } from "@/lib/bellis-public";
import { bookingState, paymentCheckError, paymentCheckNote, readSavedBooking, restoreBooking, savedBookingKey, singleFlight, stepForView, type BookingView, type SavedBooking } from "@/lib/booking-recovery";
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
  // Coming back from the checkout with ?resume=, or reloading a tab that was in a booking: the request is
  // recovered from the server with the opaque token. Neither the address nor what the tab kept decides the step.
  const [recovery, setRecovery] = useState<"none" | "verifying" | "restoring" | "invalid" | "expired">(() => {
    if (typeof window === "undefined") return "none";
    if (new URLSearchParams(window.location.search).has("resume")) return "verifying";
    try { return readSavedBooking(window.sessionStorage.getItem(savedBookingKey(slug))) ? "restoring" : "none"; } catch { return "none"; }
  });
  const [returned, setReturned] = useState(false);
  // How the checkout said it ended. Wording only: it never decides the step.
  const [hint, setHint] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState("");
  // Only the token and what is needed to draw the screen again are kept, and only for this tab.
  const remember = useCallback((saved: SavedBooking) => {
    try { window.sessionStorage.setItem(savedBookingKey(slug), JSON.stringify(saved)); } catch { /* Without storage a reload starts over. */ }
  }, [slug]);
  const forget = useCallback(() => { try { window.sessionStorage.removeItem(savedBookingKey(slug)); } catch { /* Nothing was kept. */ } }, [slug]);
  /** Shows what the server says about the request. */
  const show = useCallback((view: BookingView) => {
    if (view.view === "gone") { forget(); setToken(""); setRecovery(view.reason); return; }
    setPaymentStatus(view.paymentStatus);
    if (view.view === "done") setAppointment(view.appointment);
    setStep((current) => stepForView(view, current));
  }, [forget]);
  const restored = useRef(false);
  useEffect(() => {
    if (!profile || restored.current) return;
    restored.current = true;
    const query = new URLSearchParams(window.location.search);
    const fromCheckout = query.get("resume");
    let kept: SavedBooking | null = null;
    try { kept = readSavedBooking(window.sessionStorage.getItem(savedBookingKey(slug))); } catch { /* Without storage there is nothing to recover. */ }
    const saved: SavedBooking | null = fromCheckout ? { token: fromCheckout, kind: "resume", checkoutUrl: "", serviceId: "" } : kept;
    if (!saved) return;
    const arrivedWith = fromCheckout ? query.get("mp") : null;
    if (fromCheckout) {
      // The token must not stay in the address bar or the browser history. The tab keeps it, to survive a reload.
      window.history.replaceState(null, "", window.location.pathname);
      remember(saved);
    }
    restoreBooking(saved, slug, publicRequest).then((result) => {
      setReturned(saved.kind === "resume"); setHint(arrivedWith);
      const known = result.service ? { ...result.service, description: null, can_checkout: true } : profile.services.find((item) => item.id === saved.serviceId);
      if (result.view === "gone") { show(result); return; }
      if (!known) { forget(); setRecovery("invalid"); return; }
      setService(known); setToken(saved.token); setCheckoutUrl(result.checkoutUrl ?? "");
      remember({ ...saved, checkoutUrl: result.checkoutUrl ?? "", serviceId: known.id });
      show(result); setRecovery("none");
    }).catch(() => {
      // The server could not be asked right now. With a known service the payment screen keeps checking by itself.
      const known = profile.services.find((item) => item.id === saved.serviceId);
      if (!known) { setRecovery("invalid"); return; }
      setReturned(saved.kind === "resume"); setHint(arrivedWith);
      setService(known); setToken(saved.token); setCheckoutUrl(saved.checkoutUrl); setStep(3); setRecovery("none");
    });
  }, [profile, slug, show, remember, forget]);
  useEffect(() => {
    let active = true;
    publicRequest<PublicProfile>("profile", { params: { slug } })
      .then((result) => { if (active) setProfile(result); })
      .catch((caught) => { if (active) setError(caught.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [slug]);
  // One check at a time, shared by the automatic check and the button.
  const askStatus = useMemo(() => singleFlight(() => bookingState(token, publicRequest)), [token]);
  const refreshStatus = useCallback(async () => {
    if (!token) return null;
    const view = await askStatus();
    show(view);
    return view;
  }, [token, askStatus, show]);
  useEffect(() => {
    if (step !== 3 || !token) return;
    const timer = window.setInterval(() => { refreshStatus().then((view) => { if (view && !paymentCheckNote(view)) setCheckNote(""); }).catch(() => undefined); }, 8000);
    return () => window.clearInterval(timer);
  }, [step, token, refreshStatus]);
  const checkPayment = async () => {
    if (checking) return;
    setChecking(true); setError(""); setCheckNote("");
    try { const view = await refreshStatus(); if (view) setCheckNote(paymentCheckNote(view)); }
    catch (caught) { setError(paymentCheckError(caught)); }
    finally { setChecking(false); }
  };
  const startPayment = async () => {
    if (!service || !consent) return;
    setBusy(true); setError("");
    try {
      const result = await publicRequest<{ token: string; checkoutUrl: string }>("create_intent", {
        method: "POST", body: { serviceId: service.id, patient, answers: submittedAnswers(answers) },
      });
      remember({ token: result.token, kind: "access", checkoutUrl: result.checkoutUrl, serviceId: service.id });
      setToken(result.token); setCheckoutUrl(result.checkoutUrl); setPaymentStatus("pending"); setReturned(false); setHint(null); setCheckNote(""); setStep(3);
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
      // The tab keeps its token: reloading the confirmation asks the server for this same appointment.
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
  const paymentAlert = alert ?? (checkNote ? <Notice live tone="info" title={checkNote} /> : null);
  // Stage shown in the stepper for each internal step: the review before paying belongs to "Pago".
  const stage = [0, 1, 2, 2, 3, 4][step];
  return <BookingShell professional={profile ? fullName : undefined}>
    {loading ? <BookingLoading label="Cargando agenda…" /> : !profile ? <BookingMessage title="Agenda no disponible">{error || "No encontramos este perfil."}</BookingMessage>
      : recovery === "verifying" ? <BookingLoading label="Estamos verificando tu pago…" />
      : recovery === "restoring" ? <BookingLoading label="Recuperando tu reserva…" />
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
      {step === 3 && <PaymentStep status={paymentStatus} returned={returned} hint={hint} guidance={profile.paymentFlow.guidance} alert={paymentAlert}
        summary={service && <SummaryList rows={[["Servicio", service.name], ["Estado del pago", <Badge key="status" tone={payment.tone}>{payment.label}</Badge>]]} total={["Total", money(service.price_minor)]} />}>
        {checkoutUrl && <a className="bk-button" href={checkoutUrl} target="_blank" rel="noopener noreferrer">{paymentNeedsRetry(paymentStatus, returned, hint) ? "Reintentar el pago" : profile.paymentFlow.actionLabel} <ArrowRight size={17}/></a>}
        <button className="bk-button bk-button-secondary" type="button" disabled={checking} aria-busy={checking} onClick={checkPayment}>{checking ? "Consultando…" : "Consultar estado del pago"}</button>
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
