"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Search, UserPlus, X } from "lucide-react";
import { SlotPicker } from "@/components/booking/BookingUi";
import { NewPatientForm, type NewPatientValues } from "@/components/crm/NewPatientForm";
import type { DuplicateCandidate } from "@/lib/patient-duplicates";
import { afterCreateError, draftProblem, emptyDraft, paymentArgs, paymentMethodLabels, paymentMethods, paymentProblem, selectDay, selectProfessional, selectService, selectSlot, setPaid, type ManualDraft, type PaymentMethod } from "@/lib/manual-appointment";
import "./manual-appointment.css";

export type ManualPatient = { id: string; full_name: string; phone: string | null; email: string | null };
export type ManualService = { id: string; professional_id: string; name: string; duration_minutes: number; price_minor: number };
export type ManualProfessional = { id: string; display_name: string };
export type ManualAppointmentInput = { patient: ManualPatient; professional: ManualProfessional; service: ManualService; startsAt: string; method: PaymentMethod | null; amountMinor: number | null };

/**
 * "Nuevo turno" of the agenda, shared with its demo. One card with sections that open as the previous one is
 * answered. Presentation and flow only: the host searches patients, loads the free times and saves.
 * Only times the host returns can be chosen; there is no free time field and no way to force one.
 */
export function ManualAppointmentForm({ professionals, services, timezone, locale, today, formatMoney, searchPatients, lookupDuplicates, createPatient, loadSlots, onCreate, onCancel }: {
  /** The agendas this person can load. With one, no selector is shown. */
  professionals: ManualProfessional[];
  /** Active services of those professionals. */
  services: ManualService[];
  timezone: string; locale: string;
  /** Local date of the workspace, YYYY-MM-DD: earlier days cannot be picked. */
  today: string;
  formatMoney: (minor: number) => string;
  searchPatients: (query: string) => Promise<ManualPatient[]>;
  lookupDuplicates: (phone: string, email: string | null) => Promise<DuplicateCandidate[]>;
  createPatient: (values: NewPatientValues) => Promise<ManualPatient>;
  /** Free start times for that agenda, service and day, as instants. */
  loadSlots: (professionalId: string, serviceId: string, day: string) => Promise<string[]>;
  onCreate: (input: ManualAppointmentInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ManualDraft>(() => emptyDraft(professionals.length === 1 ? professionals[0].id : ""));
  const [patient, setPatient] = useState<ManualPatient | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ManualPatient[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [quick, setQuick] = useState(false);
  const [slots, setSlots] = useState<string[]>([]);
  const [slotsBusy, setSlotsBusy] = useState(false);
  const [slotsError, setSlotsError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Where the failure is told: a time that was taken is told next to the times, where the person has to act.
  const [errorAtSlots, setErrorAtSlots] = useState(false);
  const errorBox = useRef<HTMLParagraphElement>(null);
  // Only the answer to the latest question is kept: a slow search or a slow day must not overwrite a newer one.
  const searchRun = useRef(0);
  const slotsRun = useRef(0);

  useEffect(() => {
    const text = query.trim();
    const run = ++searchRun.current;
    if (patient || text.length < 2) return;
    const timer = setTimeout(() => {
      setSearching(true); setSearchError("");
      searchPatients(text).then((found) => { if (run === searchRun.current) setResults(found); })
        .catch(() => { if (run === searchRun.current) { setResults(null); setSearchError("No pudimos buscar pacientes. Intentá de nuevo."); } })
        .finally(() => { if (run === searchRun.current) setSearching(false); });
    }, 300);
    return () => clearTimeout(timer);
  }, [query, patient, searchPatients]);

  // A failed save can leave its message outside the screen: the sections after the time close and the page moves.
  // The message is brought into view and takes the focus, so it is seen and read out.
  useEffect(() => {
    if (!error || !errorBox.current) return;
    errorBox.current.scrollIntoView({ block: "center" });
    errorBox.current.focus({ preventScroll: true });
  }, [error, errorAtSlots]);

  const professional = professionals.find((item) => item.id === draft.professionalId) ?? null;
  const offered = services.filter((item) => item.professional_id === draft.professionalId);
  const service = offered.find((item) => item.id === draft.serviceId) ?? null;
  const time = (instant: string) => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone }).format(new Date(instant));
  const longDay = (day: string) => new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
  const problem = draftProblem(draft);
  const payment = paymentArgs(draft);

  // Asked from the handlers that change what the times depend on. An unfinished choice clears the list.
  async function refreshSlots(next: ManualDraft) {
    const run = ++slotsRun.current;
    setSlots([]); setSlotsError("");
    if (!next.professionalId || !next.serviceId || !next.day) { setSlotsBusy(false); return; }
    setSlotsBusy(true);
    try { const found = await loadSlots(next.professionalId, next.serviceId, next.day); if (run === slotsRun.current) setSlots(found); }
    catch { if (run === slotsRun.current) setSlotsError("No pudimos cargar los horarios."); }
    finally { if (run === slotsRun.current) setSlotsBusy(false); }
  }
  const change = (next: ManualDraft, reload = false) => { setDraft(next); setError(""); setErrorAtSlots(false); if (reload) void refreshSlots(next); };
  const choosePatient = (next: ManualPatient) => { setPatient(next); setQuick(false); setQuery(""); setResults(null); change({ ...draft, patientId: next.id }); };
  const clearPatient = () => { setPatient(null); change({ ...draft, patientId: "" }); };

  async function create() {
    if (saving || problem || !patient || !professional || !service) return;
    setSaving(true); setError(""); setErrorAtSlots(false);
    try { await onCreate({ patient, professional, service, startsAt: draft.slot, method: payment.method, amountMinor: payment.amountMinor }); }
    catch (caught) {
      // The time is gone: ask again and drop only the time. Patient, service, day and payment stay as they were.
      const failure = afterCreateError(draft, caught instanceof Error ? caught.message : String(caught));
      setDraft(failure.draft); setError(failure.text); setErrorAtSlots(failure.refreshSlots);
      if (failure.refreshSlots) void refreshSlots(failure.draft);
    } finally { setSaving(false); }
  }

  return <section className="crm-main ma" aria-labelledby="ma-title">
    <div className="ma-card">
      <header className="ma-head"><h2 id="ma-title">Nuevo turno</h2><button type="button" className="ma-close" aria-label="Cerrar" disabled={saving} onClick={onCancel}><X size={18}/></button></header>

      <div className="ma-section">
        <h3><span className="ma-step">1</span> Paciente</h3>
        {patient ? <div className="ma-chosen"><span><b>{patient.full_name}</b><small>{[patient.phone, patient.email].filter(Boolean).join(" · ") || "Sin datos de contacto"}</small></span><button type="button" className="crm-btn" disabled={saving} onClick={clearPatient}>Cambiar</button></div>
          : quick ? <NewPatientForm lookup={lookupDuplicates} onCancel={() => setQuick(false)}
              onSave={async (values) => choosePatient(await createPatient(values))}
              renderOpen={(found, _content, variant) => <button type="button" className={variant === "primary" ? "demo-primary" : "crm-link"} onClick={() => choosePatient({ id: found.id, full_name: found.full_name, phone: found.phone, email: found.email })}>Usar este paciente</button>}/>
          : <>
            <label className="ma-search"><Search size={16}/><input autoFocus type="search" aria-label="Buscar paciente" placeholder="Buscar por nombre, teléfono o email" value={query} onChange={(event) => { setQuery(event.target.value); if (event.target.value.trim().length < 2) { setResults(null); setSearchError(""); } }}/></label>
            {searchError && <p className="live-error" role="alert">{searchError}</p>}
            {searching && !results && <p className="ma-hint" role="status">Buscando…</p>}
            {results && (results.length ? <ul className="ma-results" aria-label="Pacientes encontrados">{results.map((item) => <li key={item.id}><button type="button" onClick={() => choosePatient(item)}><b>{item.full_name}</b><small>{[item.phone, item.email].filter(Boolean).join(" · ") || "Sin datos de contacto"}</small></button></li>)}</ul>
              : <p className="ma-hint">No encontramos pacientes con esos datos.</p>)}
            <button type="button" className="crm-btn ma-quick" onClick={() => setQuick(true)}><UserPlus size={15}/> Crear paciente rápido</button>
          </>}
      </div>

      {patient && <div className="ma-section">
        <h3><span className="ma-step">2</span> Servicio</h3>
        {professionals.length > 1 && <label className="ma-field">Profesional<select value={draft.professionalId} disabled={saving} onChange={(event) => change(selectProfessional(draft, event.target.value), true)}><option value="">Elegí un profesional</option>{professionals.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label>}
        {!draft.professionalId ? <p className="ma-hint">Elegí un profesional para ver sus servicios.</p>
          : offered.length ? <div className="ma-options" role="radiogroup" aria-label="Servicio">{offered.map((item) => <button key={item.id} type="button" role="radio" aria-checked={draft.serviceId === item.id} className={draft.serviceId === item.id ? "ma-option on" : "ma-option"} disabled={saving} onClick={() => change(selectService(draft, item), true)}>
            <span><b>{item.name}</b><small>{item.duration_minutes} min</small></span><strong>{formatMoney(item.price_minor)}</strong></button>)}</div>
          : <p className="ma-hint">Este profesional no tiene servicios activos. Creá uno en Servicios.</p>}
      </div>}

      {patient && service && <div className="ma-section">
        <h3><span className="ma-step">3</span> Fecha y horario</h3>
        {error && errorAtSlots && <p ref={errorBox} tabIndex={-1} className="live-error ma-conflict" role="alert">{error}</p>}
        <SlotPicker day={draft.day} min={today} onDay={(day) => change(selectDay(draft, day), true)} busy={slotsBusy} slots={slotsError ? [] : slots.map((value) => ({ value, label: time(value) }))} selected={draft.slot} onSelect={(value) => change(selectSlot(draft, value, slots))} />
        {slotsError && <p className="live-error" role="alert">{slotsError} <button type="button" onClick={() => void refreshSlots(draft)}>Reintentar</button></p>}
        <p className="ma-hint">Son los horarios libres de la agenda. Los turnos manuales no usan la anticipación mínima del servicio.</p>
      </div>}

      {patient && service && draft.slot && <div className="ma-section">
        <h3><span className="ma-step">4</span> Cobro</h3>
        <div className="ma-options ma-options-two" role="radiogroup" aria-label="Estado del cobro">
          <button type="button" role="radio" aria-checked={!draft.paid} className={!draft.paid ? "ma-option on" : "ma-option"} disabled={saving} onClick={() => change(setPaid(draft, false))}><span><b>Pendiente</b><small>Todavía no se cobró</small></span></button>
          <button type="button" role="radio" aria-checked={draft.paid} className={draft.paid ? "ma-option on" : "ma-option"} disabled={saving} onClick={() => change(setPaid(draft, true))}><span><b>Pagado fuera de Bellis</b><small>Efectivo, transferencia u otro</small></span></button>
        </div>
        {draft.paid && <div className="ma-payment">
          <div className="ma-methods" role="radiogroup" aria-label="Medio de cobro">{paymentMethods.map((method) => <button key={method} type="button" role="radio" aria-checked={draft.method === method} className={draft.method === method ? "on" : ""} disabled={saving} onClick={() => change({ ...draft, method })}>{paymentMethodLabels[method]}</button>)}</div>
          <label className="ma-field">Importe cobrado (ARS)<input inputMode="decimal" autoComplete="off" disabled={saving} value={draft.amount} onChange={(event) => change({ ...draft, amount: event.target.value })}/></label>
          <p className="ma-hint">No es un cobro de Mercado Pago: Bellis solo registra que ya lo cobraste. Precio del servicio: {formatMoney(service.price_minor)}.</p>
        </div>}
      </div>}

      {patient && professional && service && draft.slot && <div className="ma-section">
        <h3><span className="ma-step">5</span> Confirmación</h3>
        <dl className="ma-summary">
          <div><dt>Paciente</dt><dd>{patient.full_name}</dd></div>
          <div><dt>Servicio</dt><dd>{service.name}</dd></div>
          <div><dt>Profesional</dt><dd>{professional.display_name}</dd></div>
          <div><dt>Fecha</dt><dd>{longDay(draft.day)}</dd></div>
          <div><dt>Hora</dt><dd>{time(draft.slot)}</dd></div>
          <div><dt>Duración</dt><dd>{service.duration_minutes} minutos</dd></div>
          <div><dt>Cobro</dt><dd>{draft.paid ? (payment.method && payment.amountMinor ? `${paymentMethodLabels[payment.method]} · ${formatMoney(payment.amountMinor)} · pagado fuera de Bellis` : "Pagado fuera de Bellis") : "Pendiente"}</dd></div>
        </dl>
        {draft.paid && paymentProblem(draft) && <p className="ma-hint ma-missing">{paymentProblem(draft)}</p>}
      </div>}

      {error && !errorAtSlots && <p ref={errorBox} tabIndex={-1} className="live-error" role="alert">{error}</p>}
      <div className="ma-actions">
        <button type="button" className="demo-primary" disabled={saving || !!problem} aria-busy={saving} onClick={() => void create()}>{saving ? "Creando…" : <><Check size={16}/> Crear turno</>}</button>
        <button type="button" className="live-secondary" disabled={saving} onClick={onCancel}>Cancelar</button>
        {problem && !draft.slot && <span className="ma-hint">{problem}</span>}
      </div>
    </div>
  </section>;
}
