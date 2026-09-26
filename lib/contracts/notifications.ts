export type NotificationChannel = "email" | "whatsapp" | "sms";
export type NotificationJob = { id: string; recipient: string; template: "booking_confirmed" | "reminder_24h" | "reminder_2h"; appointmentId: string; locale: string };
export interface NotificationProvider {
  readonly channel: NotificationChannel;
  send(job: NotificationJob): Promise<{ providerMessageId: string }>;
}
/** Schedule once in an outbox table; workers retry jobs idempotently by job ID. */
export const reminderOffsetsMinutes = { reminder_24h: 1440, reminder_2h: 120 } as const;
