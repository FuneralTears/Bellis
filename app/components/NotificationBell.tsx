"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { getSupabase } from "@/lib/supabase/browser";
import { notificationHref, relativeNotificationTime, type InternalNotification } from "../notificaciones/notifications";
import "../notificaciones/notifications.css";

export default function NotificationBell({ workspaceId }: { workspaceId: string | null }) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<InternalNotification[]>([]);
  const [error, setError] = useState("");
  const refresh = useCallback(async (includeItems: boolean) => {
    if (!workspaceId) return;
    try {
      const client = await getSupabase();
      const { data: auth } = await client.auth.getUser();
      if (!auth.user) return;
      const base = client.from("internal_notifications");
      const countResult = await base.select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("recipient_id", auth.user.id).is("read_at", null);
      if (countResult.error) throw countResult.error;
      setCount(countResult.count ?? 0);
      if (includeItems) {
        const listResult = await client.from("internal_notifications").select("*").eq("workspace_id", workspaceId)
          .eq("recipient_id", auth.user.id).order("created_at", { ascending: false }).limit(5);
        if (listResult.error) throw listResult.error;
        setItems((listResult.data ?? []) as InternalNotification[]);
      }
      setError("");
    } catch { setError("No pudimos actualizar las notificaciones."); }
  }, [workspaceId]);
  useEffect(() => { if (!workspaceId) return;
    const initial = window.setTimeout(() => void refresh(false), 0);
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(open); }, 60000);
    const onFocus = () => void refresh(open);
    const onChange = () => void refresh(open);
    window.addEventListener("focus", onFocus);
    window.addEventListener("bellis:notifications-updated", onChange);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); window.removeEventListener("focus", onFocus); window.removeEventListener("bellis:notifications-updated", onChange); };
  }, [workspaceId, refresh, open]);

  async function openNotification(item: InternalNotification) {
    if (!item.read_at) {
      try {
        const client = await getSupabase();
        const { error: readError } = await client.from("internal_notifications").update({ read_at: new Date().toISOString() })
          .eq("id", item.id).eq("workspace_id", item.workspace_id).is("read_at", null);
        if (readError) throw readError;
        setCount((value) => Math.max(0, value - 1));
        window.dispatchEvent(new Event("bellis:notifications-updated"));
      } catch { setError("No pudimos marcar la notificación como leída."); return; }
    }
    window.location.assign(notificationHref(item));
  }

  return <div className="bell-wrap"><button type="button" className="bell-button" aria-label={count ? `Notificaciones: ${count} sin leer` : "Notificaciones"} aria-expanded={open} onClick={() => { const next = !open; setOpen(next); if (next) void refresh(true); }}><Bell size={19}/>{count > 0 && <span className="bell-count">{count > 99 ? "99+" : count}</span>}</button>
    {open && <div className="bell-dropdown"><div className="bell-dropdown-head"><strong>Notificaciones</strong><Link href="/notificaciones">Ver todas</Link></div>{error && <p className="live-error" role="alert">{error}</p>}{items.length ? <div className="bell-list">{items.map((item) => <button type="button" key={item.id} className={item.read_at ? "bell-item" : "bell-item unread"} onClick={() => void openNotification(item)}><span className="bell-item-icon">{item.type === "automation_failed" ? "!" : "⚙"}</span><span><strong>{item.title}</strong><small>{item.message}</small><time>{relativeNotificationTime(item.created_at)}</time></span></button>)}</div> : <p className="bell-empty">Todavía no hay notificaciones.</p>}</div>}
  </div>;
}
