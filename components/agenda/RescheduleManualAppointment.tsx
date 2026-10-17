"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarClock } from "lucide-react";
import { SlotPicker } from "@/components/booking/BookingUi";
import { describeRescheduleError } from "@/lib/manual-appointment";
import "@/components/agenda/manual-appointment.css";

/**
 * "Reagendar" for an appointment the practice loaded. Shared by the agenda and its demo. Presentation and flow only:
 * the host decides when to offer it (canRescheduleAppointment), loads the free times and saves.
 * The same appointment moves: patient, service, duration and charge stay. Only times the host returns can be chosen.
 */
export function RescheduleManualAppointment({ current, currentDay, today, timezone, locale, loadSlots, onReschedule }: {
  /** When the appointment is now, as the detail shows it ("lunes 12 oct 2026 · 10:00"). */
  current: string;
  /** Its local day, YYYY-MM-DD: the date the picker starts on. */
  currentDay: string;
  /** Local date of the workspace: earlier days cannot be picked. */
  today: string;
  timezone: string; locale: string;
  /** Times the appointment can move to that day, as instants. Its own current time is never among them. */
  loadSlots: (day: string) => Promise<string[]>;
  /** Moves it. It throws with the server's message when it cannot. */
  onReschedule: (startsAt: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState(currentDay < today ? today : currentDay);
  const [slots, setSlots] = useState<string[]>([]);
  const [slotsBusy, setSlotsBusy] = useState(false);
  const [slotsError, setSlotsError] = useState("");
  const [slot, setSlot] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null);
  // Only the answer to the latest day is kept: a slow day must not overwrite a newer one.
  const run = useRef(0);
  const time = (instant: string) => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone }).format(new Date(instant));
  const longDay = (value: string) => new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));

  async function refresh(next: string) {
    const mine = ++run.current;
    setSlots([]); setSlot(""); setSlotsError("");
    if (!next) { setSlotsBusy(false); return; }
    setSlotsBusy(true);
    try { const found = await loadSlots(next); if (mine === run.current) setSlots(found); }
    catch { if (mine === run.current) setSlotsError("No pudimos cargar los horarios."); }
    finally { if (mine === run.current) setSlotsBusy(false); }
  }
  useEffect(() => { if (open) box.current?.scrollIntoView({ behavior: "smooth", block: "center" }); }, [open]);

  async function save() {
    if (saving || !slot) return;
    setSaving(true); setError("");
    // On success the host reloads and shows the appointment at its new time. Double clicks are ignored while it saves.
    try { await onReschedule(slot); setOpen(false); }
    catch (caught) {
      const failure = describeRescheduleError(caught instanceof Error ? caught.message : String(caught));
      setError(failure.text);
      if (failure.slotConflict) void refresh(day);
    } finally { setSaving(false); }
  }

  if (!open) return <button type="button" className="crm-btn rop-open rma-open" onClick={() => { setOpen(true); setError(""); void refresh(day); }}><CalendarClock size={16}/> Reagendar</button>;
  return <div ref={box} className="ma rop rma" role="group" aria-label="Reagendar turno">
    <p className="cma-title">Elegí el nuevo día y horario</p>
    <p className="ma-hint">Ahora: <b>{current}</b>. Se mueve este mismo turno: el paciente, el servicio y el cobro no cambian.</p>
    <SlotPicker day={day} min={today} onDay={(next) => { setDay(next); setError(""); void refresh(next); }} busy={slotsBusy}
      slots={slotsError ? [] : slots.map((value) => ({ value, label: time(value) }))} selected={slot} onSelect={(value) => { if (slots.includes(value)) { setSlot(value); setError(""); } }} />
    {slotsError && <p className="live-error" role="alert">{slotsError} <button type="button" onClick={() => void refresh(day)}>Reintentar</button></p>}
    <p className="ma-hint">Solo se muestran los horarios que están libres en la agenda.</p>
    {slot && <p className="rma-summary" role="status">Nuevo horario: <b>{longDay(day)} · {time(slot)}</b></p>}
    {error && <p className="live-error" role="alert">{error}</p>}
    <div className="rop-actions">
      <button type="button" className="demo-primary" disabled={saving || !slot} aria-busy={saving} onClick={() => void save()}>{saving ? "Guardando…" : "Confirmar nuevo horario"}</button>
      <button type="button" className="live-secondary" disabled={saving} onClick={() => { setOpen(false); setError(""); }}>No reagendar</button>
    </div>
  </div>;
}
