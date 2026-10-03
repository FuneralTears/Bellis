"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { getSupabase } from "@/lib/supabase/browser";
import { notificationHref, relativeNotificationTime, type InternalNotification } from "../notificaciones/notifications";
import { NotificationItem, notificationKind } from "@/components/automation/AutomationUi";
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

  // Same dismissal as the demo bell: Escape (focus back on the button) or a press outside.
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!open) return;
    const onPress = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", onPress); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPress); document.removeEventListener("keydown", onKey); };
  }, [open]);

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

  return <div className="bell-wrap" ref={wrap}><button ref={trigger} type="button" className="bell-button" aria-label={count ? `Notificaciones: ${count} sin leer` : "Notificaciones"} aria-expanded={open} onClick={() => { const next = !open; setOpen(next); if (next) void refresh(true); }}><Bell size={18}/>{count > 0 && <span className="bell-count">{count > 99 ? "99+" : count}</span>}</button>
    {open && <div className="bell-dropdown"><div className="bell-dropdown-head"><span><strong>Notificaciones</strong>{count > 0 && <small>{count} sin leer</small>}</span><Link href="/notificaciones">Ver todas</Link></div>{error && <p className="live-error" role="alert">{error}</p>}{items.length ? <div className="bell-list">{items.map((item) => <NotificationItem compact key={item.id} kind={notificationKind(item.type)} title={item.title} message={item.message} time={relativeNotificationTime(item.created_at)} unread={!item.read_at} onClick={() => void openNotification(item)}/>)}</div> : <p className="bell-empty">Todavía no hay notificaciones.</p>}</div>}
  </div>;
}
