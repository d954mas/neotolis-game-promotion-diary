<script lang="ts">
  // InboxBadge — small chip rendered on FeedRow when the event is in the
  // inbox (game_id IS NULL && metadata.inbox.dismissed !== true). Per
  // UI-SPEC §"<InboxBadge> and <PollingBadge> text" + §"Color" — uses muted
  // tokens (background `--color-border`, text `--color-text-muted`) so it
  // communicates "awaiting attachment" without reading as a status award.
  //
  // Accessibility (UI-SPEC §"Accessibility Floor delta"): role="status" so
  // screen readers announce the badge when it appears (e.g. when a row's
  // metadata.inbox.dismissed flips from true → false through a future
  // restore flow).

  import { m } from "$lib/paraglide/messages.js";
</script>

<span class="inbox-badge" role="status" title={m.inbox_badge_tooltip()}>
  {m.inbox_badge()}
</span>

<style>
  /* v2 InboxBadge — --r-pill chip with --accent-soft + --accent for the
   * "awaiting attachment" affordance. Promoted from muted-neutral to the
   * accent wash so the inbox state reads as actionable. */
  .inbox-badge {
    display: inline-flex;
    align-items: center;
    background: var(--accent-soft);
    color: var(--accent);
    padding: var(--s-0) var(--s-2);
    border-radius: var(--r-pill);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    font-weight: var(--w-md);
    line-height: 1;
    white-space: nowrap;
  }
</style>
