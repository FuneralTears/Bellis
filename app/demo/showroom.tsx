"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  Clock3,
  CreditCard,
  FileText,
  ListChecks,
  Search,
  Settings2,
  Users,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { followUpBucket, priorityLabels } from "../pacientes/timeline";
import {
  demoNotifications,
  demoRules,
  demoRuns,
  demoTasks,
  demoToday,
  type DemoRule,
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
  return { tasks, rules, notifications, complete, toggle, configure, read };
}
type State = ReturnType<typeof useShowroom>;
type Navigate = (
  section: "Seguimientos" | "Automatizaciones" | "Notificaciones",
) => void;
const runLabels = {
  completed: "Seguimiento creado",
  failed: "Error",
  skipped: "Omitida",
};
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

export function DemoBell({
  state,
  navigate,
}: {
  state: State;
  navigate: Navigate;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const count = state.notifications.filter((item) => !item.read).length;
  useEffect(() => {
    if (!open) return;
    const click = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", click);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className="bell-wrap" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="bell-button"
        aria-label={`Notificaciones: ${count} sin leer`}
        aria-expanded={open}
        aria-controls="demo-notifications-dropdown"
        onClick={() => setOpen(!open)}
      >
        <Bell size={18} />
        {count > 0 && <span className="bell-count">{count}</span>}
      </button>
      {open && (
        <section
          id="demo-notifications-dropdown"
          className="bell-dropdown"
          aria-label="Notificaciones de la demo"
        >
          <div className="bell-dropdown-head">
            <strong>Notificaciones</strong>
            <button
              className="showroom-text-button"
              onClick={() => {
                setOpen(false);
                navigate("Notificaciones");
              }}
            >
              Ver todas
            </button>
          </div>
          {state.notifications.length ? (
            <div className="bell-list">
              {state.notifications.map((item) => (
                <button
                  key={item.id}
                  className={`bell-item ${item.read ? "" : "unread"}`}
                  onClick={() => {
                    state.read(item.id);
                    setOpen(false);
                    navigate(item.target);
                  }}
                >
                  <span className="bell-item-icon">
                    {item.failed ? (
                      <Settings2 size={16} />
                    ) : (
                      <ListChecks size={16} />
                    )}
                  </span>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.message}</small>
                    <time>{item.time}</time>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="bell-empty">Todavía no hay notificaciones.</p>
          )}
        </section>
      )}
    </div>
  );
}

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
              Ver reglas <ArrowRight size={15} />
            </button>
          </div>
          <div className="crm-dashboard-counts">
            <div>
              <strong>
                {state.rules.filter((rule) => rule.enabled).length}
              </strong>
              <span>Reglas activas</span>
            </div>
            <div>
              <strong>3</strong>
              <span>Ejecuciones de ejemplo</span>
            </div>
            <div>
              <strong>1</strong>
              <span>Seguimiento creado</span>
            </div>
            <div>
              <strong>1</strong>
              <span>Ejecución con error</span>
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
  const [status, setStatus] = useState("all");
  const [priority, setPriority] = useState("all");
  const [source, setSource] = useState("all");
  const [signal, setSignal] = useState("all");
  const [notice, setNotice] = useState("");
  const visible = state.tasks.filter(
    (task) =>
      task.patient
        .toLocaleLowerCase("es-AR")
        .includes(search.trim().toLocaleLowerCase("es-AR")) &&
      (status === "all" || task.status === status) &&
      (priority === "all" || task.priority === priority) &&
      (source === "all" || task.source === source),
  );
  const opportunities = [
    {
      patient: "Lucía Pérez",
      title: "Pago pendiente",
      reason: "Un pago necesita verificación.",
      kind: "payment",
    },
    {
      patient: "Carlos Ruiz",
      title: "Primera consulta sin próximo turno",
      reason:
        "La primera consulta terminó y todavía no hay otro turno reservado.",
      kind: "next",
    },
  ].filter(
    (item) =>
      (signal === "all" || item.kind === signal) &&
      item.patient
        .toLocaleLowerCase("es-AR")
        .includes(search.trim().toLocaleLowerCase("es-AR")),
  );
  return (
    <>
      <DemoTitle
        title="Seguimientos"
        description="Lo que necesita atención en tu espacio profesional."
      />
      {notice && (
        <p className="live-success" role="status">
          {notice}
        </p>
      )}
      <div className="crm-follow-up-metrics">
        {[
          [
            "Pendientes",
            state.tasks.filter((task) => task.status === "pending").length,
          ],
          [
            "Hoy",
            state.tasks.filter(
              (task) => task.status === "pending" && task.date === demoToday,
            ).length,
          ],
          [
            "Vencidos",
            state.tasks.filter(
              (task) => task.status === "pending" && task.date < demoToday,
            ).length,
          ],
          [
            "Completados",
            state.tasks.filter((task) => task.status === "completed").length,
          ],
        ].map(([label, value]) => (
          <div key={label} className="demo-panel">
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <section className="demo-panel crm-opportunity-panel">
        <div className="crm-section-head">
          <div>
            <h2>Oportunidades detectadas</h2>
            <p className="crm-hint">
              Señales de ejemplo para revisar la continuidad de atención.
            </p>
          </div>
          <label className="crm-opportunity-select">
            Mostrar
            <select value={signal} onChange={(e) => setSignal(e.target.value)}>
              <option value="all">Requieren atención</option>
              <option value="payment">Pagos pendientes</option>
              <option value="next">Sin próximo turno</option>
            </select>
          </label>
        </div>
        {opportunities.length ? (
          <div className="crm-opportunity-list">
            {opportunities.map((item) => (
              <article
                key={item.patient}
                className="crm-opportunity-item crm-opportunity-attention"
              >
                <div>
                  <span className="crm-opportunity-pill">
                    Atención pendiente
                  </span>
                  <strong>
                    {item.patient} · {item.title}
                  </strong>
                  <p>{item.reason}</p>
                </div>
                <button
                  className="showroom-text-button"
                  onClick={() => patient(item.patient)}
                >
                  Ver paciente <ArrowRight size={15} />
                </button>
              </article>
            ))}
          </div>
        ) : (
          <p className="live-empty">No hay oportunidades con ese filtro.</p>
        )}
      </section>
      <section className="demo-panel">
        <div className="crm-toolbar">
          <label className="crm-search">
            <Search size={16} />
            <input
              aria-label="Buscar paciente en seguimientos"
              placeholder="Buscar paciente"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label className="crm-sort">
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
          <label className="crm-sort">
            Estado
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">Todos</option>
              <option value="pending">Pendientes</option>
              <option value="completed">Completados</option>
              <option value="cancelled">Cancelados</option>
            </select>
          </label>
          <label className="crm-sort">
            Origen
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="all">Todos</option>
              <option value="manual">Manuales</option>
              <option value="automation">Automáticos</option>
            </select>
          </label>
        </div>
        {visible.length ? (
          <div className="crm-table-wrap showroom-task-table">
            <table className="crm-table">
              <thead>
                <tr>
                  <th>Paciente</th>
                  <th>Seguimiento</th>
                  <th>Fecha</th>
                  <th>Prioridad</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <button
                        className="showroom-text-button crm-person"
                        onClick={() => patient(task.patient)}
                      >
                        <b>{task.patient}</b>
                      </button>
                    </td>
                    <td>
                      <b>{task.title}</b>
                      <small className="crm-cell-description">
                        {task.source === "automation" ? "Automático" : "Manual"}{" "}
                        · {task.description}
                      </small>
                    </td>
                    <td>
                      {task.date.split("-").reverse().join("/")} · {task.time}
                    </td>
                    <td>
                      <span
                        className={`crm-badge crm-priority-${task.priority}`}
                      >
                        {priorityLabels[task.priority]}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`crm-follow-up-state ${task.status === "pending" ? `crm-${followUpBucket(task.date, demoToday)}` : ""}`}
                      >
                        {taskStatus(task)}
                      </span>
                    </td>
                    <td>
                      <div className="crm-table-actions">
                        {task.status === "pending" && (
                          <button
                            onClick={() => {
                              state.complete(task.id);
                              setNotice("Seguimiento completado en la demo.");
                            }}
                          >
                            <Check size={14} />
                            Completar
                          </button>
                        )}
                        {task.source === "automation" && (
                          <button onClick={automation}>
                            Ver automatización
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="live-empty">No hay seguimientos con esos filtros.</p>
        )}
      </section>
    </>
  );
}

export function DemoAutomations({
  state,
  patient,
}: {
  state: State;
  patient: (name: string) => void;
}) {
  const [selected, setSelected] = useState<DemoRule | null>(null);
  const [notice, setNotice] = useState("");
  const [runFilter, setRunFilter] = useState("all");
  return (
    <>
      <DemoTitle
        title="Automatizaciones"
        description="Reglas que crean tareas de seguimiento en tu consultorio."
      />
      <p className="crm-hint automation-intro">
        Acciones internas de ejemplo. Los cambios de esta demo duran durante la
        visita.
      </p>
      {notice && (
        <p className="live-success" role="status">
          {notice}
        </p>
      )}
      <div className="automation-cards showroom-rules">
        {state.rules.map((rule, index) => {
          const Icon = [ListChecks, Clock3, CreditCard][index];
          return (
            <article key={rule.id} className="demo-panel automation-card">
              <div className="showroom-rule-heading">
                <span
                  className={`metric-icon ${index === 2 ? "coral" : "sage"}`}
                >
                  <Icon size={18} />
                </span>
                <div>
                  <h2>{rule.name}</h2>
                  <p>{rule.description}</p>
                </div>
                <span
                  className={`automation-state ${rule.enabled ? "enabled" : ""}`}
                >
                  {rule.enabled ? "Activa" : "Inactiva"}
                </span>
                <Switch
                  checked={rule.enabled}
                  aria-label={`Activar ${rule.name}`}
                  onCheckedChange={(enabled) => state.toggle(rule.id, enabled)}
                />
              </div>
              <div className="automation-steps">
                <span>
                  <Clock3 size={16} />
                  Esperar {rule.delay} {rule.unit}
                </span>
                <span>
                  <Settings2 size={16} />
                  {rule.action} · {priorityLabels[rule.priority]}
                </span>
              </div>
              <div className="automation-actions">
                <button
                  className="live-secondary"
                  onClick={() => setSelected({ ...rule })}
                >
                  Configurar
                </button>
              </div>
            </article>
          );
        })}
      </div>
      <section className="demo-panel">
        <div className="crm-section-head">
          <div>
            <h2>Ejecuciones recientes</h2>
            <p className="crm-hint">
              Historial de ejemplo; no se ejecutan reglas reales.
            </p>
          </div>
          <label className="crm-opportunity-select">
            Estado de ejecución
            <select
              value={runFilter}
              onChange={(e) => setRunFilter(e.target.value)}
            >
              <option value="all">Todos</option>
              {Object.entries(runLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="automation-history">
          {demoRuns
            .filter((run) => runFilter === "all" || run.status === runFilter)
            .map((run) => (
              <div key={run.id}>
                <span>{run.date}</span>
                <div>
                  <strong>
                    {state.rules.find((rule) => rule.id === run.ruleId)?.name}
                  </strong>
                  <small>
                    {run.patient} · {run.detail}
                  </small>
                </div>
                <span
                  className={`status ${run.status === "failed" ? "pending" : run.status === "completed" ? "paid" : "muted"}`}
                >
                  {runLabels[run.status as keyof typeof runLabels]}
                </span>
                <button
                  className="showroom-text-button"
                  onClick={() => patient(run.patient)}
                >
                  Ver paciente <ArrowRight size={15} />
                </button>
              </div>
            ))}
        </div>
      </section>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Configurar regla de ejemplo</DialogTitle>
          </DialogHeader>
          {selected && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                state.configure(selected);
                setSelected(null);
                setNotice("Configuración actualizada en la demo.");
              }}
            >
              <div className="automation-definition">
                <div>
                  <small>SE ACTIVA CUANDO</small>
                  <strong>{selected.trigger}</strong>
                </div>
                <div>
                  <small>CONDICIÓN</small>
                  <strong>{selected.condition}</strong>
                </div>
              </div>
              <div className="automation-form">
                <label>
                  Nombre
                  <input
                    required
                    value={selected.name}
                    onChange={(e) =>
                      setSelected({ ...selected, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  Espera ({selected.unit})
                  <input
                    type="number"
                    required
                    min="1"
                    max="365"
                    value={selected.delay}
                    onChange={(e) =>
                      setSelected({
                        ...selected,
                        delay: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Acción
                  <input
                    required
                    value={selected.action}
                    onChange={(e) =>
                      setSelected({ ...selected, action: e.target.value })
                    }
                  />
                </label>
                <label>
                  Prioridad
                  <select
                    value={selected.priority}
                    onChange={(e) =>
                      setSelected({
                        ...selected,
                        priority: e.target.value as DemoRule["priority"],
                      })
                    }
                  >
                    {Object.entries(priorityLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button type="submit" className="demo-primary">
                Guardar en la demo
              </button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function DemoNotifications({
  state,
  navigate,
}: {
  state: State;
  navigate: Navigate;
}) {
  const [filter, setFilter] = useState("all");
  const count = state.notifications.filter((item) => !item.read).length;
  const visible = state.notifications.filter(
    (item) => filter === "all" || (filter === "read" ? item.read : !item.read),
  );
  return (
    <>
      <DemoTitle
        title="Notificaciones"
        description="Acciones de seguimiento registradas para vos."
      />
      <div className="notification-actions">
        <div
          className="notification-filters"
          role="group"
          aria-label="Filtrar notificaciones"
        >
          {[
            ["all", "Todas"],
            ["unread", `No leídas (${count})`],
            ["read", "Leídas"],
          ].map(([value, label]) => (
            <button
              key={value}
              className={filter === value ? "active" : ""}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className="live-secondary"
          disabled={!count}
          onClick={() => state.read()}
        >
          Marcar todas como leídas
        </button>
      </div>
      {visible.length ? (
        <div className="notifications-list">
          {visible.map((item) => (
            <button
              key={item.id}
              className={`notification-card ${item.read ? "" : "unread"}`}
              onClick={() => {
                state.read(item.id);
                navigate(item.target);
              }}
            >
              <span className="notification-dot" />
              <span className="notification-body">
                <strong>{item.title}</strong>
                <span>{item.message}</span>
                <small>
                  {item.time} · {item.read ? "Leída" : "No leída"}
                </small>
              </span>
              <ArrowRight size={17} />
            </button>
          ))}
        </div>
      ) : (
        <p className="live-empty" role="status">
          No hay notificaciones con este filtro.
        </p>
      )}
    </>
  );
}
function DemoTitle({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="demo-title-row">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
    </div>
  );
}
