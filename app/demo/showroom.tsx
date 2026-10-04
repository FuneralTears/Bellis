"use client";

import { useState } from "react";
import {
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  CircleAlert,
  Clock3,
  CreditCard,
  FileText,
  ListChecks,
  Search,
  Users,
} from "lucide-react";
import { followUpBucket, priorityLabels } from "../pacientes/timeline";
import {
  detectOpportunities,
  hasAttention,
  opportunityFilters,
} from "../pacientes/opportunities";
import {
  FollowUpsTable,
  GroupTitle,
  KpiStrip,
  OpportunityRow,
  PageHeader,
  groupFollowUps,
} from "@/components/crm/CrmUi";
import { demoFollowUp, demoPatients } from "./crm-data";
import {
  demoNotifications,
  demoRules,
  demoRuns,
  demoTasks,
  demoToday,
  type DemoRule,
  type DemoRun,
  type DemoTask,
} from "./showroom-data";

export function useShowroom() {
  const [tasks, setTasks] = useState(demoTasks);
  const [rules, setRules] = useState(demoRules);
  const [notifications, setNotifications] = useState(demoNotifications);
  const complete = (id: string) =>
    setTasks((items) =>
      items.map((item) =>
        item.id === id ? { ...item, status: "completed" } : item,
      ),
    );
  const toggle = (id: string, enabled: boolean) =>
    setRules((items) =>
      items.map((item) => (item.id === id ? { ...item, enabled } : item)),
    );
  const configure = (rule: DemoRule) =>
    setRules((items) =>
      items.map((item) => (item.id === rule.id ? rule : item)),
    );
  const read = (id?: string) =>
    setNotifications((items) =>
      items.map((item) =>
        !id || item.id === id ? { ...item, read: true } : item,
      ),
    );
  // Which Automatizaciones screen is open, so the shell breadcrumb and notifications can follow it.
  const [automation, setAutomation] = useState<{
    view: "rules" | "runs";
    runId: string | null;
  }>({ view: "rules", runId: null });
  // Shared so the dashboard summary and Ejecuciones always count the same runs.
  const [runs, setRuns] = useState(demoRuns);
  return {
    tasks,
    rules,
    notifications,
    automation,
    runs,
    setRuns,
    complete,
    toggle,
    configure,
    read,
    setAutomation,
  };
}
type State = ReturnType<typeof useShowroom>;
type Navigate = (
  section: "Seguimientos" | "Automatizaciones" | "Notificaciones",
) => void;
const taskStatus = (task: DemoTask) =>
  task.status === "completed"
    ? "Completado"
    : task.status === "cancelled"
      ? "Cancelado"
      : task.date < demoToday
        ? "Vencido"
        : task.date === demoToday
          ? "Hoy"
          : "Próximo";

