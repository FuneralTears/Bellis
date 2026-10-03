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
export const demoRuns = [
  {
    id: "demo-run-2",
    ruleId: "demo-rule-1",
    patient: "Carlos Ruiz",
    date: "3 oct · 08:10",
    status: "failed",
    detail: "No se pudo crear el seguimiento. Ejecución de ejemplo con error.",
  },
  {
    id: "demo-run-3",
    ruleId: "demo-rule-2",
    patient: "Tomás Méndez",
    date: "2 oct · 17:30",
    status: "skipped",
    detail: "Omitida: el paciente ya tiene un próximo turno.",
  },
  {
    id: "demo-run-1",
    ruleId: "demo-rule-3",
    patient: "Lucía Pérez",
    date: "2 oct · 08:15",
    status: "completed",
    detail: "Seguimiento creado: verificar pago pendiente.",
  },
];
export type DemoNotification = {
  id: string;
  title: string;
  message: string;
  time: string;
  read: boolean;
  target: "Seguimientos" | "Automatizaciones";
  failed: boolean;
};
export const demoNotifications: DemoNotification[] = [
  {
    id: "demo-notification-1",
    title: "Seguimiento creado",
    message: "Lucía Pérez · Verificar pago pendiente.",
    time: "2 oct, 08:15",
    read: false,
    target: "Seguimientos",
    failed: false,
  },
  {
    id: "demo-notification-2",
    title: "Una automatización requiere revisión",
    message: "Primera consulta sin próximo turno · Carlos Ruiz.",
    time: "3 oct, 08:10",
    read: false,
    target: "Automatizaciones",
    failed: true,
  },
  {
    id: "demo-notification-3",
    title: "Seguimiento creado",
    message: "Mariana López · Revisar evolución.",
    time: "2 oct, 16:00",
    read: true,
    target: "Seguimientos",
    failed: false,
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
