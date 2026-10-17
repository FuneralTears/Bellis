import { useEffect, useRef, type ReactNode } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Clock3 } from "lucide-react";
import {
  appointmentsInPeriod,
  dayLabels,
  emptyPeriodText,
  inPeriod,
  monthWeeks,
  periodLabel,
  shiftPeriod,
  stepLabel,
  type AgendaPeriod,
  type AgendaView,
} from "@/lib/agenda-period";
import "./agenda.css";

export type { AgendaView };
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
/** The color of a turn: by its state, or by its service when it is confirmed. */
function toneOf(item: AgendaAppointment) {
  const kind = statusKind(item.status);
  const tones = ["sage", "blue", "coral", "lilac", "orange"];
  const colorIndex =
    [...(item.service ?? item.id)].reduce(
      (sum, letter) => (sum * 31 + letter.charCodeAt(0)) >>> 0,
      0,
    ) % tones.length;
  return kind === "cancelled"
    ? "neutral"
    : kind === "pending"
      ? "orange"
      : kind === "completed"
        ? "blue"
        : tones[colorIndex];
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
  const tone = toneOf(item);
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
            {/* Nothing is pending on a cancelled appointment. */}
            {item.paid ? "Pagado" : kind === "cancelled" ? "Sin cobro" : "Pago pendiente"}
          </span>
        )}
      </span>
    </button>
  );
}

type AgendaDay = { key: string; weekday: string; dateLabel: string; appointments: AgendaAppointment[] };

