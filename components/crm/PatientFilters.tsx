"use client";

import { useId, useState } from "react";
import { Search } from "lucide-react";
import { advancedCount, applyDue, applyShow, applySituation, dueOf, dueOptions, showOf, showOptions, situationOf, statusOptions, type PatientFilterState } from "@/lib/patient-filters";

/**
 * Filters of the patient list, shared by /pacientes and its demo. The search, a short "Mostrar" choice and the
 * order are always there; the rest waits under "Más filtros", closed until asked for.
 * Presentation only: the host keeps the three filters it always had and decides what they query.
 */
export function PatientFilters({ query, onQuery, sort, onSort, filters, onFilters, situations }: {
  query: string; onQuery: (value: string) => void;
  sort: string; onSort: (value: string) => void;
  filters: PatientFilterState; onFilters: (next: PatientFilterState) => void;
  /** The specific situations a patient can be filtered by ("Pagos pendientes"…). */
  situations: { value: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const active = advancedCount(filters);
  const chips = <T extends string>(options: readonly { value: T; label: string }[], selected: string, choose: (value: T) => void) =>
    options.map((item) => <button key={item.value} type="button" aria-pressed={selected === item.value} className={selected === item.value ? "on" : ""} onClick={() => choose(item.value)}>{item.label}</button>);

  return <div className="crm-patient-filters">
    <div className="crm-filterbar">
      <label className="crm-search"><Search size={18}/><input type="search" aria-label="Buscar pacientes" placeholder="Buscar por nombre, teléfono o email" value={query} onChange={(event) => onQuery(event.target.value)}/></label>
      <label className="crm-select">Ordenar por <select value={sort} onChange={(event) => onSort(event.target.value)}><option value="last_turn">Último turno</option><option value="next_turn">Próximo turno</option><option value="full_name">Nombre</option></select></label>
      <button type="button" className="crm-btn crm-more-filters" aria-expanded={open} aria-controls={`${id}-more`} onClick={() => setOpen(!open)}>
        {open ? "Ocultar filtros" : "Más filtros"}{active > 0 && ` (${active} ${active === 1 ? "activo" : "activos"})`}
      </button>
    </div>
    <div className="crm-filter-group" role="group" aria-labelledby={`${id}-show`}>
      <span id={`${id}-show`}>Mostrar</span>
      <div className="crm-chips">{chips(showOptions, showOf(filters), (value) => onFilters(applyShow(filters, value)))}</div>
    </div>
    {open && <div id={`${id}-more`} className="crm-more">
      <div className="crm-filter-group" role="group" aria-labelledby={`${id}-status`}>
        <span id={`${id}-status`}>Estado del paciente</span>
        <div className="crm-chips">{chips(statusOptions, filters.status, (value) => onFilters({ ...filters, status: value }))}</div>
      </div>
      <div className="crm-filter-group" role="group" aria-labelledby={`${id}-due`}>
        <span id={`${id}-due`}>Seguimientos</span>
        <div className="crm-chips">{chips(dueOptions, dueOf(filters), (value) => onFilters(applyDue(filters, value)))}</div>
      </div>
      <div className="crm-filter-group">
        <label htmlFor={`${id}-situation`}>Situación puntual</label>
        <select id={`${id}-situation`} className="crm-filter-select" value={situationOf(filters)} onChange={(event) => onFilters(applySituation(filters, event.target.value))}>
          <option value="all">Cualquiera</option>{situations.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </div>
    </div>}
  </div>;
}