export function DemoDashboard({
  state,
  appointments,
  onAppointment,
  agenda,
  navigate,
}: {
  state: State;
  appointments: {
    time: string;
    name: string;
    service: string;
    status: string;
    paid: boolean;
  }[];
  onAppointment: (index: number) => void;
  agenda: () => void;
  navigate: Navigate;
}) {
  const pending = state.tasks.filter(
    (task) => task.status === "pending" && task.date <= demoToday,
  );
  const runCount = (...statuses: DemoRun["status"][]) =>
    state.runs.filter((run) => statuses.includes(run.status)).length;
  return (
    <>
      <div className="demo-title-row">
        <div>
          <h1>Hola, Ana</h1>
          <p>Acá tenés un resumen de tu consulta.</p>
        </div>
        <span className="dashboard-date">
          <CalendarDays size={16} />3 de octubre · Demo
        </span>
      </div>
      <div className="metric-grid">
        {[
          {
            label: "Turnos de hoy",
            value: appointments.filter((item) => item.status !== "Cancelado")
              .length,
            detail: "Agendados para hoy",
            Icon: CalendarDays,
            tone: "coral",
          },
          {
            label: "Ingresos cobrados",
            value: "$ 77.000",
            detail: "ARS · pagos de ejemplo",
            Icon: CreditCard,
            tone: "sage",
          },
          {
            label: "Pacientes registrados",
            value: 4,
            detail: "En el consultorio de ejemplo",
            Icon: Users,
            tone: "blue",
          },
          {
            label: "Seguimientos pendientes",
            value: state.tasks.filter((task) => task.status === "pending")
              .length,
            detail: "Tareas por completar",
            Icon: ListChecks,
            tone: "lilac",
          },
        ].map(({ label, value, detail, Icon, tone }) => (
          <section key={label} className="demo-panel live-metric">
            <div className="live-metric-head">
              <span>{label}</span>
              <span className={`metric-icon ${tone}`}>
                <Icon size={17} />
              </span>
            </div>
            <strong>{value}</strong>
            <small>{detail}</small>
          </section>
        ))}
      </div>
      <div className="dashboard-primary-grid">
        <section className="demo-panel">
          <div className="panel-head">
            <h2>Próximos turnos</h2>
            <button onClick={agenda}>
              Ver agenda <ArrowRight size={15} />
            </button>
          </div>
          {appointments
            .filter(
              (item) =>
                item.status !== "Cancelado" && item.status !== "Completado",
            )
            .map((item) => (
              <button
                className="appt-row"
                key={item.name}
                onClick={() => onAppointment(appointments.indexOf(item))}
              >
                <span className="appt-time">
                  <b>{item.time}</b>
                  <small>3 oct</small>
                </span>
                <span className="appt-details">
                  <b>{item.name}</b>
                  <small>{item.service}</small>
                </span>
                <span
                  className={`status ${item.status === "Confirmado" ? "paid" : "pending"}`}
                >
                  {item.status}
                </span>
              </button>
            ))}
          {appointments.every((item) =>
            ["Cancelado", "Completado"].includes(item.status),
          ) && (
            <p className="live-empty">No hay próximos turnos en esta demo.</p>
          )}
        </section>
        <section className="demo-panel">
          <div className="panel-head">
            <h2>
              Pendientes del día{" "}
              <span className="dashboard-count">{pending.length}</span>
            </h2>
            <button onClick={() => navigate("Seguimientos")}>
              Ver tareas <ArrowRight size={15} />
            </button>
          </div>
          <div className="showroom-pending-list">
            {pending.map((task) => (
              <button key={task.id} onClick={() => navigate("Seguimientos")}>
                <span
                  className={`metric-icon ${task.date < demoToday ? "coral" : "blue"}`}
                >
                  <ListChecks size={17} />
                </span>
                <span>
                  <b>{task.title}</b>
                  <small>
                    {task.patient} · {taskStatus(task)}
                  </small>
                </span>
                <ArrowRight size={15} />
              </button>
            ))}
          </div>
          {!pending.length && (
            <p className="live-empty">
              Todo al día. No hay tareas pendientes para hoy.
            </p>
          )}
          <button
            className="showroom-text-button showroom-notification-summary"
            onClick={() => navigate("Notificaciones")}
          >
            <Bell size={16} />
            {state.notifications.filter((item) => !item.read).length}{" "}
            notificaciones sin leer <ArrowRight size={15} />
          </button>
        </section>
      </div>
      <div className="dashboard-secondary-grid">
        <section className="demo-panel">
          <div className="panel-head">
            <h2>Automatizaciones</h2>
            <button onClick={() => navigate("Automatizaciones")}>
              Ver automatizaciones <ArrowRight size={15} />
            </button>
          </div>
          <div className="crm-dashboard-counts">
            <div>
              <strong>
                {state.rules.filter((rule) => rule.enabled).length}
              </strong>
              <span>Funcionando</span>
            </div>
            <div>
              <strong>{state.runs.length}</strong>
              <span>Actividad de ejemplo</span>
            </div>
            <div>
              <strong>{runCount("completed")}</strong>
              <span>Hechas</span>
            </div>
            <div>
              <strong>{runCount("failed")}</strong>
              <span>Para revisar</span>
            </div>
            <div>
              <strong>{runCount("scheduled", "processing")}</strong>
              <span>Pendientes</span>
            </div>
          </div>
        </section>
        <section className="demo-panel quick-panel">
          <div className="panel-head">
            <h2>Tu página de turnos</h2>
            <FileText size={16} />
          </div>
          <p>Vista de ejemplo para compartir con tus pacientes.</p>
          <a className="live-link" href="/profesional/ana-lopez">
            Ver el perfil de demostración <ArrowRight size={15} />
          </a>
          <p className="dashboard-payment-state">
            Consultas online y presenciales · Psicología clínica.
          </p>
        </section>
      </div>
    </>
  );
}

