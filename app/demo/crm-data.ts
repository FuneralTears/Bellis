/** Fixed CRM fixtures for the showroom. Nothing here belongs to a real workspace. */
import type { OpportunityOverview } from "../pacientes/opportunities";
import type { Activity, Appointment, FollowUp, Intent, Note, Payment } from "../pacientes/timeline";
import { demoToday, type DemoTask } from "./showroom-data";

export const demoStatusLabels = { new: "Nuevo", active: "Activo", follow_up: "Seguimiento", inactive: "Inactivo" } as const;
export const demoProfessional = "Dra. Ana López";
export const demoServiceNames = new Map([["s1", "Consulta psicológica"], ["s2", "Primera consulta"], ["s3", "Sesión de seguimiento"]]);
const at = (date: string, time: string) => `${date}T${time}:00-03:00`;

type Seed = Pick<OpportunityOverview, "id" | "first_name" | "last_name" | "email" | "phone" | "status" | "created_at" | "last_turn" | "next_turn" | "turn_count" | "completed_turn_count" | "approved_total_minor"> & Partial<OpportunityOverview>;
function patient(seed: Seed): OpportunityOverview {
  return {
    workspace_id: "demo", full_name: `${seed.first_name} ${seed.last_name}`, date_of_birth: null, currency_code: "ARS", follow_up_due_date: null,
    last_completed_turn: seed.last_turn, pending_payment_count: 0, overdue_follow_up_count: 0, without_next_turn: false, first_completed_without_next: false,
    inactive_after_care: false, has_pending_payment: false, has_overdue_follow_up: false, has_upcoming_turn: Boolean(seed.next_turn), is_new_patient: false,
    is_recurrent_patient: seed.completed_turn_count >= 2, ...seed,
  };
}

const basePatients: OpportunityOverview[] = [
  patient({ id: "mariana-lopez", first_name: "Mariana", last_name: "López", email: "mariana.lopez@email.com", phone: "+54 9 11 4812 9021", date_of_birth: "1991-04-12", status: "active", created_at: at("2026-05-04", "10:15"), last_turn: at("2026-09-17", "09:00"), next_turn: at(demoToday, "09:00"), turn_count: 8, completed_turn_count: 7, approved_total_minor: 20000000 }),
  patient({ id: "carlos-ruiz", first_name: "Carlos", last_name: "Ruiz", email: "carlos.ruiz@email.com", phone: "+54 9 11 7304 1822", status: "follow_up", created_at: at("2026-09-22", "18:40"), last_turn: at("2026-09-30", "11:30"), next_turn: null, turn_count: 1, completed_turn_count: 1, approved_total_minor: 3000000, without_next_turn: true, first_completed_without_next: true }),
  patient({ id: "lucia-perez", first_name: "Lucía", last_name: "Pérez", email: "lucia.perez@email.com", phone: "+54 9 11 2901 3411", date_of_birth: "1987-11-02", status: "active", created_at: at("2026-07-20", "09:05"), last_turn: at("2026-09-10", "12:00"), next_turn: at(demoToday, "12:00"), turn_count: 4, completed_turn_count: 3, approved_total_minor: 7500000, has_pending_payment: true, pending_payment_count: 1 }),
  patient({ id: "tomas-mendez", first_name: "Tomás", last_name: "Méndez", email: "tomas.mendez@email.com", phone: "+54 9 11 4512 8400", status: "active", created_at: at("2026-06-11", "16:20"), last_turn: at("2026-09-18", "15:00"), next_turn: at(demoToday, "15:00"), turn_count: 6, completed_turn_count: 5, approved_total_minor: 14000000 }),
  patient({ id: "sofia-gimenez", first_name: "Sofía", last_name: "Giménez", email: "sofia.gimenez@email.com", phone: "+54 9 351 620 4417", status: "new", created_at: at("2026-09-29", "20:10"), last_turn: null, next_turn: at("2026-10-06", "10:00"), turn_count: 1, completed_turn_count: 0, approved_total_minor: 3000000, is_new_patient: true }),
  patient({ id: "jorge-castro", first_name: "Jorge", last_name: "Castro", email: "jorge.castro@email.com", phone: null, status: "inactive", created_at: at("2026-03-02", "11:00"), last_turn: at("2026-07-14", "17:00"), next_turn: null, turn_count: 4, completed_turn_count: 4, approved_total_minor: 10000000, without_next_turn: true, inactive_after_care: true }),
  patient({ id: "valentina-rios", first_name: "Valentina", last_name: "Ríos", email: "valentina.rios@email.com", phone: "+54 9 11 5320 7719", status: "active", created_at: at("2026-02-16", "08:30"), last_turn: at("2026-09-26", "10:00"), next_turn: null, turn_count: 9, completed_turn_count: 9, approved_total_minor: 22500000, without_next_turn: true }),
];

