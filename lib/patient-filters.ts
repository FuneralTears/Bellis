/**
 * The patient list shows a short "Mostrar" choice and keeps the rest under "Más filtros". Both are views over the
 * same three filters the list already had; nothing here changes what a filter means or what is queried.
 *   opportunity: "all", "attention" or one specific situation (pending payment, without next turn…)
 *   followUp:    "all", "with", "without", "overdue" or "today"
 *   status:      "all" or the patient's own status
 */
export type FollowUpFilter = "all" | "with" | "without" | "overdue" | "today";
export type PatientFilterState = { status: string; followUp: FollowUpFilter; opportunity: string };

export type ShowFilter = "all" | "attention" | "with" | "without";
export const showOptions: { value: ShowFilter; label: string }[] = [
  { value: "all", label: "Todos" }, { value: "attention", label: "Necesitan atención" },
  { value: "with", label: "Con seguimiento" }, { value: "without", label: "Sin seguimiento" },
];
export type DueFilter = "all" | "overdue" | "today";
export const dueOptions: { value: DueFilter; label: string }[] = [
  { value: "all", label: "Todos los seguimientos" }, { value: "overdue", label: "Vencidos" }, { value: "today", label: "Hoy" },
];
export const statusOptions = [
  { value: "all", label: "Todos los estados" }, { value: "new", label: "Nuevos" }, { value: "active", label: "Activos" },
  { value: "follow_up", label: "En seguimiento" }, { value: "inactive", label: "Inactivos" },
] as const;

/** What "Mostrar" has selected. A specific situation or a due date chosen under "Más filtros" leaves it on "Todos". */
export function showOf(state: PatientFilterState): ShowFilter {
  if (state.followUp === "with" || state.followUp === "without") return state.followUp;
  return state.opportunity === "attention" ? "attention" : "all";
}

/** One choice at a time, as it reads: picking one clears the other choices of "Mostrar" and nothing else. */
export function applyShow(state: PatientFilterState, show: ShowFilter): PatientFilterState {
  const followUp = show === "with" || show === "without" ? show : state.followUp === "with" || state.followUp === "without" ? "all" : state.followUp;
  const opportunity = show === "attention" ? "attention" : state.opportunity === "attention" ? "all" : state.opportunity;
  return { ...state, followUp, opportunity };
}

export function dueOf(state: PatientFilterState): DueFilter {
  return state.followUp === "overdue" || state.followUp === "today" ? state.followUp : "all";
}

/** "Vencidos" and "Hoy" are follow-up filters too, so they replace "Con/Sin seguimiento". "Todos" only clears a due date. */
export function applyDue(state: PatientFilterState, due: DueFilter): PatientFilterState {
  if (due === "all") return dueOf(state) === "all" ? state : { ...state, followUp: "all" };
  return { ...state, followUp: due };
}

/** The specific situation chosen under "Más filtros", or "all". "Necesitan atención" is not one of them. */
export function situationOf(state: PatientFilterState): string {
  return state.opportunity === "attention" ? "all" : state.opportunity;
}

/** A specific situation replaces "Necesitan atención": the list filtered by one of them at a time already. */
export function applySituation(state: PatientFilterState, situation: string): PatientFilterState {
  if (situation === "all") return situationOf(state) === "all" ? state : { ...state, opportunity: "all" };
  return { ...state, opportunity: situation };
}

/** How many filters under "Más filtros" are on, so the closed button can say so. */
export function advancedCount(state: PatientFilterState): number {
  return (state.status !== "all" ? 1 : 0) + (dueOf(state) !== "all" ? 1 : 0) + (situationOf(state) !== "all" ? 1 : 0);
}
