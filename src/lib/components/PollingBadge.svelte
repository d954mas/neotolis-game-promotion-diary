<script lang="ts">
  // PollingBadge — Phase 3.0 Plan 11 LIVE-STATE rewrite.
  //
  // Replaces the Phase 2.1 placeholder ("Phase 3 will start polling" — retired
  // in Plan 02; the never-polled-yet branch then fell back to
  // polling_badge_manual until this rewrite).
  //
  // Renders one of FIVE user-facing variants per UI-SPEC §"Component
  // inventory: PollingBadge REWRITE" + §"Color → variant color rules" +
  // §"Copywriting Contract":
  //
  //   active           → "Hot · checked {hoursAgo}h ago"
  //   cold-yesterday   → "Cold · yesterday"
  //   cold-days-ago    → "Cold · {daysAgo}d ago"
  //   frozen           → "Frozen · refresh to update"
  //   unavailable      → "Unavailable · last seen {daysAgo}d ago"
  //   manual           → "Manual entry — no polling"   (lastPolledAt=null AND tier=Active)
  //
  // The 6th "Throttled" variant from D-NEW lives ONLY in /admin/quota
  // (DV-3 — service quota state is operator-only); this component does NOT
  // render it on /feed.
  //
  // PITFALL 7 — TIER RESOLUTION SINGLE SOURCE OF TRUTH
  //
  // The age boundaries (24h Active / 28d Cold / Frozen) and last_poll_status
  // overrides ('not_found' / 'private' / 'auth_error' → unavailable) are
  // codified in src/lib/server/services/tier-resolver.ts. SvelteKit's $lib/server
  // boundary forbids client components from importing that module (the
  // services barrel pulls in Node-only deps via its sibling files). To
  // preserve the single-source-of-truth invariant we MIRROR the rules
  // inline here AND ship a unit test (tests/unit/tier-resolver-client-mirror.test.ts)
  // that asserts the two functions return identical results for the same
  // battery of inputs as tests/unit/tier-resolver.test.ts. Any change to
  // the boundaries lands in lock-step in BOTH files, with the mirror test
  // failing if drift creeps in.
  //
  // CONTEXT D-05 (age boundaries):
  //   - age <  24h           → 'active'
  //   - age >= 24h && < 28d  → 'cold'
  //   - age >= 28d           → 'frozen'
  //
  // CONTEXT D-12 (last_poll_status overrides — irrespective of age):
  //   - 'not_found' / 'private' / 'auth_error' → 'unavailable'
  //
  // PITFALL H — Date | string | null prop type. SvelteKit serializes Date
  // values to ISO strings when crossing the loader → page boundary; the
  // component coerces defensively before doing any math.
  //
  // Refresh-now affordance visibility (D-10):
  //   visible WHEN (last_polled_at IS NOT NULL) OR tier=Frozen
  //   hidden  WHEN  last_polled_at IS NULL  AND tier ≠ Frozen
  //
  // Accessibility (UI-SPEC §"Accessibility Floor delta"):
  //   role="status" + aria-live="polite" — preserved from Phase 2.1.

  import { m } from "$lib/paraglide/messages.js";
  import RefreshNowButton from "./RefreshNowButton.svelte";

  // MIRRORS services/tier-resolver.ts; Pitfall 7 — keep in sync.
  // tests/unit/tier-resolver-client-mirror.test.ts asserts both functions
  // return identical results for the same battery of inputs.
  const TIER_BOUNDARY_ACTIVE_MS = 86_400_000; // 24h
  const TIER_BOUNDARY_COLD_MS = 28 * 86_400_000; // 28d
  const UNAVAILABLE_POLL_STATUSES: readonly string[] = ["not_found", "private", "auth_error"];

  type Tier = "pending" | "active" | "cold" | "frozen" | "unavailable";

  // MIRRORS services/tier-resolver.ts; Pitfall 7 — keep in sync.
  // Per-video refactor (2026-05-06): tier keyed on publishedAt (the video's
  // age), not occurredAt (the event's age). NULL publishedAt → 'pending'
  // (channel-context-backfill in flight; show "Pending..." badge).
  function resolveTier(publishedAt: Date | null, lastPollStatus: string | null, now: Date): Tier {
    if (publishedAt === null) return "pending";
    if (lastPollStatus !== null && UNAVAILABLE_POLL_STATUSES.includes(lastPollStatus)) {
      return "unavailable";
    }
    const ageMs = now.getTime() - publishedAt.getTime();
    if (ageMs < TIER_BOUNDARY_ACTIVE_MS) return "active";
    if (ageMs < TIER_BOUNDARY_COLD_MS) return "cold";
    return "frozen";
  }

  type EventForBadge = {
    id: string;
    kind: string;
    occurredAt: Date | string;
    // Per-video refactor (2026-05-06): publishedAt drives tier resolution.
    // Optional so callers that haven't yet plumbed the youtube_videos JOIN
    // (older surfaces, stale fixtures) keep compiling. undefined → null
    // in the $derived coercion below → 'pending' tier.
    publishedAt?: Date | string | null;
    lastPolledAt: Date | string | null;
    lastPollStatus: string | null;
    metadata: Record<string, unknown> | null;
  };

  let { event }: { event: EventForBadge } = $props();

  // UI-SPEC: PollingBadge stays YouTube-only in 3.0; 3.1 adds Reddit.
  const POLLABLE_KINDS = ["youtube_video"];

  // Defensive Date coercion (Pitfall H).
  const publishedAt = $derived(
    event.publishedAt == null
      ? null
      : typeof event.publishedAt === "string"
        ? new Date(event.publishedAt)
        : event.publishedAt,
  );
  const lastPolledAt = $derived(
    event.lastPolledAt == null
      ? null
      : typeof event.lastPolledAt === "string"
        ? new Date(event.lastPolledAt)
        : event.lastPolledAt,
  );

  // `now` re-evaluated on each render. The badge is mounted inside FeedCard
  // which re-renders on loader invalidation (RefreshNowButton calls
  // invalidateAll() after a successful refresh) — so the value is fresh
  // enough for the user-facing copy.
  const now = $derived(new Date());

  const tier: Tier = $derived(resolveTier(publishedAt, event.lastPollStatus, now));

  // Variant resolution per UI-SPEC §"Interaction Contracts → Variant resolution".
  type Variant =
    | "pending"
    | "active"
    | "cold-yesterday"
    | "cold-days-ago"
    | "frozen"
    | "unavailable"
    | "manual";

  const variant: Variant = $derived.by((): Variant => {
    if (tier === "pending") return "pending";
    if (tier === "unavailable") return "unavailable";
    if (lastPolledAt === null && tier === "active") return "manual";
    if (tier === "active") return "active";
    if (tier === "cold") {
      const daysSincePoll = lastPolledAt
        ? (now.getTime() - lastPolledAt.getTime()) / 86_400_000
        : 999;
      return daysSincePoll < 2 ? "cold-yesterday" : "cold-days-ago";
    }
    return "frozen";
  });

  // Refresh-now visibility: D-10 — only for events with a successful prior
  // poll OR Frozen tier (where the user can rescue an old event).
  // 'pending' tier hides refresh — backfill is in flight, manual poll
  // would race it. Refresh-poll service rejects 'pending' with 422 anyway.
  const refreshVisible = $derived(
    POLLABLE_KINDS.includes(event.kind) &&
      tier !== "pending" &&
      (lastPolledAt !== null || tier === "frozen"),
  );

  // Copy resolution.
  const copy = $derived.by(() => {
    const hoursAgo = lastPolledAt
      ? Math.max(1, Math.round((now.getTime() - lastPolledAt.getTime()) / 3_600_000))
      : 0;
    const daysAgo = lastPolledAt
      ? Math.max(1, Math.round((now.getTime() - lastPolledAt.getTime()) / 86_400_000))
      : 0;
    switch (variant) {
      case "pending":
        return m.polling_badge_pending();
      case "active":
        return m.polling_badge_hot({ hoursAgo });
      case "cold-yesterday":
        return m.polling_badge_cold_yesterday();
      case "cold-days-ago":
        return m.polling_badge_cold_days_ago({ daysAgo });
      case "frozen":
        return m.polling_badge_frozen();
      case "unavailable":
        return m.polling_badge_unavailable({ daysAgo });
      case "manual":
        return m.polling_badge_manual();
    }
  });