export const demoPatientId = (name: string) => basePatients.find((item) => item.full_name === name)?.id ?? name;
export function demoFollowUp(task: DemoTask): FollowUp {
  const stamp = at(task.date, task.time);
  return { id: task.id, patient_id: demoPatientId(task.patient), professional_id: "pro", title: task.title, description: task.description, due_date: task.date, due_time: task.time, priority: task.priority, status: task.status,
    source: task.source, automation_run_id: null, completed_at: task.status === "completed" ? stamp : null, cancelled_at: task.status === "cancelled" ? stamp : null, created_by: "pro", created_at: at("2026-09-30", "09:00"), updated_at: stamp };
}
/** Follow-up columns follow the showroom tasks, so completing one updates every screen. */
export function demoPatients(tasks: DemoTask[]): OpportunityOverview[] {
  return basePatients.map((item) => {
    const pending = tasks.filter((task) => task.patient === item.full_name && task.status === "pending").map((task) => task.date).sort();
    const overdue = pending.filter((date) => date < demoToday).length;
    return { ...item, follow_up_due_date: pending[0] ?? null, overdue_follow_up_count: overdue, has_overdue_follow_up: overdue > 0 };
  });
}

export type DemoAnswer = { id: string; questionnaire: string; service: string; date: string; section: string; question: string; answer: string };
type DemoDetails = { appointments: Appointment[]; intents: Intent[]; payments: Payment[]; notes: Note[]; activities: Activity[]; answers: DemoAnswer[] };
type Visit = [date: string, time: string, status: string, service: string, payment: "approved" | "pending" | null];
function details(id: string, visits: Visit[], extra: Partial<DemoDetails> = {}): DemoDetails {
  const base: DemoDetails = { appointments: [], intents: [], payments: [], notes: [], activities: [], answers: [] };
  visits.forEach(([date, time, status, service, payment], index) => {
    const key = `${id}-${index}`; const booked = new Date(new Date(at(date, "08:00")).getTime() - 7 * 864e5).toISOString();
    base.intents.push({ id: key, service_id: service, professional_id: "pro", created_at: booked });
    base.appointments.push({ id: key, booking_intent_id: key, professional_id: "pro", starts_at: at(date, time), status, created_at: booked, status_changed_at: status === "scheduled" ? null : at(date, time) });
    if (payment) base.payments.push({ id: key, booking_intent_id: key, amount_minor: service === "s2" ? 3000000 : 2500000, currency_code: "ARS", status: payment, created_at: booked, approved_at: payment === "approved" ? booked : null });
  });
  base.appointments.reverse();
  return { ...base, ...extra };
}
const note = (id: string, date: string, content: string): Note => ({ id, author_id: "pro", content, created_at: at(date, "18:00"), updated_at: at(date, "18:00") });
const activity = (id: string, date: string, type: Activity["type"], title: string, description: string): Activity => ({ id, professional_id: "pro", type, title, description, created_by: "pro", created_at: at(date, "13:30") });
const answers = (id: string, date: string, service: string, rows: [string, string, string][]): DemoAnswer[] => rows.map(([section, question, answer], index) => ({ id: `${id}-${index}`, questionnaire: "Preconsulta inicial", service, date: at(date, "08:00"), section, question, answer }));

