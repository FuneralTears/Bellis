import type { ReactNode } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Clock3 } from "lucide-react";
import "./agenda.css";

export type AgendaView = "Día" | "Semana" | "Mes";
/** Display fields only. The caller keeps its existing filters, timezone and handlers. */
export type AgendaAppointment = {
  id: string;
  dateKey: string;
  weekday: string;
  dateLabel: string;
  startTime: string;
  endTime?: string;
  patient?: string;
  service?: string;
  status: string;
  paid?: boolean;
};
const statusLabels: Record<string, string> = {
  scheduled: "Confirmado",
  confirmed: "Confirmado",
  pending: "Pendiente",
  pending_payment: "Pendiente",
  cancelled: "Cancelado",
  canceled: "Cancelado",
  completed: "Completado",
  Confirmado: "Confirmado",
  Pendiente: "Pendiente",
  Cancelado: "Cancelado",
  Completado: "Completado",
};
function statusKind(status: string) {
  const label = statusLabels[status] ?? status;
  return label === "Pendiente"
    ? "pending"
    : label === "Cancelado"
      ? "cancelled"
      : label === "Completado"
        ? "completed"
        : label === "Confirmado"
          ? "confirmed"
          : "neutral";
}
function AppointmentBlock({
  item,
  selected,
  onSelect,
}: {
  item: AgendaAppointment;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const kind = statusKind(item.status);
  const tones = ["sage", "blue", "coral", "lilac", "orange"];
  const colorIndex =
    [...(item.service ?? item.id)].reduce(
      (sum, letter) => (sum * 31 + letter.charCodeAt(0)) >>> 0,
      0,
    ) % tones.length;
  const tone =
    kind === "cancelled"
      ? "neutral"
      : kind === "pending"
        ? "orange"
        : kind === "completed"
          ? "blue"
          : tones[colorIndex];
  return (
    <button
      className={`agenda-appointment agenda-tone-${tone}${selected ? " is-selected" : ""}`}
      aria-pressed={selected}
      onClick={() => onSelect(item.id)}
    >
      <span className="agenda-time">
        <Clock3 size={12} />
        {item.startTime}
        {item.endTime && ` – ${item.endTime}`}
      </span>
      {item.patient && <strong>{item.patient}</strong>}
      {item.service && <span className="agenda-service">{item.service}</span>}
      <span className="agenda-appointment-meta">
        <span className={`agenda-state agenda-state-${kind}`}>
          {statusLabels[item.status] ?? item.status}
        </span>
        {item.paid !== undefined && (
          <span className="agenda-payment">
            {item.paid ? "Pagado" : "Pago pendiente"}
          </span>
        )}
      </span>
    </button>
  );
}

function AgendaDays({
  days,
  selectedId,
  onSelect,
}: {
  days: { key: string; appointments: AgendaAppointment[] }[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      {" "}
      {days.map((day) => (
        <section className="agenda-day" key={day.key}>
          <header>
            <h2>
              {day.appointments[0].weekday}{" "}
              <span>{day.appointments[0].dateLabel}</span>
            </h2>
            <span>
              {day.appointments.length}{" "}
              {day.appointments.length === 1 ? "turno" : "turnos"}
            </span>
          </header>
          <div>
            {day.appointments.map((item) => (
              <AppointmentBlock
                key={item.id}
                item={item}
                selected={selectedId === item.id}
                onSelect={onSelect}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

/** Group the already-filtered appointments for display; never calculate availability or slots. */
export default function AgendaCalendar({
  appointments,
  view,
  viewControls,
  selectedId,
  onSelect,
  todayLabel,
  timezone,
  actions,
  panel,
}: {
  appointments: AgendaAppointment[];
  view: AgendaView;
  viewControls: ReactNode;
  selectedId: string | null;
  onSelect: (id: string) => void;
  todayLabel: string;
  timezone: string;
  /** Main actions of the agenda, shown in the header. */
  actions?: ReactNode;
  /** Shown between the header and the calendar, e.g. the form that creates an appointment. */
  panel?: ReactNode;
}) {
  const days = [...new Set(appointments.map((item) => item.dateKey))]
    .sort()
    .map((key) => ({
      key,
      appointments: appointments.filter((item) => item.dateKey === key),
    }));
  const dayGroups = Array.from(
    { length: Math.ceil(days.length / 7) },
    (_, index) => days.slice(index * 7, index * 7 + 7),
  );
  const first = days[0]?.appointments[0];
  const last = days[days.length - 1]?.appointments[0];
  const range = first
    ? first.dateKey === last?.dateKey
      ? first.dateLabel
      : `${first.dateLabel} – ${last?.dateLabel}`
    : todayLabel;
  return (
    <section className="agenda" aria-label="Agenda de turnos">
      <header className="agenda-header">
        <div>
          <h1>Agenda</h1>
          <p>
            <CalendarDays size={14} />
            {range}
          </p>
        </div>
        <div className="agenda-controls">
          {actions}
          <div
            className="agenda-date-controls"
            aria-label="Navegación de fechas"
          >
            <button
              type="button"
              disabled
              title="Navegación de fechas no disponible"
            >
              Hoy
            </button>
            <button
              type="button"
              disabled
              aria-label="Periodo anterior"
              title="Navegación de fechas no disponible"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              disabled
              aria-label="Periodo siguiente"
              title="Navegación de fechas no disponible"
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <div
            className="agenda-view-controls"
            role="group"
            aria-label="Vista de agenda"
          >
            {viewControls}
          </div>
        </div>
      </header>
      {panel}
      <div className="agenda-board demo-panel">
        <div className="agenda-board-heading">
          <span>
            <strong>{view}</strong> · {appointments.length}{" "}
            {appointments.length === 1 ? "turno" : "turnos"}
          </span>
          <span className="agenda-timezone">
            {timezone.replaceAll("_", " ").split("/").slice(-1)[0]}
          </span>
        </div>
        {!appointments.length ? (
          <div className="agenda-empty" role="status">
            <CalendarDays size={24} />
            <strong>No hay turnos en esta vista</strong>
            <p>Los turnos de la vista seleccionada aparecerán acá.</p>
          </div>
        ) : (
          <>
            <div className="agenda-timetable">
              {dayGroups.slice(0, 1).map((group) => {
                const hours = group.flatMap((day) =>
                  day.appointments.map((item) =>
                    Number(item.startTime.split(":")[0]),
                  ),
                );
                const start = Math.min(8, ...hours);
                const end = Math.max(18, ...hours);
                return (
                  <div key={group[0].key} className="agenda-grid-scroll">
                    <table className="agenda-grid">
                      <caption className="sr-only">
                        Turnos por día y hora. Seleccioná un turno para ver sus
                        detalles.
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col" className="agenda-hour-heading">
                            <Clock3 size={14} />
                            <span className="sr-only">Hora</span>
                          </th>
                          {group.map((day) => (
                            <th scope="col" key={day.key}>
                              <span>{day.appointments[0].weekday}</span>
                              <strong>{day.appointments[0].dateLabel}</strong>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from(
                          { length: end - start + 1 },
                          (_, index) => start + index,
                        ).map((hour) => (
                          <tr key={hour}>
                            <th scope="row" className="agenda-hour">
                              {String(hour).padStart(2, "0")}:00
                            </th>
                            {group.map((day) => (
                              <td key={day.key}>
                                {day.appointments
                                  .filter(
                                    (item) =>
                                      Number(item.startTime.split(":")[0]) ===
                                      hour,
                                  )
                                  .map((item) => (
                                    <AppointmentBlock
                                      key={item.id}
                                      item={item}
                                      selected={selectedId === item.id}
                                      onSelect={onSelect}
                                    />
                                  ))}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
              {days.length > 7 && (
                <div className="agenda-continuation">
                  <AgendaDays
                    days={days.slice(7)}
                    selectedId={selectedId}
                    onSelect={onSelect}
                  />
                </div>
              )}
            </div>
            <div className="agenda-compact">
              <AgendaDays
                days={days}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            </div>
          </>
        )}
        <div className="agenda-legend" aria-label="Estados de turnos">
          {[
            ["confirmed", "Confirmado"],
            ["pending", "Pendiente"],
            ["cancelled", "Cancelado"],
            ["completed", "Completado"],
          ].map(([kind, label]) => (
            <span key={kind} className={`agenda-state agenda-state-${kind}`}>
              {label}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

export function AgendaDetails({ children }: { children: ReactNode }) {
  return (
    <section
      className="agenda-details demo-panel"
      aria-label="Detalle del turno"
    >
      <h2>Detalle del turno</h2>
      {children}
    </section>
  );
}
