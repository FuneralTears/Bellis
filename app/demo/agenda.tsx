"use client";

import { useCallback, useState } from "react";
import { Plus } from "lucide-react";
import AgendaCalendar, {
  AgendaDetails,
  type AgendaAppointment,
  type AgendaView,
} from "@/components/agenda/AgendaCalendar";
import {
  ManualAppointmentForm,
  type ManualAppointmentInput,
  type ManualPatient,
} from "@/components/agenda/ManualAppointmentForm";
import { RecordOfflinePayment } from "@/components/payments/RecordOfflinePayment";
import { canRecordPayment, paymentLabel, type PaymentMethod } from "@/lib/manual-appointment";
import { formatMoney } from "@/lib/market";
import { demoAgendaHistory } from "./agenda-data";
import { demoPatients, demoServices, demoToday, type DemoService } from "./showroom-data";

const timezone = "America/Argentina/Buenos_Aires";
const professional = { id: "pro", display_name: "Dra. Ana López" };
const part = (instant: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("es-AR", { timeZone: timezone, ...options }).format(new Date(instant));
const clock = (instant: string) => part(instant, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const localDay = (instant: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
// Example availability, as in the public booking demo: long days, short days and nothing on Sundays.
const shortDay = ["09:00", "10:30", "12:00", "15:00", "16:30"];
const longDay = Array.from({ length: 14 }, (_, index) => `${String(9 + Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`);
function exampleTimes(day: string) {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday === 0 ? [] : weekday % 2 ? longDay : shortDay;
}
/** What the showroom keeps for a turn created by hand. In memory only. */
type ManualInfo = { patient: ManualPatient; method: ManualAppointmentInput["method"]; amountMinor: number | null; priceMinor: number };

export function DemoAgenda({
  appointments,
  services = demoServices,
}: {
  appointments: {
    time: string;
    name: string;
    service: string;
    status: string;
    paid: boolean;
  }[];
  services?: DemoService[];
}) {
  const [view, setView] = useState<AgendaView>("Semana");
  const [selected, setSelected] = useState<string | null>(null);
  // "Nuevo turno": same flow as the product. Patients and turns added here live in memory and nothing is sent.
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");
  const [addedPatients, setAddedPatients] = useState<ManualPatient[]>([]);
  const [created, setCreated] = useState<{ appointment: AgendaAppointment; info: ManualInfo }[]>([]);
  const today: AgendaAppointment[] = appointments.map((item, index) => ({
    id: `demo-agenda-today-${index}`,
    dateKey: demoToday,
    weekday: "sábado",
    dateLabel: "3 oct 2026",
    startTime: item.time,
    patient: item.name,
    service: item.service,
    status: item.status,
    paid: item.paid,
  }));
  const all = [...demoAgendaHistory, ...today, ...created.map((item) => item.appointment)].sort(
    (a, b) =>
      a.dateKey.localeCompare(b.dateKey) ||
      a.startTime.localeCompare(b.startTime),
  );
  const visible = all.filter((item) =>
    view === "Día"
      ? item.dateKey === demoToday
      : view === "Mes"
        ? item.dateKey.startsWith("2026-10")
        : item.dateKey >= "2026-09-26",
  );
  const appointment = all.find((item) => item.id === selected);
  const manual = created.find((item) => item.appointment.id === selected)?.info;
  const patient = demoPatients.find(
    (item) => item.name === appointment?.patient,
  );
  const service = demoServices.find(
    (item) => item.name === appointment?.service,
  );

  const everyone: ManualPatient[] = [
    ...addedPatients,
    ...demoPatients.map((item) => ({ id: item.name, full_name: item.name, phone: item.phone, email: item.email })),
  ];
  const known = JSON.stringify(everyone);
  const searchPatients = useCallback(async (query: string) => {
    const text = query.toLocaleLowerCase("es-AR");
    const digits = query.replace(/\D/g, "");
    return (JSON.parse(known) as ManualPatient[]).filter((item) =>
      [item.full_name, item.email ?? "", item.phone ?? ""].some((value) => value.toLocaleLowerCase("es-AR").includes(text))
      || (digits.length >= 4 && (item.phone ?? "").replace(/\D/g, "").includes(digits))).slice(0, 8);
  }, [known]);
  // A time is free when no turn of that day starts at it: the example turns of the day and the ones created here.
  const loadSlots = async (_professionalId: string, _serviceId: string, day: string) => {
    const taken = new Set(all.filter((item) => item.dateKey === day && item.status !== "cancelled").map((item) => item.startTime));
    return exampleTimes(day).filter((time) => !taken.has(time)).map((time) => new Date(`${day}T${time}:00-03:00`).toISOString());
  };
  const createTurn = async (input: ManualAppointmentInput) => {
    if (all.some((item) => item.dateKey === localDay(input.startsAt) && item.startTime === clock(input.startsAt) && item.status !== "cancelled"))
      throw new Error("slot_unavailable");
    const id = `demo-manual-${created.length + 1}`;
    const end = new Date(new Date(input.startsAt).getTime() + input.service.duration_minutes * 60000).toISOString();
    setCreated((list) => [...list, {
      appointment: {
        id, dateKey: localDay(input.startsAt), weekday: part(input.startsAt, { weekday: "long" }),
        dateLabel: [part(input.startsAt, { day: "numeric" }), part(input.startsAt, { month: "short" }).replace(".", ""), part(input.startsAt, { year: "numeric" })].join(" "),
        startTime: clock(input.startsAt), endTime: clock(end), patient: input.patient.full_name, service: input.service.name,
        status: "scheduled", paid: input.method !== null,
      },
      info: { patient: input.patient, method: input.method, amountMinor: input.amountMinor, priceMinor: input.service.price_minor },
    }]);
    setCreating(false); setView("Semana"); setSelected(id); setNotice("Turno creado en la demo. No se guardó ni se envió ningún aviso.");
  };

  // In memory, as everything here: the turn shows as charged at once.
  const recordPayment = async (id: string, method: PaymentMethod, amountMinor: number) => {
    setCreated((list) => list.map((item) => item.appointment.id === id ? { appointment: { ...item.appointment, paid: true }, info: { ...item.info, method, amountMinor } } : item));
    setNotice("Cobro registrado en la demo.");
  };

  return (
    <>
      {notice && <p className="live-success" role="status">{notice}</p>}
      <AgendaCalendar
        appointments={visible}
        view={view}
        selectedId={selected}
        onSelect={setSelected}
        todayLabel="3 oct 2026"
        timezone={timezone}
        actions={<button className="demo-primary agenda-new" type="button" disabled={creating} onClick={() => { setCreating(true); setNotice(""); }}><Plus size={16}/> Nuevo turno</button>}
        panel={creating && <ManualAppointmentForm
          professionals={[professional]}
          services={services.filter((item) => item.active).map((item) => ({ id: item.name, professional_id: professional.id, name: item.name, duration_minutes: item.duration, price_minor: item.price * 100 }))}
          timezone={timezone} locale="es-AR" today={demoToday} formatMoney={(minor) => formatMoney(minor / 100)}
          searchPatients={searchPatients}
          lookupDuplicates={async () => everyone}
          createPatient={async (values) => {
            const next = { id: `demo-patient-${addedPatients.length + 1}`, full_name: `${values.firstName} ${values.lastName}`, phone: values.phone, email: values.email };
            setAddedPatients((list) => [next, ...list]);
            return next;
          }}
          loadSlots={loadSlots} onCreate={createTurn} onCancel={() => setCreating(false)}/>}
        viewControls={(["Día", "Semana", "Mes"] as const).map((value) => (
          <button
            key={value}
            className={view === value ? "on" : ""}
            aria-pressed={view === value}
            onClick={() => setView(value)}
          >
            {value}
          </button>
        ))}
      />
      <AgendaDetails focusKey={selected}>
        {appointment ? (
          <>
            <div className="live-detail">
              <b>
                {appointment.dateLabel} · {appointment.startTime}
                {appointment.endTime && ` – ${appointment.endTime}`}
              </b>
              <p>{appointment.patient}</p>
              <p>
                {manual
                  ? [manual.patient.email, manual.patient.phone].filter(Boolean).join(" · ")
                  : `${patient?.email} · ${patient?.phone}`}
              </p>
              <p>{appointment.service}</p>
              {manual ? (
                <>
                  <p>
                    Pago: {paymentLabel(manual.method ? { provider: "offline", method: manual.method, status: "approved" } : null)}
                    {manual.amountMinor !== null && ` · ${formatMoney(manual.amountMinor / 100)}`}
                  </p>
                  <span className="agenda-manual-tag">Cargado manualmente</span>
                  {canRecordPayment({ source: "manual", appointmentStatus: appointment.status, hasPayment: manual.method !== null }) && (
                    <RecordOfflinePayment key={appointment.id} priceMinor={manual.priceMinor} formatMoney={(minor) => formatMoney(minor / 100)} onSave={(method, amountMinor) => recordPayment(appointment.id, method, amountMinor)} />
                  )}
                </>
              ) : (
                <p>
                  Pago: {paymentLabel({ provider: "mercado_pago_ar", status: appointment.paid ? "approved" : "pending" })}
                  {service && appointment.paid && ` · ${formatMoney(service.price)}`}
                </p>
              )}
            </div>
            <h3>Preconsulta</h3>
            {manual ? (
              <p className="live-empty">Sin respuestas de preconsulta.</p>
            ) : (
              <div className="live-answer">
                <small>Motivo de consulta</small>
                <b>¿Qué te gustaría trabajar en esta sesión?</b>
                <p>Ansiedad y manejo del estrés. Respuesta de ejemplo.</p>
              </div>
            )}
          </>
        ) : (
          <p className="live-empty">
            Seleccioná un turno para ver los detalles.
          </p>
        )}
      </AgendaDetails>
    </>
  );
}