export const demoDetails: Record<string, DemoDetails> = {
  "mariana-lopez": details("ml", [["2026-08-20", "09:00", "completed", "s1", "approved"], ["2026-09-03", "09:00", "completed", "s1", "approved"], ["2026-09-17", "09:00", "completed", "s1", "approved"], [demoToday, "09:00", "scheduled", "s1", "approved"]], {
    notes: [note("ml-n1", "2026-09-17", "Evolución\n\nMejor descanso durante la última quincena. Seguimos con registro semanal."), note("ml-n2", "2026-09-03", "Objetivos\n\nAcordamos trabajar rutinas de sueño y manejo del estrés laboral.")],
    activities: [activity("ml-a1", "2026-09-24", "whatsapp", "Recordatorio", "Confirmó asistencia al próximo turno.")],
    answers: answers("ml-q", "2026-05-04", "Primera consulta", [["Motivo", "¿Qué te trae a la consulta?", "Ansiedad y manejo del estrés."], ["Hábitos", "¿Qué áreas querés trabajar?", "Trabajo, Descanso"], ["Objetivos", "¿Qué te gustaría lograr?", "Dormir mejor y encontrar herramientas para mi día a día."]]),
  }),
  "carlos-ruiz": details("cr", [["2026-09-30", "11:30", "completed", "s2", "approved"]], {
    notes: [note("cr-n1", "2026-09-30", "Primera consulta\n\nBuena disposición. Queda pendiente coordinar la continuidad.")],
    answers: answers("cr-q", "2026-09-22", "Primera consulta", [["Motivo", "¿Qué te trae a la consulta?", "Quiero ayuda con algo puntual."], ["Objetivos", "¿Qué te gustaría lograr?", "Ordenar prioridades y bajar la autoexigencia."]]),
  }),
  "lucia-perez": details("lp", [["2026-08-13", "12:00", "completed", "s1", "approved"], ["2026-09-10", "12:00", "completed", "s1", "approved"], [demoToday, "12:00", "scheduled", "s1", "pending"]], {
    activities: [activity("lp-a1", "2026-10-01", "email", "Comprobante", "Envió el comprobante de transferencia para revisar.")],
    answers: answers("lp-q", "2026-07-20", "Primera consulta", [["Motivo", "¿Qué te trae a la consulta?", "Acompañamiento en un cambio laboral."]]),
  }),
  "tomas-mendez": details("tm", [["2026-09-04", "15:00", "completed", "s3", "approved"], ["2026-09-18", "15:00", "completed", "s3", "approved"], [demoToday, "15:00", "scheduled", "s3", "approved"]], {
    notes: [note("tm-n1", "2026-09-18", "Seguimiento\n\nSostiene los avances. Revisar continuidad en la próxima sesión.")],
  }),
  "sofia-gimenez": details("sg", [["2026-10-06", "10:00", "scheduled", "s2", "approved"]], {
    answers: answers("sg-q", "2026-09-29", "Primera consulta", [["Motivo", "¿Qué te trae a la consulta?", "Primera vez en terapia, quiero empezar un proceso."], ["Hábitos", "¿Qué áreas querés trabajar?", "Vínculos, Estudio"]]),
  }),
  "jorge-castro": details("jc", [["2026-06-16", "17:00", "completed", "s1", "approved"], ["2026-06-30", "17:00", "completed", "s1", "approved"], ["2026-07-14", "17:00", "completed", "s1", "approved"]], {
    activities: [activity("jc-a1", "2026-08-12", "call", "Llamada", "Sin respuesta. Volver a intentar más adelante.")],
  }),
  "valentina-rios": details("vr", [["2026-08-29", "10:00", "completed", "s3", "approved"], ["2026-09-12", "10:00", "completed", "s3", "approved"], ["2026-09-26", "10:00", "completed", "s3", "approved"]], {
    notes: [note("vr-n1", "2026-09-26", "Cierre de etapa\n\nEvaluamos espaciar las sesiones a una por mes.")],
  }),
};
