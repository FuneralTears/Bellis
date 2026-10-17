/**
 * The period the agenda shows. Days are local dates of the workspace, YYYY-MM-DD, never instants: the caller turns
 * each appointment into its local day once, with the workspace timezone, and everything here is date arithmetic.
 * No data access and no clock: "today" is passed in.
 *
 *   Día     one calendar day.
 *   Semana  seven consecutive days, Monday to Sunday, the week of the anchor.
 *   Mes     the calendar month of the anchor, from its 1st to its last day.
 */

export type AgendaView = "Día" | "Semana" | "Mes";
export const agendaViews: AgendaView[] = ["Día", "Semana", "Mes"];

/** `start` and `end` are both included. `days` lists every day of the period, in order, with or without turns. */
export type AgendaPeriod = { view: AgendaView; anchor: string; start: string; end: string; days: string[] };

const pattern = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(day: string): [number, number, number] {
  const match = pattern.exec(day);
  if (!match) throw new Error(`invalid_day:${day}`);
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, date));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) throw new Error(`invalid_day:${day}`);
  return [year, month, date];
}
const format = (time: number) => new Date(time).toISOString().slice(0, 10);
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

export function isDay(value: string): boolean {
  try { parts(value); return true; } catch { return false; }
}

export function addDays(day: string, amount: number): string {
  const [year, month, date] = parts(day);
  return format(Date.UTC(year, month - 1, date + amount));
}

/** The same day of another month; the 31st becomes the last day when that month is shorter. */
export function addMonths(day: string, amount: number): string {
  const [year, month, date] = parts(day);
  const first = new Date(Date.UTC(year, month - 1 + amount, 1));
  const max = daysInMonth(first.getUTCFullYear(), first.getUTCMonth() + 1);
  return format(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(date, max)));
}

/** Weeks start on Monday, as calendars are read in Argentina. */
export function startOfWeek(day: string): string {
  const [year, month, date] = parts(day);
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}

export function agendaPeriod(view: AgendaView, anchor: string): AgendaPeriod {
  const [year, month] = parts(anchor);
  const start = view === "Día" ? anchor : view === "Semana" ? startOfWeek(anchor) : `${anchor.slice(0, 7)}-01`;
  const length = view === "Día" ? 1 : view === "Semana" ? 7 : daysInMonth(year, month);
  const days = Array.from({ length }, (_, index) => addDays(start, index));
  return { view, anchor, start, end: days[days.length - 1], days };
}

/** The anchor one period before (-1) or after (1): a day, a week or a month. */
export function shiftPeriod(view: AgendaView, anchor: string, step: 1 | -1): string {
  return view === "Día" ? addDays(anchor, step) : view === "Semana" ? addDays(anchor, 7 * step) : addMonths(anchor, step);
}

export function inPeriod(period: Pick<AgendaPeriod, "start" | "end">, day: string): boolean {
  return day >= period.start && day <= period.end;
}

/** Only what falls inside the period, in time order. Turns of other weeks or months are never mixed in. */
export function appointmentsInPeriod<T extends { dateKey: string; startTime: string }>(period: Pick<AgendaPeriod, "start" | "end">, items: T[]): T[] {
  return items.filter((item) => inPeriod(period, item.dateKey))
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey) || a.startTime.localeCompare(b.startTime));
}

/** The weeks a month grid draws, Monday to Sunday. The first and last weeks may include days of the next or previous month. */
export function monthWeeks(period: Pick<AgendaPeriod, "start" | "end">): string[][] {
  const weeks: string[][] = [];
  for (let monday = startOfWeek(period.start); monday <= period.end; monday = addDays(monday, 7))
    weeks.push(Array.from({ length: 7 }, (_, index) => addDays(monday, index)));
  return weeks;
}

const capital = (text: string, locale: string) => text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
// A local day is formatted at noon UTC with the UTC timezone: the same date in every timezone and on every computer.
const intl = (day: string, locale: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
const shortMonth = (day: string, locale: string) => intl(day, locale, { month: "short" }).replace(".", "");

/** How a day heads its column: "lunes" and "12 oct 2026". */
export function dayLabels(day: string, locale: string): { weekday: string; dateLabel: string } {
  parts(day);
  return { weekday: intl(day, locale, { weekday: "long" }), dateLabel: `${intl(day, locale, { day: "numeric" })} ${shortMonth(day, locale)} ${intl(day, locale, { year: "numeric" })}` };
}

/** What period is on screen: "Lunes, 12 de octubre de 2026", "12 – 18 oct 2026", "28 sept – 4 oct 2026" or "Octubre de 2026". */
export function periodLabel(period: AgendaPeriod, locale: string): string {
  if (period.view === "Día") return capital(intl(period.start, locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }), locale);
  if (period.view === "Mes") return capital(intl(period.start, locale, { month: "long", year: "numeric" }), locale);
  const [day, month, year] = [(value: string) => intl(value, locale, { day: "numeric" }), (value: string) => shortMonth(value, locale), (value: string) => intl(value, locale, { year: "numeric" })];
  const { start, end } = period;
  if (start.slice(0, 7) === end.slice(0, 7)) return `${day(start)} – ${day(end)} ${month(end)} ${year(end)}`;
  if (start.slice(0, 4) === end.slice(0, 4)) return `${day(start)} ${month(start)} – ${day(end)} ${month(end)} ${year(end)}`;
  return `${day(start)} ${month(start)} ${year(start)} – ${day(end)} ${month(end)} ${year(end)}`;
}

/** How the arrows are read out: "Semana anterior", "Mes siguiente". */
export function stepLabel(view: AgendaView, step: 1 | -1): string {
  return `${view} ${step < 0 ? "anterior" : "siguiente"}`;
}

/** What the empty board says, for the period on screen. */
export function emptyPeriodText(view: AgendaView): string {
  return view === "Día" ? "No hay turnos este día" : view === "Semana" ? "No hay turnos esta semana" : "No hay turnos este mes";
}
