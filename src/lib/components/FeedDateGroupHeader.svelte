<script lang="ts">
  // FeedDateGroupHeader — date label above each /feed card group (Plan
  // 02.1-19, UAT round-2 gap "date-group header"). Mirrors Google Photos /
  // Apple Photos timeline UI.
  //
  // Reuses formatFeedDate (Plan 02.1-16) so the label format matches what
  // <FeedCard> used to render inline (Today HH:MM / Yesterday / Mon D /
  // Mon D, YYYY). The HH:MM suffix on Today reads slightly oddly as a
  // date header — Plan 02.1-19 truncates "Today, HH:MM" to "Today" for the
  // header context.

  import { formatFeedDate } from "$lib/util/format-feed-date.js";

  let { occurredAt }: { occurredAt: Date | string } = $props();

  const label = $derived.by(() => {
    const raw = formatFeedDate(occurredAt);
    // Trim "Today, HH:MM" → "Today" — the header is per-day, time-of-day
    // is on the card if needed (Phase 4 may surface it; 2.1 does not).
    return raw.startsWith("Today") ? "Today" : raw;
  });

  const occurredIso = $derived(
    typeof occurredAt === "string" ? occurredAt : occurredAt.toISOString(),
  );
</script>

<h2 class="date-header">
  <time datetime={occurredIso} title={occurredIso}>{label}</time>
</h2>

<style>
  .date-header {
    margin: 0;
    padding: var(--space-sm) 0 var(--space-xs);
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    position: sticky;
    top: 0;
    background: var(--color-bg);
    z-index: 1;
    /* Span all grid columns so the header separates card groups visually. */
    grid-column: 1 / -1;
  }
</style>
