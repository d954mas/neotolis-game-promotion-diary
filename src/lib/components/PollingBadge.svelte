<script lang="ts">
  // PollingBadge — live-state polling-freshness indicator.
  //
  // Renders one of these user-facing variants:
  //
  //   active           → "Hot · checked {hoursAgo}h ago"
  //   cold-yesterday   → "Cold · yesterday"
  //   cold-days-ago    → "Cold · {daysAgo}d ago"
  //   frozen           → "Frozen · refresh to update"
  //   unavailable      → "Unavailable · last seen {daysAgo}d ago"
  //   manual           → "Manual entry — no polling"   (lastPolledAt=null AND tier=Active)
  //
  // The Throttled variant lives ONLY in /admin/quota (service quota state
  // is operator-only); this component does NOT render it on /feed.
  //
  // TIER RESOLUTION SINGLE SOURCE OF TRUTH
  //
  // The age boundaries (24h Active / 28d Cold / Frozen) and last_poll_status
  // overrides ('not_found' / 'private' / 'auth_error' → unavailable) are
  // codified in src/lib/server/services/tier-resolver.ts. SvelteKit's
  // $lib/server boundary forbids client components from importing that
  // module (the services barrel pulls in Node-only deps via its sibling
  // files). To preserve the single-source-of-truth invariant we MIRROR the
  // rules inline here AND ship a unit test
  // (tests/unit/tier-resolver-client-mirror.test.ts) that asserts the two
  // functions return identical results for the same battery of inputs as
  // tests/unit/tier-resolver.test.ts. Any change to the boundaries lands
  // in lock-step in BOTH files, with the mirror test failing if drift
  // creeps in.
  //
  // Age boundaries:
  //   - age <  24h           → 'active'
  //   - age >= 24h && < 28d  → 'cold'
  //   - age >= 28d           → 'frozen'
  //
  // last_poll_status overrides (irrespective of age):
  //   - 'not_found' / 'private' / 'auth_error' → 'unavailable'
  //
  // Date | string | null prop type. SvelteKit serializes Date values to
  // ISO strings when crossing the loader → page boundary; the component
  // coerces defensively before doing any math.
  //
  // Refresh-now affordance visibility:
  //   visible WHEN (last_polled_at IS NOT NULL) OR tier=Frozen
  //   hidden  WHEN  last_polled_at IS NULL  AND tier ≠ Frozen
  //
  // Accessibility: role="status" + aria-live="polite".

  import { m } from "$lib/paraglide/messages.js";
  import RefreshNowButton from "./RefreshNowButton.svelte";

  // MIRRORS services/tier-resolver.ts — keep in sync.
  // tests/unit/tier-resolver-client-mirror.test.ts asserts both functions
  // return identical results for the same battery of inputs.
  const TIER_BOUNDARY_ACTIVE_MS = 86_400_000; // 24h
  const TIER_BOUNDARY_COLD_MS = 28 * 86_400_000; // 28d
  const UNAVAILABLE_POLL_STATUSES: readonly string[] = ["not_found", "private", "auth_error"];
  const REFRESH_QUEUE_VISIBLE_MS = 5 * 60 * 1000;

  type Tier = "pending" | "active" | "cold" | "frozen" | "unavailable";

  // MIRRORS services/tier-resolver.ts — keep in sync.
  // Tier keyed on publishedAt (the video's age), not occurredAt (the
  // event's age). NULL publishedAt → 'pending' (channel-context-backfill
  // in flight; show "Pending..." badge).
  // Bootstrap rule: frozen by age + lastPolledAt=null → upgrade to 'cold'
  // so the scheduler picks the video up once. See the canonical resolver
  // header for the issue #29 extension rationale.
  function resolveTier(
    publishedAt: Date | null,
    lastPollStatus: string | null,
    lastPolledAt: Date | null,
    now: Date,
  ): Tier {
    if (publishedAt === null) return "pending";
    if (lastPollStatus !== null && UNAVAILABLE_POLL_STATUSES.includes(lastPollStatus)) {
      return "unavailable";
    }
    const ageMs = now.getTime() - publishedAt.getTime();
    if (ageMs < TIER_BOUNDARY_ACTIVE_MS) return "active";
    if (ageMs < TIER_BOUNDARY_COLD_MS) return "cold";
    if (lastPolledAt === null) return "cold";
    return "frozen";
  }

  type EventForBadge = {
    id: string;
    kind: string;
    occurredAt: Date | string;
    // publishedAt drives tier resolution. Optional so callers that haven't
    // yet plumbed the youtube_videos JOIN (older surfaces, stale fixtures)
    // keep compiling. undefined → null in the $derived coercion below →
    // 'pending' tier.
    publishedAt?: Date | string | null;
    lastPolledAt: Date | string | null;
    lastPollStatus: string | null;
    metadata: Record<string, unknown> | null;
  };

  let { event }: { event: EventForBadge } = $props();

  // PollingBadge is YouTube-only today; future source kinds (e.g. Reddit) extend this list.
  const POLLABLE_KINDS = ["youtube_video", "reddit_post"];

  // Defensive Date coercion — props may arrive as ISO strings.
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
  const lastUserRefreshAt = $derived.by((): Date | null => {
    const meta = event.metadata;
    if (meta === null || typeof meta !== "object") return null;
    const raw = (meta as { last_user_refresh_at?: unknown }).last_user_refresh_at;
    if (typeof raw !== "string") return null;
    const ts = Date.parse(raw);
    return Number.isFinite(ts) ? new Date(ts) : null;
  });

  // `now` re-evaluated on each render. The badge is mounted inside FeedCard
  // which re-renders on loader invalidation (RefreshNowButton calls
  // invalidateAll() after a successful refresh) — so the value is fresh
  // enough for the user-facing copy.
  const now = $derived(new Date());

  const tier: Tier = $derived(resolveTier(publishedAt, event.lastPollStatus, lastPolledAt, now));

  // Variant resolution per UI-SPEC §"Interaction Contracts → Variant resolution".
  type Variant =
    | "pending"
    | "active"
    | "cold-yesterday"
    | "cold-days-ago"
    | "frozen"
    | "unavailable"
    | "refreshing"
    | "manual";

  // 5s tolerance closes a paste-flow race: services/events.ts writes
  // `last_user_refresh_at` AFTER syncStats.fetch's snapshot lands, so a
  // freshly-pasted YouTube/Reddit row briefly looks like
  // lastUserRefreshAt > lastPolledAt (by ~20–200ms) even though the poll
  // actually completed. Real refresh-now flows take ≥ a full worker
  // tick (Reddit pacer 7.5s, YouTube tick interval) before the badge
  // is supposed to flip off, so a 5s tolerance keeps that case intact
  // while removing the false-positive "Refresh queued" on paste.
  const REFRESH_QUEUE_TOLERANCE_MS = 5_000;
  const refreshQueued = $derived.by(() => {
    if (lastUserRefreshAt === null) return false;
    if (now.getTime() - lastUserRefreshAt.getTime() > REFRESH_QUEUE_VISIBLE_MS) return false;
    if (lastPolledAt === null) return true;
    return lastUserRefreshAt.getTime() > lastPolledAt.getTime() + REFRESH_QUEUE_TOLERANCE_MS;
  });

  const variant: Variant = $derived.by((): Variant => {
    if (tier === "pending") return "pending";
    if (refreshQueued) return "refreshing";
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

  // Refresh-now visibility: visible for any pollable event NOT in
  // 'pending' tier. An earlier rule also required
  // (lastPolledAt !== null || tier === "frozen") — that hid refresh on
  // cold/active videos with no prior poll, leaving manually-pasted videos
  // stuck without a way to fetch stats. Synchronous stats-fetch on paste
  // (createEventFromPaste → adapter.syncStats.fetch) made cold/active
  // without prior poll rare; when it does happen (rate-limit / auth-error
  // swallow), the user has an explicit refresh button to rescue.
  // 'pending' tier still hides refresh — backfill is in flight, manual
  // poll would race it. Refresh-poll service rejects 'pending' with 422.
  const refreshVisible = $derived(POLLABLE_KINDS.includes(event.kind) && tier !== "pending");

  // Copy resolution. The visible text uses "Updated X ago" relative time
  // (user-meaningful) rather than tier vocabulary ("Cold", "Frozen").
  // Tier still drives variant CSS (colors); the text is what the user
  // actually cares about: how stale are the stats. 'pending' /
  // 'unavailable' / 'manual' still use the dedicated copy (they signal
  // special states, not just freshness).
  const copy = $derived.by(() => {
    if (variant === "pending") return m.polling_badge_pending();
    if (variant === "refreshing") return "Refresh queued";
    if (variant === "manual") return m.polling_badge_manual();
    if (lastPolledAt === null) {
      // Active without prior poll — manual-paste fallback for swallowed
      // sync-fetch errors (rate-limit / auth-error). Not yet updated.
      return "Not yet updated";
    }
    const elapsedMs = now.getTime() - lastPolledAt.getTime();
    const minutesAgo = Math.max(1, Math.round(elapsedMs / 60_000));
    const hoursAgo = Math.round(elapsedMs / 3_600_000);
    const daysAgo = Math.round(elapsedMs / 86_400_000);
    let relative: string;
    if (elapsedMs < 60_000) {
      relative = "just now";
    } else if (minutesAgo < 60) {
      relative = `${minutesAgo} min ago`;
    } else if (hoursAgo < 24) {
      relative = `${hoursAgo}h ago`;
    } else if (daysAgo < 30) {
      relative = `${daysAgo}d ago`;
    } else {
      relative = lastPolledAt.toLocaleDateString();
    }
    if (variant === "unavailable") return `Unavailable · updated ${relative}`;
    return `Updated ${relative}`;
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
  /* v2 PollingBadge — 5-state matrix (active / cold-yesterday / cold-days-ago
   * / frozen / unavailable + transient pending / refreshing / manual)
   * PRESERVED via per-variant class names. tests/browser/polling-badge.test.ts
   * asserts labels + visual states. */
  .polling-badge {
    display: inline-flex;
    gap: var(--s-1);
    align-items: center;
    padding: var(--s-0) var(--s-2);
    border-radius: var(--r-pill);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    font-weight: var(--w-rg);
    line-height: 1.4;
    white-space: nowrap;
  }

  .polling-badge__icon {
    display: inline-flex;
    align-items: center;
  }

  /* Hot / Updated Xh ago — accent wash (the fresh, just-polled state). */
  .polling-badge--active {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .polling-badge--active .polling-badge__icon {
    color: var(--success);
  }

  /* Cold · yesterday | Cold · Xd ago — neutral surface, muted text. */
  .polling-badge--cold-yesterday,
  .polling-badge--cold-days-ago {
    background: var(--surface-2);
    color: var(--text-2);
  }
  .polling-badge--cold-yesterday .polling-badge__icon,
  .polling-badge--cold-days-ago .polling-badge__icon {
    color: var(--info);
  }

  /* Frozen · refresh to update — neutral surface, deeper muted text
     (signals "polling has stopped on its own — refresh-now to rescue"). */
  .polling-badge--frozen {
    background: var(--surface-2);
    color: var(--text-3);
  }
  .polling-badge--frozen .polling-badge__icon {
    color: var(--text-3);
  }

  /* Unavailable · updated Xd ago — neutral surface, danger text (status,
     not destructive fill). */
  .polling-badge--unavailable {
    background: var(--surface-2);
    color: var(--danger);
  }
  .polling-badge--unavailable .polling-badge__icon {
    color: var(--danger);
  }

  /* Manual entry — no polling — neutral surface, muted text. */
  .polling-badge--manual {
    background: var(--surface-2);
    color: var(--text-3);
  }
  .polling-badge--manual .polling-badge__icon {
    color: var(--text-3);
  }

  /* Pending · fetching video info — transient channel-context-backfill
     window. Clears within seconds of paste. */
  .polling-badge--pending {
    background: var(--surface-2);
    color: var(--text-3);
  }
  .polling-badge--pending .polling-badge__icon {
    color: var(--text-3);
  }

  /* Refreshing — Refresh queued (info wash, brief transient state). */
  .polling-badge--refreshing {
    background: var(--surface-2);
    color: var(--info);
  }
  .polling-badge--refreshing .polling-badge__icon {
    color: var(--info);
  }
</style>
