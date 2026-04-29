/**
 * Plan 02.1-19: groupEventsByDate — pure utility splitting an EventDto list
 * into date-keyed groups. Used by /feed/+page.svelte to render
 * <FeedDateGroupHeader> + <FeedCard>[] per calendar date (Google Photos /
 * Apple Photos timeline UI).
 *
 * Grouping is by UTC calendar date (YYYY-MM-DD) of occurredAt. Events at
 * 23:50 UTC and 00:10 UTC of the next UTC day land in different groups
 * even though they are 20 minutes apart. Rationale: occurredAt is stored
 * UTC; client-local-tz regrouping is a Phase 6 polish if UAT surfaces it.
 *
 * Input is assumed to be sorted DESC by occurredAt (listFeedPage's order).
 * The function preserves input order within and across groups — it does
 * NOT re-sort. Consumer renders groups in iteration order.
 */
export interface DateGroup<T> {
  date: string; // YYYY-MM-DD (UTC)
  occurredAt: Date; // First (most recent) event's occurredAt — drives the header label
  rows: T[];
}

export function groupEventsByDate<T extends { occurredAt: Date | string }>(
  rows: T[],
): DateGroup<T>[] {
  const groups: DateGroup<T>[] = [];
  let currentKey: string | null = null;
  let currentGroup: DateGroup<T> | null = null;
  for (const row of rows) {
    const d = row.occurredAt instanceof Date ? row.occurredAt : new Date(row.occurredAt);
    const key = d.toISOString().slice(0, 10);
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
