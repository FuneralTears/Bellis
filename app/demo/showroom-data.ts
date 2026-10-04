/** Fixed showroom fixtures. No IDs or records belong to a real workspace. */
export const demoToday = "2026-10-03";
export type DemoTask = {
  id: string;
  patient: string;
  title: string;
  description: string;
  date: string;
  time: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "completed" | "cancelled";
  source: "manual" | "automation";
};
export const demoTasks: DemoTask[] = [
  {
    id: "demo-task-1",
    patient: "Lucía Pérez",
    title: "Verificar pago pendiente",
    description: "Revisar el comprobante antes de confirmar la reserva.",
    date: "2026-10-02",
    time: "10:00",
    priority: "high",
    status: "pending",
    source: "automation",
  },
  {
    id: "demo-task-2",
    patient: "Mariana López",
    title: "Revisar evolución",
    description: "Revisar las notas de la última consulta.",
    date: demoToday,
    time: "11:00",
    priority: "medium",
    status: "pending",
    source: "manual",
  },
  {
    id: "demo-task-3",
    patient: "Carlos Ruiz",
    title: "Coordinar próxima consulta",
    description: "Primera consulta completada, sin un próximo turno.",
    date: "2026-10-05",
    time: "09:00",
    priority: "medium",
    status: "pending",
    source: "manual",
  },
  {
    id: "demo-task-4",
    patient: "Tomás Méndez",
    title: "Revisar continuidad de atención",
    description: "Revisar la continuidad en la próxima sesión agendada.",
    date: "2026-10-08",
    time: "14:00",
    priority: "low",
    status: "pending",
    source: "automation",
  },
  {
    id: "demo-task-5",
    patient: "Mariana López",
    title: "Revisar notas de consulta",
    description: "Notas revisadas y seguimiento completado.",
    date: "2026-10-01",
    time: "16:00",
    priority: "medium",
    status: "completed",
    source: "manual",
  },
];
export type DemoRule = {
  id: string;
  kind: "first_consultation" | "inactive_patient" | "pending_payment";
  name: string;
  description: string;
  trigger: string;
  condition: string;
  delay: number;
  unit: string;
  priority: "high" | "medium" | "low";
  action: string;
  enabled: boolean;
};
export const demoRules: DemoRule[] = [
  {
    id: "demo-rule-1",
    kind: "first_consultation",
    name: "Primera consulta sin próximo turno",
    description:
      "Crea una tarea para revisar la continuidad después de la primera consulta.",
    trigger: "Se completa la primera consulta",
    condition: "Sin próximo turno; una sola consulta completada",
    delay: 3,
    unit: "días",
    priority: "medium",
    action: "Coordinar próxima consulta",
    enabled: true,
  },
  {
    id: "demo-rule-2",
    kind: "inactive_patient",
    name: "Paciente inactivo",
    description:
      "Crea un seguimiento cuando no hay consultas recientes ni un turno próximo.",
    trigger: "Se completa un turno",
    condition: "Sin otro turno completado ni uno próximo durante el plazo",
    delay: 60,
    unit: "días",
    priority: "low",
    action: "Revisar continuidad de atención",
    enabled: false,
  },
  {
    id: "demo-rule-3",
    kind: "pending_payment",
    name: "Pago pendiente",
    description:
      "Crea una tarea para verificar un pago que continúa pendiente.",
    trigger: "Se registra un pago pendiente",
    condition: "El pago y la reserva siguen pendientes",
    delay: 24,
    unit: "horas",
    priority: "high",
    action: "Verificar pago pendiente",
    enabled: true,
  },
];
export type DemoRun = {
  id: string;
  ruleId: string;
  patient: string;
  status: "scheduled" | "processing" | "completed" | "failed" | "skipped" | "cancelled";
  created: string;
  scheduled: string;
  executed: string;
  attempts: number;
  result: string;
  detail: string;
};
export const demoRuns: DemoRun[] = [
  {
    id: "demo-run-7",
    ruleId: "demo-rule-1",
    patient: "Mariana López",
    status: "processing",
    created: "30/09/2026, 12:00",
    scheduled: "03/10/2026, 12:00",
    executed: "—",
    attempts: 1,
    result: "—",
    detail: "Pendiente de ejecución.",
  },
  {
    id: "demo-run-6",
    ruleId: "demo-rule-3",
    patient: "Lucía Pérez",
    status: "scheduled",
    created: "03/10/2026, 09:05",
    scheduled: "04/10/2026, 09:05",
    executed: "—",
    attempts: 0,
    result: "—",
    detail: "Pendiente de ejecución.",
  },
  {
    id: "demo-run-2",
    ruleId: "demo-rule-1",
    patient: "Carlos Ruiz",
    status: "failed",
    created: "30/09/2026, 11:30",
    scheduled: "03/10/2026, 08:10",
    executed: "03/10/2026, 08:10",
    attempts: 3,
    result: "Requiere revisión",
    detail:
      "No se pudo crear el seguimiento. La ejecución quedó registrada para revisión.",
  },
  {
    id: "demo-run-3",
    ruleId: "demo-rule-2",
    patient: "Tomás Méndez",
    status: "skipped",
    created: "03/08/2026, 17:30",
    scheduled: "02/10/2026, 17:30",
    executed: "02/10/2026, 17:30",
    attempts: 1,
    result: "Ya tiene un próximo turno",
    detail: "El paciente ya tiene un próximo turno.",
  },
  {
    id: "demo-run-1",
    ruleId: "demo-rule-3",
    patient: "Lucía Pérez",
    status: "completed",
    created: "01/10/2026, 08:15",
    scheduled: "02/10/2026, 08:15",
    executed: "02/10/2026, 08:15",
    attempts: 1,
    result: "Seguimiento creado",
    detail: "Seguimiento creado correctamente.",
  },
  {
    id: "demo-run-4",
    ruleId: "demo-rule-1",
    patient: "Valentina Ríos",
    status: "completed",
    created: "26/09/2026, 10:00",
    scheduled: "29/09/2026, 10:00",
    executed: "29/09/2026, 10:00",
    attempts: 1,
    result: "Seguimiento creado",
    detail: "Seguimiento creado correctamente.",
  },
  {
    id: "demo-run-5",
    ruleId: "demo-rule-2",
    patient: "Jorge Castro",
    status: "skipped",
    created: "14/07/2026, 17:00",
    scheduled: "12/09/2026, 17:00",
    executed: "12/09/2026, 17:00",
    attempts: 1,
    result: "Regla desactivada o reactivada después del evento",
    detail: "Regla desactivada o reactivada después del evento.",
  },
  {
    id: "demo-run-8",
    ruleId: "demo-rule-3",
    patient: "Jorge Castro",
    status: "cancelled",
    created: "08/09/2026, 09:40",
    scheduled: "09/09/2026, 09:40",
    executed: "—",
    attempts: 0,
    result: "—",
    detail: "Pendiente de ejecución.",
  },
];
export type DemoNotification = {
  id: string;
  patient: string;
  time: string;
  read: boolean;
  kind: "created" | "failed" | "skipped" | "completed";
  /** Like production: run notifications open that run; follow-up ones open the task list. */
  runId?: string;
};
export const demoNotifications: DemoNotification[] = [
  {
    id: "demo-notification-2",
    patient: "Carlos Ruiz",
    time: "hoy, 08:10",
    read: false,
    kind: "failed",
    runId: "demo-run-2",
  },
  {
    id: "demo-notification-1",
    patient: "Lucía Pérez",
    time: "ayer, 08:15",
    read: false,
    kind: "created",
  },
  {
    id: "demo-notification-3",
    patient: "Mariana López",
    time: "ayer, 16:00",
    read: true,
    kind: "created",
  },
  {
    id: "demo-notification-5",
    patient: "Tomás Méndez",
    time: "ayer, 17:30",
    read: true,
    kind: "skipped",
    runId: "demo-run-3",
  },
  {
    id: "demo-notification-6",
    patient: "Valentina Ríos",
    time: "hace 4 días",
    read: true,
    kind: "completed",
    runId: "demo-run-4",
  },
  {
    id: "demo-notification-4",
    patient: "Valentina Ríos",
    time: "hace 4 días",
    read: true,
    kind: "created",
  },
];
export type DemoService = {
  name: string;
  price: number;
  duration: number;
  mode: string;
  active: boolean;
};
export const demoServices: DemoService[] = [
  {
    name: "Consulta psicológica",
    price: 25000,
    duration: 60,
    mode: "Online",
    active: true,
  },
  {
    name: "Primera consulta",
    price: 30000,
    duration: 75,
    mode: "Online y presencial",
    active: true,
  },
  {
    name: "Sesión de seguimiento",
    price: 22000,
    duration: 50,
    mode: "Online",
    active: false,
  },
];
export const demoAppointments = [
  {
    time: "09:00",
    name: "Mariana López",
    service: "Consulta psicológica",
    status: "Confirmado",
    paid: true,
  },
  {
    time: "12:00",
    name: "Lucía Pérez",
    service: "Consulta psicológica",
    status: "Pendiente",
    paid: false,
  },
  {
    time: "15:00",
    name: "Tomás Méndez",
    service: "Sesión de seguimiento",
    status: "Confirmado",
    paid: true,
  },
];
export const demoPatients = [
  {
    name: "Mariana López",
    email: "mariana.lopez@email.com",
    phone: "+54 9 11 4812 9021",
    last: "17/09/2026",
    next: "03/10/2026",
    sessions: 7,
  },
  {
    name: "Carlos Ruiz",
    email: "carlos.ruiz@email.com",
    phone: "+54 9 11 7304 1822",
    last: "30/09/2026",
    next: "—",
    sessions: 1,
  },
  {
    name: "Lucía Pérez",
    email: "lucia.perez@email.com",
    phone: "+54 9 11 2901 3411",
    last: "10/09/2026",
    next: "03/10/2026",
    sessions: 3,
  },
  {
    name: "Tomás Méndez",
    email: "tomas.mendez@email.com",
    phone: "+54 9 11 4512 8400",
    last: "18/09/2026",
    next: "03/10/2026",
    sessions: 5,
  },
];
