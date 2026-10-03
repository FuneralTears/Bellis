"use client";

import { useEffect, useState } from "react";
import { BellOff, CheckCheck } from "lucide-react";
import { getSupabase } from "@/lib/supabase/browser";
import CrmShell from "../pacientes/CrmShell";
import { crmDate, errorMessage, loadCrmContext, type CrmContext } from "../pacientes/crm";
import { notificationHref, relativeNotificationTime, type InternalNotification } from "./notifications";
import { PageHeader } from "@/components/crm/CrmUi";
import { NotificationItem, notificationKind } from "@/components/automation/AutomationUi";
import "./notifications.css";

type Filter = "all" | "unread" | "read";
const pageSize = 20;

export default function NotificationsPage() {
  const [context, setContext] = useState<CrmContext | null>(null);
  const [recipientId, setRecipientId] = useState("");
  const [items, setItems] = useState<InternalNotification[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { let cancelled = false;
    async function loadContext() { try {
      const next = await loadCrmContext();
      const client = await getSupabase();
      const { data: auth } = await client.auth.getUser();
      if (!auth.user) throw new Error("Tu sesión venció. Volvé a ingresar.");
      if (!cancelled) { setContext(next); setRecipientId(auth.user.id); }
    } catch (caught) {
      const message = errorMessage(caught);
      if (message === "onboarding_required") window.location.replace("/onboarding");
      else if (message.includes("sesión")) window.location.replace("/ingresar");
      else if (!cancelled) { setError(message); setLoading(false); }
    } }
    void loadContext(); return () => { cancelled = true; };
  }, []);

  useEffect(() => { if (!context || !recipientId) return; let cancelled = false;
    async function load() { setLoading(true); try {
      const client = await getSupabase();
      let query = client.from("internal_notifications").select("*", { count: "exact" })
        .eq("workspace_id", context!.workspaceId).eq("recipient_id", recipientId);
      if (filter === "unread") query = query.is("read_at", null);
      if (filter === "read") query = query.not("read_at", "is", null);
      const [list, counter] = await Promise.all([
        query.order("created_at", { ascending: false }).range(page * pageSize, (page + 1) * pageSize - 1),
        client.from("internal_notifications").select("id", { count: "exact", head: true })
          .eq("workspace_id", context!.workspaceId).eq("recipient_id", recipientId).is("read_at", null)
      ]);
      if (list.error) throw list.error;
      if (counter.error) throw counter.error;
      if (!cancelled) { setItems((list.data ?? []) as InternalNotification[]); setTotal(list.count ?? 0); setUnread(counter.count ?? 0); setError(""); }
    } catch (caught) { if (!cancelled) setError(errorMessage(caught)); }
    finally { if (!cancelled) setLoading(false); } }
    void load(); return () => { cancelled = true; };
  }, [context, recipientId, filter, page, saving]);

  async function markAll() {
    if (!context || !recipientId || !unread) return;
    setSaving(true); setError("");
    try {
      const client = await getSupabase();
      const { error: saveError } = await client.from("internal_notifications").update({ read_at: new Date().toISOString() })
        .eq("workspace_id", context.workspaceId).eq("recipient_id", recipientId).is("read_at", null);
      if (saveError) throw saveError;
      setUnread(0);
      window.dispatchEvent(new Event("bellis:notifications-updated"));
    } catch (caught) { setError(errorMessage(caught)); } finally { setSaving(false); }
  }
  async function open(item: InternalNotification) {
    if (!item.read_at) {
      try {
        const client = await getSupabase();
        const { error: saveError } = await client.from("internal_notifications").update({ read_at: new Date().toISOString() })
          .eq("workspace_id", item.workspace_id).eq("id", item.id).eq("recipient_id", recipientId).is("read_at", null);
        if (saveError) throw saveError;
      } catch (caught) { setError(errorMessage(caught)); return; }
    }
    window.location.assign(notificationHref(item));
  }

  return <CrmShell context={context} breadcrumb="Notificaciones">
    <PageHeader title="Notificaciones" description={unread ? `${unread} sin leer · Acciones de seguimiento que Bellis registró para vos.` : "Acciones de seguimiento que Bellis registró para vos."}/>
    {error && <p className="live-error" role="alert">{error}</p>}
    <div className="notif-head"><div className="crm-chips" role="group" aria-label="Filtrar notificaciones">{(["all","unread","read"] as Filter[]).map((value) => <button type="button" key={value} aria-pressed={filter === value} className={filter === value ? "on" : ""} onClick={() => { setFilter(value); setPage(0); }}>{value === "all" ? "Todas" : value === "unread" ? `No leídas${unread ? ` (${unread})` : ""}` : "Leídas"}</button>)}</div><button className="crm-btn" disabled={saving || unread === 0} onClick={() => void markAll()}><CheckCheck size={15}/> Marcar todas como leídas</button></div>
    {loading ? <p className="live-empty" role="status">Cargando notificaciones…</p> : items.length ? <div className="notif-list">{items.map((item) => <NotificationItem key={item.id} kind={notificationKind(item.type)} title={item.title} message={item.message} time={`${relativeNotificationTime(item.created_at)} · ${context ? crmDate(item.created_at, context.market) : ""}`} unread={!item.read_at} onClick={() => void open(item)}/>)}</div> : <div className="notif-empty"><BellOff size={22}/><strong>Sin notificaciones</strong><p>No hay notificaciones con este filtro.</p></div>}
    {!loading && total > pageSize && <div className="auto-pagination"><button className="crm-btn" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Anterior</button><span>{page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} de {total}</span><button className="crm-btn" disabled={(page + 1) * pageSize >= total} onClick={() => setPage((value) => value + 1)}>Siguiente</button></div>}
  </CrmShell>;
}
