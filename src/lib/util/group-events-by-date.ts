/**
 * groupEventsByDate — pure utility splitting an EventDto list into
 * date-keyed groups. Used by /feed/+page.svelte to render
 * <FeedDateGroupHeader> + <FeedCard>[] per calendar date.
 *
 * Grouping is by calendar date (YYYY-MM-DD) of occurredAt. The day key is
 * chosen by `keyOf`, defaulting to UTC (`toISOString().slice(0,10)`) for the
 * feed. The /games chart cluster modal passes a LOCAL-day keyer so its group
 * keys line up with the page's local `eventDay`-keyed delta map (otherwise a
 * near-midnight event's per-day delta would fail to resolve in a negative-offset
 * zone). Events at 23:50 and 00:10 of the next day land in different groups
 * under whichever zone `keyOf` uses.
 *
 * Input is assumed to be sorted DESC by occurredAt (listFeedPage's order).
 * The function preserves input order within and across groups — it does
 * NOT re-sort. Consumer renders groups in iteration order.
 */
export interface DateGroup<T> {
  date: string; // YYYY-MM-DD (in the zone `keyOf` uses — UTC by default)
  occurredAt: Date; // First (most recent) event's occurredAt — drives the header label
  rows: T[];
}

export function groupEventsByDate<T extends { occurredAt: Date | string }>(
  rows: T[],
  keyOf: (d: Date) => string = (d) => d.toISOString().slice(0, 10),
): DateGroup<T>[] {
  const groups: DateGroup<T>[] = [];
  let currentKey: string | null = null;
  let currentGroup: DateGroup<T> | null = null;
  for (const row of rows) {
    const d = row.occurredAt instanceof Date ? row.occurredAt : new Date(row.occurredAt);
    const key = keyOf(d);
    if (key !== currentKey) {
      currentGroup = { date: key, occurredAt: d, rows: [] };
      groups.push(currentGroup);
      currentKey = key;
    }
    // currentGroup is non-null here by construction.
    if (currentGroup) currentGroup.rows.push(row);
  }
  return groups;
}
