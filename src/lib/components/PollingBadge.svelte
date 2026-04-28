<script lang="ts">
  // PollingBadge — Phase-2.1 placeholder for the per-event polling-tier
  // surface that Phase 3 lands (POLL-05 "Hot/Warm/Cold/Stale").
  //
  // CONTEXT D-05 (unified contract — overrides UI-SPEC FLAG): rendered for
  // every event whose `kind ∈ {youtube_video, reddit_post}` AND
  // `last_polled_at IS NULL`, REGARDLESS of `source_id`. The user clarified
  // that manually-pasted YouTube videos must receive stats history too;
  // both source-attached AND orphan-pollable events get the same badge.
  // Hidden for non-pollable kinds (`conference`, `talk`, `press`, `other`,
  // `twitter_post`, `telegram_post`, `discord_drop`).
  //
  // Phase 3 will replace the placeholder logic with real per-tier text
  // ("Hot · last polled 2h ago", etc.); the component contract survives the
  // transition (one `<PollingBadge>` element, two phases of behavior).
  //
  // Accessibility (UI-SPEC §"Accessibility Floor delta"): role="status" so
  // screen readers announce the badge when it appears.

  import { m } from "$lib/paraglide/messages.js";

  type EventKind =
    | "youtube_video"
    | "reddit_post"
    | "twitter_post"
    | "telegram_post"
    | "discord_drop"
    | "conference"
    | "talk"
    | "press"
    | "other"
    | "post";

  type EventForBadge = {
    kind: EventKind;
    lastPolledAt: Date | string | null;
  };

  let { event }: { event: EventForBadge } = $props();

  const visible = $derived(
    (event.kind === "youtube_video" || event.kind === "reddit_post") && event.lastPolledAt === null,
  );
</script>

{#if visible}
  <span class="polling-badge" role="status">
    {m.polling_badge_phase3_placeholder()}
  </span>
{/if}

<style>
  .polling-badge {
    display: inline-flex;
    align-items: center;
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    padding: var(--space-xs) var(--space-sm);
    border: 1px dashed var(--color-border);
    border-radius: 4px;
    line-height: 1;
    white-space: nowrap;
  }
</style>