</script>

{#if POLLABLE_KINDS.includes(event.kind)}
  <span class="polling-badge polling-badge--{variant}" role="status" aria-live="polite">
    <span class="polling-badge__icon" aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        fill="none"
      >
        <circle cx="12" cy="12" r="6" />
      </svg>
    </span>
    <span class="polling-badge__text">{copy}</span>
    {#if refreshVisible}
      <RefreshNowButton {event} />
    {/if}
  </span>
{/if}

<style>
  .polling-badge {
    display: inline-flex;
    gap: var(--space-xs);
    align-items: center;
    padding: 2px var(--space-sm);
    border-radius: 4px;
    font-size: var(--font-size-label);
    line-height: 1.4;
    white-space: nowrap;
  }

  .polling-badge__icon {
    display: inline-flex;
    align-items: center;
  }

  /* Hot · checked Xh ago — green icon, normal text, solid border. */
  .polling-badge--active {
    border: 1px solid var(--color-border);
    color: var(--color-text);
  }
  .polling-badge--active .polling-badge__icon {
    color: var(--color-success);
  }

  /* Cold · yesterday | Cold · Xd ago — info-cyan icon, muted text, solid border. */
  .polling-badge--cold-yesterday,
  .polling-badge--cold-days-ago {
    border: 1px solid var(--color-border);
    color: var(--color-text-muted);
  }
  .polling-badge--cold-yesterday .polling-badge__icon,
  .polling-badge--cold-days-ago .polling-badge__icon {
    color: var(--color-info);
  }

  /* Frozen · refresh to update — neutral icon, muted text, DASHED border
     (signals "polling has stopped on its own — refresh-now to rescue"). */
  .polling-badge--frozen {
    border: 1px dashed var(--color-border);
    color: var(--color-text-muted);
  }
  .polling-badge--frozen .polling-badge__icon {
    color: var(--color-text-muted);
  }

  /* Unavailable · last seen Xd ago — destructive-red icon (status, NOT
     destructive-fill), muted text, solid border. */
  .polling-badge--unavailable {
    border: 1px solid var(--color-border);
    color: var(--color-text-muted);
  }
  .polling-badge--unavailable .polling-badge__icon {
    color: var(--color-destructive);
  }

  /* Manual entry — no polling — neutral icon, muted text, DASHED border
     (matches Phase 2.1 placeholder visual to signal "no polling lifecycle"). */
  .polling-badge--manual {
    border: 1px dashed var(--color-border);
    color: var(--color-text-muted);
  }
  .polling-badge--manual .polling-badge__icon {
    color: var(--color-text-muted);
  }

  /* Pending · fetching video info — neutral icon, muted text, dotted
     border to signal a transient "data on the way" state (distinct from
     dashed Frozen/Manual which are stable end-states). The badge clears
     within seconds of paste once channel-context-backfill writes the
     youtube_videos row. */
  .polling-badge--pending {
    border: 1px dotted var(--color-border);
    color: var(--color-text-muted);
  }
  .polling-badge--pending .polling-badge__icon {
    color: var(--color-text-muted);
  }
</style>