function AgendaDays({
  days,
  selectedId,
  onSelect,
}: {
  days: AgendaDay[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      {days.map((day) => (
        <section className="agenda-day" key={day.key}>
          <header>
            <h2>
              {day.weekday} <span>{day.dateLabel}</span>
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

/** Day or week: one column per calendar day of the period, with or without turns, and one row per hour. */
function AgendaTimetable({
  days,
  selectedId,
  onSelect,
}: {
  days: AgendaDay[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const hours = days.flatMap((day) =>
    day.appointments.map((item) => Number(item.startTime.split(":")[0])),
  );
  const start = Math.min(8, ...hours);
  const end = Math.max(18, ...hours);
  return (
    <div className="agenda-grid-scroll">
      <table className={`agenda-grid${days.length === 1 ? " agenda-grid-day" : ""}`}>
        <caption className="sr-only">
          Turnos por día y hora. Seleccioná un turno para ver sus detalles.
        </caption>
        <thead>
          <tr>
            <th scope="col" className="agenda-hour-heading">
              <Clock3 size={14} />
              <span className="sr-only">Hora</span>
            </th>
            {days.map((day) => (
              <th scope="col" key={day.key}>
                <span>{day.weekday}</span>
                <strong>{day.dateLabel}</strong>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: end - start + 1 }, (_, index) => start + index).map((hour) => (
            <tr key={hour}>
              <th scope="row" className="agenda-hour">
                {String(hour).padStart(2, "0")}:00
              </th>
              {days.map((day) => (
                <td key={day.key}>
                  {day.appointments
                    .filter((item) => Number(item.startTime.split(":")[0]) === hour)
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
}

/** Month: the real calendar month, Monday to Sunday. Each day opens in the day view; a few turns are shown in it. */
function AgendaMonth({
  period,
  byDay,
  today,
  locale,
  selectedId,
  onSelect,
  onOpenDay,
}: {
  period: AgendaPeriod;
  byDay: Map<string, AgendaAppointment[]>;
  today: string;
  locale: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenDay?: (day: string) => void;
}) {
  const weeks = monthWeeks(period);
  const shown = 3;
  return (
    <div className="agenda-grid-scroll">
      <table className="agenda-month">
        <caption className="sr-only">
          Turnos del mes. Seleccioná un día para verlo completo.
        </caption>
        <thead>
          <tr>
            {weeks[0].map((day) => (
              <th scope="col" key={day}>
                {dayLabels(day, locale).weekday.slice(0, 3)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((day) => {
                const outside = !inPeriod(period, day);
                const items = outside ? [] : (byDay.get(day) ?? []);
                const label = dayLabels(day, locale);
                return (
                  <td
                    key={day}
                    className={`${outside ? "is-outside" : ""}${day === today ? " is-today" : ""}`}
                  >
                    {outside ? (
                      <span className="agenda-month-day" aria-hidden="true">
                        {Number(day.slice(8))}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="agenda-month-day"
                        aria-label={`Ver ${label.weekday} ${label.dateLabel}${items.length ? `, ${items.length} ${items.length === 1 ? "turno" : "turnos"}` : ""}`}
                        aria-current={day === today ? "date" : undefined}
                        onClick={() => onOpenDay?.(day)}
                      >
                        {Number(day.slice(8))}
                      </button>
                    )}
                    {items.slice(0, shown).map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        className={`agenda-chip agenda-tone-${toneOf(item)}${selectedId === item.id ? " is-selected" : ""}`}
                        aria-pressed={selectedId === item.id}
                        onClick={() => onSelect(item.id)}
                      >
                        <b>{item.startTime}</b> {item.patient ?? item.service}
                      </button>
                    ))}
                    {items.length > shown && (
                      <button type="button" className="agenda-chip-more" onClick={() => onOpenDay?.(day)}>
                        +{items.length - shown} más
                      </button>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The agenda for one period: a day, a week of seven consecutive days or a calendar month. The caller keeps the view
 * and the anchor day; this only draws them. Appointments outside the period are never shown, whatever is passed in.
 * It never calculates availability or slots.
 */
export default function AgendaCalendar({
  appointments,
  period,
  today,
  locale,
  onPeriod,
  onOpenDay,
  viewControls,
  selectedId,
  onSelect,
  timezone,
  actions,
  panel,
}: {
  /** Every appointment that may be on screen; only the period's are drawn. `dateKey` is the local day of the workspace. */
  appointments: AgendaAppointment[];
  period: AgendaPeriod;
  /** Local day of the workspace, YYYY-MM-DD: where "Hoy" goes back to. */
  today: string;
  locale: string;
  /** Moves the anchor day: "Hoy", previous and next period. */
  onPeriod: (anchor: string) => void;
  /** Opens one day of the month in the day view. */
  onOpenDay?: (day: string) => void;
  viewControls: ReactNode;
  selectedId: string | null;
  onSelect: (id: string) => void;
  timezone: string;
  /** Main actions of the agenda, shown in the header. */
  actions?: ReactNode;
  /** Shown between the header and the calendar, e.g. the form that creates an appointment. */
  panel?: ReactNode;
}) {
  const view = period.view;
  const visible = appointmentsInPeriod(period, appointments);
  const byDay = new Map<string, AgendaAppointment[]>();
  for (const item of visible) byDay.set(item.dateKey, [...(byDay.get(item.dateKey) ?? []), item]);
  const toDay = (key: string): AgendaDay => ({ key, ...dayLabels(key, locale), appointments: byDay.get(key) ?? [] });
  const columns = period.days.map(toDay);
  const withTurns = columns.filter((day) => day.appointments.length);
  const current = inPeriod(period, today);
  return (
    <section className="agenda" aria-label="Agenda de turnos">
      <header className="agenda-header">
        <div>
          <h1>Agenda</h1>
          <p aria-live="polite">
            <CalendarDays size={14} />
            {periodLabel(period, locale)}
          </p>
        </div>
        <div className="agenda-controls">
          {actions}
          <div className="agenda-date-controls" role="group" aria-label="Navegación de fechas">
            <button
              type="button"
              aria-pressed={current}
              title={current ? "Ya estás viendo el período de hoy" : "Volver a hoy"}
              onClick={() => onPeriod(today)}
            >
              Hoy
            </button>
            <button
              type="button"
              aria-label={stepLabel(view, -1)}
              title={stepLabel(view, -1)}
              onClick={() => onPeriod(shiftPeriod(view, period.anchor, -1))}
            >
              <ChevronLeft size={18} />
            </button>
            <button
              type="button"
              aria-label={stepLabel(view, 1)}
              title={stepLabel(view, 1)}
              onClick={() => onPeriod(shiftPeriod(view, period.anchor, 1))}
            >
              <ChevronRight size={18} />
            </button>
          </div>
          <div className="agenda-view-controls" role="group" aria-label="Vista de agenda">
            {viewControls}
          </div>
        </div>
      </header>
      {panel}
      <div className="agenda-board demo-panel">
        <div className="agenda-board-heading">
          <span>
            <strong>{view}</strong> · {visible.length} {visible.length === 1 ? "turno" : "turnos"}
          </span>
          <span className="agenda-timezone">
            {timezone.replaceAll("_", " ").split("/").slice(-1)[0]}
          </span>
        </div>
        {!visible.length ? (
          <div className="agenda-empty" role="status">
            <CalendarDays size={24} />
            <strong>{emptyPeriodText(view)}</strong>
            <p>Usá las flechas para ver otro período o «Hoy» para volver al actual.</p>
          </div>
        ) : (
          <>
            <div className="agenda-timetable">
              {view === "Mes" ? (
                <AgendaMonth
                  period={period}
                  byDay={byDay}
                  today={today}
                  locale={locale}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  onOpenDay={onOpenDay}
                />
              ) : (
                <AgendaTimetable days={columns} selectedId={selectedId} onSelect={onSelect} />
              )}
            </div>
            <div className="agenda-compact">
              <AgendaDays days={withTurns} selectedId={selectedId} onSelect={onSelect} />
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

/**
 * The detail sits below the calendar, which is taller than the screen. `focusKey` is the selected appointment:
 * when it changes, the detail is brought into view, so what can be done with that appointment is seen.
 */
export function AgendaDetails({ children, focusKey, feedback }: {
  children: ReactNode; focusKey?: string | null;
  /** What was just done to this appointment ("Cobro registrado."). The page announces it; here it is only shown. */
  feedback?: string;
}) {
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusKey) box.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusKey]);
  return (
    <section
      ref={box}
      className="agenda-details demo-panel"
      aria-label="Detalle del turno"
    >
      <h2>Detalle del turno</h2>
      {feedback && <p className="live-success">{feedback}</p>}
      {children}
    </section>
  );
}
