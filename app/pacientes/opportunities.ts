import type { PatientOverview } from "./crm";

export type OpportunityOverview = PatientOverview & {
  completed_turn_count: number;
  last_completed_turn: string | null;
  pending_payment_count: number;
  overdue_follow_up_count: number;
  without_next_turn: boolean;
  first_completed_without_next: boolean;
  inactive_after_care: boolean;
  has_pending_payment: boolean;
  has_overdue_follow_up: boolean;
  has_upcoming_turn: boolean;
  is_new_patient: boolean;
  is_recurrent_patient: boolean;
};

export type OpportunityKind = "pending_payment" | "overdue_follow_up" | "first_without_next" | "inactive" | "without_next" | "upcoming" | "new" | "recurrent";
export type Opportunity = { kind: OpportunityKind; title: string; reason: string; level: "attention" | "context"; priority: number };

export const opportunityFilters: { kind: OpportunityKind | "all" | "attention"; label: string; column?: keyof OpportunityOverview }[] = [
  { kind: "all", label: "Todos" },
  { kind: "attention", label: "Requieren atención" },
  { kind: "pending_payment", label: "Pagos pendientes", column: "has_pending_payment" },
  { kind: "overdue_follow_up", label: "Seguimientos vencidos", column: "has_overdue_follow_up" },
  { kind: "first_without_next", label: "Primera consulta sin próximo turno", column: "first_completed_without_next" },
  { kind: "inactive", label: "Inactivos", column: "inactive_after_care" },
  { kind: "without_next", label: "Sin próximo turno", column: "without_next_turn" },
  { kind: "upcoming", label: "Turno próximo", column: "has_upcoming_turn" },
  { kind: "new", label: "Nuevos", column: "is_new_patient" },
  { kind: "recurrent", label: "Recurrentes", column: "is_recurrent_patient" },
];

export function detectOpportunities(patient: OpportunityOverview): Opportunity[] {
  const result: Opportunity[] = [];
  if (patient.has_pending_payment) result.push({ kind: "pending_payment", title: "Pago pendiente", reason: `${patient.pending_payment_count} ${patient.pending_payment_count === 1 ? "pago pendiente" : "pagos pendientes"} de cobro o verificación.`, level: "attention", priority: 0 });
  if (patient.has_overdue_follow_up) result.push({ kind: "overdue_follow_up", title: "Seguimiento vencido", reason: `${patient.overdue_follow_up_count} ${patient.overdue_follow_up_count === 1 ? "acción pendiente venció" : "acciones pendientes vencieron"}.`, level: "attention", priority: 1 });
  if (patient.first_completed_without_next) result.push({ kind: "first_without_next", title: "Primera consulta sin próximo turno", reason: "La primera consulta terminó y todavía no hay otro turno reservado.", level: "attention", priority: 2 });
  if (patient.inactive_after_care) result.push({ kind: "inactive", title: "Paciente inactivo", reason: "Pasaron más de 60 días desde el último turno completado y no tiene uno próximo.", level: "attention", priority: 3 });
  if (patient.without_next_turn && !patient.first_completed_without_next && !patient.inactive_after_care) result.push({ kind: "without_next", title: "Sin próximo turno", reason: "Tuvo al menos un turno completado y no tiene otro reservado.", level: "attention", priority: 4 });
  if (patient.has_upcoming_turn) result.push({ kind: "upcoming", title: "Turno próximo", reason: "Tiene un turno reservado.", level: "context", priority: 5 });
  if (patient.is_new_patient) result.push({ kind: "new", title: "Paciente nuevo", reason: "Se registró en los últimos 30 días y aún no completó un turno.", level: "context", priority: 6 });
  if (patient.is_recurrent_patient) result.push({ kind: "recurrent", title: "Paciente recurrente", reason: "Ya completó dos o más turnos.", level: "context", priority: 7 });
  return result;
}

export function hasAttention(patient: OpportunityOverview): boolean {
  return patient.has_pending_payment || patient.has_overdue_follow_up || patient.without_next_turn;
}
