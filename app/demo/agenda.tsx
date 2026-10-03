"use client";

import { useState } from "react";
import AgendaCalendar, {
  AgendaDetails,
  type AgendaAppointment,
  type AgendaView,
} from "@/components/agenda/AgendaCalendar";
import { formatMoney } from "@/lib/market";
import { demoAgendaHistory } from "./agenda-data";
import { demoPatients, demoServices, demoToday } from "./showroom-data";

export function DemoAgenda({
  appointments,
}: {
  appointments: {
    time: string;
    name: string;
    service: string;
    status: string;
    paid: boolean;
  }[];
}) {
  const [view, setView] = useState<AgendaView>("Semana");
  const [selected, setSelected] = useState<string | null>(null);
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
  const all = [...demoAgendaHistory, ...today].sort(
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
  const patient = demoPatients.find(
    (item) => item.name === appointment?.patient,
  );
  const service = demoServices.find(
    (item) => item.name === appointment?.service,
  );
  return (
    <>
      <AgendaCalendar
        appointments={visible}
        view={view}
        selectedId={selected}
        onSelect={setSelected}
        todayLabel="3 oct 2026"
        timezone="America/Argentina/Buenos_Aires"
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
      <AgendaDetails>
        {appointment ? (
          <>
            <div className="live-detail">
              <b>
                {appointment.dateLabel} · {appointment.startTime}
                {appointment.endTime && ` – ${appointment.endTime}`}
              </b>
              <p>{appointment.patient}</p>
              <p>
                {patient?.email} · {patient?.phone}
              </p>
              <p>{appointment.service}</p>
              <p>
                Pago: {appointment.paid ? "Pagado" : "Pendiente"}
                {service && ` · ${formatMoney(service.price)}`}
              </p>
            </div>
            <h3>Preconsulta</h3>
            <div className="live-answer">
              <small>Motivo de consulta</small>
              <b>¿Qué te gustaría trabajar en esta sesión?</b>
              <p>Ansiedad y manejo del estrés. Respuesta de ejemplo.</p>
            </div>
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
