import { todayInTimezone } from "../../pacientes/timeline";

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

// Convert a workspace calendar date to an instant without using the browser's timezone.
export function zonedDayStart(date: string, timezone: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (let i = 0; i < 3; i++) {
    const parts = formatter.formatToParts(new Date(guess));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const observed = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    guess += target - observed;
  }
  return new Date(guess).toISOString();
}

export function dateBounds(period: "today" | "7d" | "30d" | "custom", timezone: string, from: string, to: string): { start: string; end: string } {
  const today = todayInTimezone(timezone);
  const startDate = period === "today" ? today : period === "7d" ? shiftDate(today, -6) : period === "30d" ? shiftDate(today, -29) : from || today;
  const endDate = period === "custom" ? to || today : today;
  if (startDate > endDate) throw new Error("La fecha inicial debe ser anterior a la final.");
  return { start: zonedDayStart(startDate, timezone), end: zonedDayStart(shiftDate(endDate, 1), timezone) };
}