export function DemoFollowUps({
  state,
  patient,
  automation,
}: {
  state: State;
  patient: (name: string) => void;
  automation: () => void;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("pending");
  const [priority, setPriority] = useState("all");
  const [source, setSource] = useState("all");
  const [signal, setSignal] = useState("attention");
  const [notice, setNotice] = useState("");
  const text = search.trim().toLocaleLowerCase("es-AR");
  const rank = { overdue: 0, today: 1, upcoming: 2, none: 3 };
  const visible = state.tasks
    .filter(
      (task) =>
        task.patient.toLocaleLowerCase("es-AR").includes(text) &&
        (status === "all" || task.status === status) &&
        (priority === "all" || task.priority === priority) &&
        (source === "all" || task.source === source),
    )
    .map(demoFollowUp)
    .sort(
      (a, b) =>
        rank[followUpBucket(a.due_date, demoToday)] -
          rank[followUpBucket(b.due_date, demoToday)] ||
        a.due_date.localeCompare(b.due_date),
    );
  const patients = demoPatients(state.tasks);
  const names = new Map(patients.map((item) => [item.id, item.full_name]));
  const attention = patients.filter(hasAttention).length;
  const signals = patients
    .flatMap((item) =>
      detectOpportunities(item)
        .filter(
          (found) =>
            signal === "all" ||
            (signal === "attention"
              ? found.level === "attention"
              : found.kind === signal),
        )
        .map((found) => ({ patient: item, item: found })),
    )
    .filter((row) =>
      row.patient.full_name.toLocaleLowerCase("es-AR").includes(text),
    )
    .sort(
      (a, b) =>
        a.item.priority - b.item.priority ||
        a.patient.full_name.localeCompare(b.patient.full_name, "es-AR"),
    );
  const count = (test: (task: DemoTask) => boolean) =>
    state.tasks.filter(test).length;
  return (
    <>
      <PageHeader
        title="Seguimientos"
        description="Bellis te muestra pacientes que podrían necesitar seguimiento según su actividad. Vos decidís qué hacer."
      />
      {notice && (
        <p className="live-success" role="status">
          {notice}
        </p>
      )}
      <KpiStrip
        items={[
          {
            label: "Pendientes",
            value: count((task) => task.status === "pending"),
            icon: ListChecks,
            tone: "petrol",
          },
          {
            label: "Hoy",
            value: count(
              (task) => task.status === "pending" && task.date === demoToday,
            ),
            icon: Clock3,
            tone: "orange",
          },
          {
            label: "Vencidos",
            value: count(
              (task) => task.status === "pending" && task.date < demoToday,
            ),
            icon: CircleAlert,
            tone: "coral",
          },
          {
            label: "Completados",
            value: count((task) => task.status === "completed"),
            icon: Check,
            tone: "sage",
          },
        ]}
      />
      <section className="crm-card">
        <div className="crm-card-head">
          <div>
            <h2>Pacientes para revisar</h2>
            <p>
              {attention
                ? `Bellis te sugiere revisar a ${attention} ${attention === 1 ? "paciente" : "pacientes"}.`
                : "Por ahora no hay pacientes para revisar."}{" "}
              La lista se actualiza sola.
            </p>
          </div>
          <label className="crm-select">
            Mostrar
            <select value={signal} onChange={(e) => setSignal(e.target.value)}>
              {opportunityFilters.map((item) => (
                <option key={item.kind} value={item.kind}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {signals.length ? (
          <div className="crm-signals">
            {signals.map((row) => (
              <OpportunityRow
                key={`${row.patient.id}:${row.item.kind}`}
                item={row.item}
                patientName={row.patient.full_name}
              >
                <button
                  className="crm-link"
                  onClick={() => patient(row.patient.full_name)}
                >
                  Ver paciente <ArrowRight size={15} />
                </button>
              </OpportunityRow>
            ))}
          </div>
        ) : (
          <p className="live-empty">
            {signal === "attention" || signal === "all"
              ? "No hay pacientes que necesiten seguimiento por ahora."
              : "No hay pacientes en esa situación por ahora."}
          </p>
        )}
      </section>
      <section className="crm-card">
        <div className="crm-card-head">
          <div>
            <h2>Tus seguimientos</h2>
            <p>
              Recordatorios para volver a contactar a un paciente. Los podés
              crear vos o Bellis, si activaste una automatización.
            </p>
          </div>
        </div>
        <div className="crm-filterbar">
          <label className="crm-search">
            <Search size={16} />
            <input
              aria-label="Buscar paciente en seguimientos"
              placeholder="Buscar paciente"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label className="crm-select">
            Prioridad
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            >
              <option value="all">Todas</option>
              {Object.entries(priorityLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="crm-select">
            Estado
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="pending">Pendientes</option>
              <option value="completed">Completados</option>
              <option value="cancelled">Cancelados</option>
              <option value="all">Todos</option>
            </select>
          </label>
          <label className="crm-select">
            Origen
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="all">Todos</option>
              <option value="manual">Creados por vos</option>
              <option value="automation">Creados por Bellis</option>
            </select>
          </label>
        </div>
        {visible.length ? (
          groupFollowUps(visible, demoToday).map((group) => (
          <div key={group.key}>
          <GroupTitle label={group.label} count={group.items.length} />
          <FollowUpsTable
            items={group.items}
            today={demoToday}
            patientName={(item) => names.get(item.patient_id)}
            renderPatient={(item, content, { className }) => (
              <button
                type="button"
                className={className}
                onClick={() => patient(names.get(item.patient_id) ?? "")}
              >
                {content}
              </button>
            )}
            renderActions={(item) => (
              <>
                {item.status === "pending" && (
                  <button
                    onClick={() => {
                      state.complete(item.id);
                      setNotice("Seguimiento completado en la demo.");
                    }}
                  >
                    <Check size={14} />
                    Completar
                  </button>
                )}
                {item.source === "automation" && (
                  <button onClick={automation}>Ver actividad</button>
                )}
                <button
                  aria-label={`Ver paciente ${names.get(item.patient_id)}`}
                  onClick={() => patient(names.get(item.patient_id) ?? "")}
                >
                  <ArrowRight size={16} />
                </button>
              </>
            )}
          />
          </div>
          ))
        ) : (
          <p className="live-empty">
            {status === "pending" && priority === "all" && source === "all" && !text
              ? "No tenés seguimientos pendientes por ahora."
              : "No hay seguimientos con esos filtros."}
          </p>
        )}
      </section>
    </>
  );
}
