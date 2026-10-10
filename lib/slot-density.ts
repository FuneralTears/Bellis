/** How many start times the patient sees before asking for more. */
export const SLOT_PREVIEW = 8;

/**
 * Which of the offered times are drawn. It only trims what is shown: the list itself is the one the server sent.
 * `expandedDay` is the day whose list the patient opened, so any other date starts collapsed again.
 * A selected time past the preview opens the list by itself, so the choice is never hidden.
 */
export function slotDensity<T extends { value: string }>({ slots, selected, day, expandedDay }: { slots: T[]; selected: string; day: string; expandedDay: string | null }): { visible: T[]; hasMore: boolean; expanded: boolean } {
  const collapsible = slots.length > SLOT_PREVIEW;
  const expanded = collapsible && ((!!day && expandedDay === day) || slots.findIndex((item) => item.value === selected) >= SLOT_PREVIEW);
  return { visible: collapsible && !expanded ? slots.slice(0, SLOT_PREVIEW) : slots, hasMore: collapsible && !expanded, expanded };
}
