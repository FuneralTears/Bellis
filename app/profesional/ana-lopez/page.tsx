"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, ArrowRight, CreditCard } from "lucide-react";
import { Badge, BookingCard, BookingContext, BookingPanel, BookingShell, BookingStepper, HowItWorks, Notice, ProfessionalIntro, ServiceCard, SlotPicker, SuccessMark, SummaryList } from "@/components/booking/BookingUi";
import { formatMoney } from "@/lib/market";
import { starterQuestionnaire, type QuestionnaireAnswers } from "@/lib/questionnaires/model";
import { QuestionnaireFlow, type PatientDraft } from "./questionnaire-flow";

// Showroom of the public booking (/p/[slug]): same screens and steps, mock data only.
// Nothing here calls the backend, creates a booking or starts a payment.
const professional = { name: "Dra. Ana López", specialty: "Psicóloga clínica", location: "Córdoba, Córdoba", biography: "Te acompaño en procesos de ansiedad, autoestima y relaciones, con una escucha cercana y herramientas adaptadas a tu momento." };
const services = [
  { name: "Consulta psicológica", description: "Un espacio para trabajar lo que hoy necesitás.", price: 25000, duration: 60 },
  { name: "Primera consulta", description: "Nos conocemos y definimos juntos el mejor camino.", price: 30000, duration: 75 },
];
const exampleSlots = ["09:00", "10:30", "12:00", "15:00", "16:30"];
/** Example availability: nothing on weekends, so the empty state can be seen too. */
function slotsFor(day: string) {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6 ? [] : exampleSlots.filter((_, index) => weekday % 2 === 0 || index !== 1);
}
const longDate = (day: string) => new Intl.DateTimeFormat("es-AR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));

export default function PublicProfile() {
  const [step, setStep] = useState(0);
  const [service, setService] = useState(0);
  const [patient, setPatient] = useState<PatientDraft>({ firstName: "", lastName: "", email: "", phone: "" });
  const [answers, setAnswers] = useState<QuestionnaireAnswers>({});
  const [consent, setConsent] = useState(false);
  const [day, setDay] = useState("");
  const [slot, setSlot] = useState("");
  const chosen = services[service];
  const go = (next: number) => { setStep(next); window.scrollTo(0, 0); };
  const stage = [0, 1, 2, 2, 3, 4][step];
  return <BookingShell professional={professional.name} banner={<p className="bk-demo-banner">Vista de demostración: no se guardan datos ni se realizan cobros. <Link href="/demo">Volver a la demo</Link></p>}>
    {step === 0 ? <>
      <ProfessionalIntro name={professional.name} specialty={professional.specialty} modalities={["Online"]} location={professional.location} />
      <div className="bk-profile-grid"><div className="bk-profile-main">
        <BookingPanel title="Sobre la consulta"><p>{professional.biography}</p></BookingPanel>
        <BookingPanel title="Servicios disponibles"><div className="bk-services">
          {services.map((item, index) => <ServiceCard key={item.name} name={item.name} description={item.description} duration={item.duration} modality="Online" price={formatMoney(item.price)} onReserve={() => { setService(index); setAnswers({}); go(1); }} />)}
        </div></BookingPanel>
      </div><HowItWorks points={["Información disponible solo para el equipo autorizado", "Horarios calculados según disponibilidad real"]} /></div>
    </> : <div className="bk-flow">{step < 3 && <button className="bk-back" type="button" onClick={() => setStep(step - 1)}><ArrowLeft size={17}/> Volver</button>}<BookingStepper current={stage} complete={step === 5} />
      {step < 5 && <BookingContext name={professional.name} detail={`${chosen.name} · ${chosen.duration} min · ${formatMoney(chosen.price)}`} />}
      {step === 1 && <QuestionnaireFlow key={service} questionnaire={starterQuestionnaire(`service-${service}`)} initialAnswers={answers} initialPatient={patient} onAnswersChange={setAnswers} onPatientChange={setPatient} onBack={() => setStep(0)} onComplete={(nextAnswers, nextPatient) => { setAnswers(nextAnswers); setPatient(nextPatient); go(2); }} />}
      {step === 2 && <BookingCard eyebrow="Revisá tu solicitud" title="Antes de pagar" description="El horario se habilita cuando se confirme el cobro.">
        <SummaryList rows={[["Servicio", chosen.name], ["Duración", `${chosen.duration} minutos`], ["Paciente", `${patient.firstName} ${patient.lastName}`]]} total={["Total", formatMoney(chosen.price)]} />
        <label className="bk-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /> <span>Autorizo compartir mis respuestas de preconsulta con este profesional para preparar mi turno.</span></label>
        <div className="bk-actions"><button className="bk-button" type="button" disabled={!consent} onClick={() => go(3)}>Continuar al pago <ArrowRight size={17}/></button></div>
      </BookingCard>}
      {step === 3 && <BookingCard eyebrow="Pago" title="Realizá el pago" description="En la versión real, acá se abre el medio de pago del profesional y el horario se habilita cuando el cobro queda confirmado.">
        <SummaryList rows={[["Servicio", chosen.name], ["Estado del pago", <Badge key="status" tone="warning">Pago pendiente</Badge>]]} total={["Total", formatMoney(chosen.price)]} />
        <Notice tone="info" icon={<CreditCard size={20}/>} title="Pago de demostración">No se realiza ningún cobro ni se abre un proveedor de pagos.</Notice>
        <div className="bk-actions"><button className="bk-button" type="button" onClick={() => go(4)}>Simular pago confirmado <ArrowRight size={17}/></button></div>
      </BookingCard>}
      {step === 4 && <BookingCard eyebrow="Horario" badge={<Badge tone="success">Pago confirmado</Badge>} title="Elegí el horario de tu turno" description={`Horarios de ejemplo para ${chosen.name}.`}>
        <SlotPicker day={day} onDay={(next) => { setDay(next); setSlot(""); }} busy={false} slots={day ? slotsFor(day).map((item) => ({ value: item, label: item })) : []} selected={slot} onSelect={setSlot} />
        <div className="bk-actions"><button className="bk-button" type="button" disabled={!slot} onClick={() => go(5)}>Confirmar turno de ejemplo <ArrowRight size={17}/></button></div>
      </BookingCard>}
      {step === 5 && <BookingCard center icon={<SuccessMark />} title="Así se vería tu confirmación" description="Tu recorrido de demostración terminó. Este turno no se guardó ni se notificó a la profesional.">
        <SummaryList rows={[["Profesional", professional.name], ["Servicio", chosen.name], ["Fecha y hora", `${longDate(day)} · ${slot}`], ["Modalidad", "Online"], ["Pago", "Simulado"]]} />
        <div className="bk-actions"><Link className="bk-button" href="/demo">Volver a la demo <ArrowRight size={17}/></Link></div>
      </BookingCard>}
    </div>}
  </BookingShell>;
}
