export type InternalNotification = {
  id: string;
  workspace_id: string;
  recipient_id: string;
  type: "automation_follow_up_created" | "automation_failed" | "automation_skipped" | "automation_completed";
  title: string;
  message: string;
  entity_type: "follow_up" | "automation_run";
  entity_id: string;
  automation_run_id: string;
  patient_id: string;
  follow_up_id: string | null;
  read_at: string | null;
  created_at: string;
};

export function notificationHref(item: InternalNotification): string {
  if (item.entity_type === "follow_up" && item.follow_up_id)
    return `/pacientes/${item.patient_id}#seguimiento-${item.follow_up_id}`;
  return `/automatizaciones/ejecuciones?run=${item.automation_run_id}`;
}

export function relativeNotificationTime(value: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  const format = new Intl.RelativeTimeFormat("es-AR", { numeric: "auto" });
  if (minutes < 60) return format.format(-minutes, "minute");
  if (minutes < 1440) return format.format(-Math.round(minutes / 60), "hour");
  return format.format(-Math.round(minutes / 1440), "day");
}
