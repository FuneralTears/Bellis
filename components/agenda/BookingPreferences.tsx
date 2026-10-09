import type { ReactNode } from "react";

/**
 * How the agenda offers turns, shared by the dashboard and its demo.
 * Presentation only: the host holds the values and decides what saving means.
 */

/** The frequencies the database accepts for professionals.slot_interval_minutes. */
export const SLOT_INTERVALS = [15, 30, 60] as const;
/** Upper bound the database accepts for professionals.max_appointments_per_day. */
export const MAX_APPOINTMENTS_PER_DAY = 50;

/** `maxPerDay` null means no limit. */
export type BookingPreferencesValue = { slotInterval: number; maxPerDay: number | null };

export default function BookingPreferences({ value, onChange, onSave, busy = false, saveLabel = "Guardar preferencias", className = "demo-panel", children }: {
  value: BookingPreferencesValue; onChange: (next: BookingPreferencesValue) => void; onSave: () => void; busy?: boolean; saveLabel?: string; className?: string; children?: ReactNode;
}) {
  return <section className={className}>
    <h2>Reserva de turnos</h2>
    <div className="live-fields">
      <label>Frecuencia de horarios
        <select value={value.slotInterval} onChange={(event) => onChange({ ...value, slotInterval: Number(event.target.value) })}>
          {SLOT_INTERVALS.map((minutes) => <option key={minutes} value={minutes}>Cada {minutes} minutos</option>)}
        </select>
        <small>Define cada cuánto Bellis ofrece un horario de inicio a tus pacientes.</small>
      </label>
      <label>Máximo de turnos por día
        <select value={value.maxPerDay ?? ""} onChange={(event) => onChange({ ...value, maxPerDay: event.target.value ? Number(event.target.value) : null })}>
          <option value="">Sin límite</option>
          {Array.from({ length: MAX_APPOINTMENTS_PER_DAY }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
        </select>
        <small>Limita cuántos turnos puede tener este profesional en un día.</small>
      </label>
    </div>
    <button className="demo-primary" type="button" disabled={busy} onClick={onSave}>{saveLabel}</button>
    {children}
  </section>;
}
