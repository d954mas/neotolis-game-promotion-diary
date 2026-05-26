<script lang="ts">
  // RefreshNowButton — icon-only inline button rendered inside
  // <PollingBadge> for events where (last_polled_at IS NOT NULL) OR
  // tier=Frozen.
  //
  // Interaction contract:
  //   - Idle: refresh icon at --text-3; --hit hit area; 16×16 glyph.
  //   - Click → POST /api/events/{id}/refresh-poll (no body).
  //   - Pending: spinning rotation 360°/1s, aria-busy="true", aria-live="polite"
  //     announces m.polling_refresh_now_pending().
  //   - On 200/202: enter cooldown and invalidateAll(); PollingBadge reads
  //     metadata.last_user_refresh_at and shows "Refresh queued" until
  //     youtube_videos.last_polled_at catches up.
  //   - On 429: cooldown-disabled state. Reads Retry-After header OR
  //     falls back to event.metadata.last_user_refresh_at + 5min to
  //     derive minutesLeft for the tooltip.
  //   - On 5xx / network: inline error below the badge via m.polling_refresh_now_error().
  //
  // Cooldown source of truth:
  //   - Initial state derived from event.metadata.last_user_refresh_at.
  //   - setInterval(30s) re-evaluates while mounted; cleared on unmount.
  //   - 5min cooldown matches the server-side gate.
  //
  // Accessibility:
  //   - aria-label on the icon-only button.
  //   - aria-busy="true" during pending state.
  //   - Cooldown tooltip via aria-describedby pointing at a sr-only span.
  //   - Spinning rotation gated on @media (prefers-reduced-motion: no-preference).

  import { m } from "$lib/paraglide/messages.js";
  import { invalidateAll } from "$app/navigation";

  type EventForRefresh = {
    id: string;
    metadata: Record<string, unknown> | null;
    lastPolledAt?: Date | string | null;
  };

  let { event }: { event: EventForRefresh } = $props();

  // Set to false on component unmount so a running poll-loop bails out
  // when the user navigates away mid-refresh. Without this, setTimeout
  // chains keep firing invalidateAll() against a dead component until
  // the budget exhausts — a soft leak under high traffic.
  let mounted = $state(true);
  $effect(() => {
    return () => {
      mounted = false;
    };
  });

  // 5-min cooldown — matches the server-side cooldown enforced by
  // requestRefreshPoll (which throws AppError 429 'too_many_refreshes'
  // with metadata.minutesLeft + retryAfterSeconds).
  const COOLDOWN_MS = 5 * 60 * 1000;
  const COOLDOWN_RECHECK_MS = 1_000;

  function readMetadataLastRefresh(meta: Record<string, unknown> | null): number | null {
    if (meta === null || typeof meta !== "object") return null;
    const v = (meta as { last_user_refresh_at?: unknown }).last_user_refresh_at;
    if (typeof v !== "string") return null;
    const ts = Date.parse(v);
    return Number.isFinite(ts) ? ts : null;
  }

  function computeCooldownSecondsFor(meta: Record<string, unknown> | null): number {
    const last = readMetadataLastRefresh(meta);
    if (last === null) return 0;
    const elapsed = Date.now() - last;
    if (elapsed >= COOLDOWN_MS) return 0;
    return Math.ceil((COOLDOWN_MS - elapsed) / 1000);
  }

  // Synchronous init from props — avoids the post-mount flicker where
  // the button briefly renders as "idle" before the $effect promotes
  // it to "cooldown". `untrack` decouples the read from the reactive
  // graph: the value at first paint is what we want; subsequent prop
  // changes go through the $effect-driven interval below.
  type UiState = "idle" | "pending" | "cooldown" | "done" | "error";
  const initialCooldown = computeCooldownSecondsFor(event.metadata);
  let uiState = $state<UiState>(initialCooldown > 0 ? "cooldown" : "idle");
  let cooldownSecondsLeft = $state(initialCooldown);

  function computeCooldownSeconds(): number {
    return computeCooldownSecondsFor(event.metadata);
  }

  // Per-second tick so the visible countdown decrements smoothly and
  // flips back to idle when the window closes. Initial state already
  // reflects metadata (see above) so the effect's job is purely the
  // tick + reactive prop changes (e.g. POST 200/202 invalidateAll
  // mutates event.metadata.last_user_refresh_at).
  $effect(() => {
    cooldownSecondsLeft = computeCooldownSeconds();
    if (cooldownSecondsLeft > 0 && uiState !== "pending" && uiState !== "done") {
      uiState = "cooldown";
    }
    const timer = setInterval(() => {
      cooldownSecondsLeft = computeCooldownSeconds();
      if (cooldownSecondsLeft === 0 && uiState === "cooldown") {
        uiState = "idle";
      }
    }, COOLDOWN_RECHECK_MS);
    return () => {
      clearInterval(timer);
    };
  });

  async function handleClick(): Promise<void> {
    if (uiState !== "idle") return;
    uiState = "pending";
    try {
      const resp = await fetch(`/api/events/${event.id}/refresh-poll`, { method: "POST" });
      if (resp.status === 200 || resp.status === 202) {
        cooldownSecondsLeft = COOLDOWN_MS / 1000;
        uiState = "cooldown";
        // Adaptive poll-loop:
        //   - first 15s: 1s cadence (covers fast case — YouTube ~2s,
        //     Reddit pacer ≤7.5s + API ≤1s when the queue is empty);
        //   - next ~105s: 5s cadence (covers busy queue — Reddit's 8 req/min
        //     ceiling means 1000 concurrent refresh-clicks drain over
        //     ~125 minutes WORST case, but a typical busy queue clears
        //     in 1–2 minutes);
        //   - hard cap at 2 minutes (PollingBadge's REFRESH_QUEUE_VISIBLE_MS
        //     is 5 minutes, so the badge keeps showing "queued" while we
        //     wait, then naturally falls back to the regular variant).
        //
        // Stop conditions:
        //   1. lastPolledAt > refreshAt — worker wrote a snapshot after
        //      the click instant. refreshAt = Date.now() at the moment
        //      the 200/202 returned is the right reference: the server
        //      writes last_user_refresh_at = NOW() inside the same
        //      transaction as the enqueue, so worker polls landing
        //      AFTER that wall-clock moment imply our enqueued row has
        //      drained. Reading event.metadata.last_user_refresh_at
        //      from props would lag a tick (we haven't awaited the
        //      invalidateAll below yet) AND would risk an early exit
        //      when an older prior refresh + a still-stale polledAt
        //      already satisfy polledAt > prior_refresh_at.
        //   2. mounted === false — user navigated away. No more
        //      invalidateAll() calls against a dead component.
        //
        // Pacer paused / cap exhausted / 1000 concurrent users:
        //   beyond 2min the poll-loop gives up. The PollingBadge falls
        //   back to its regular variant after REFRESH_QUEUE_VISIBLE_MS
        //   (5 min), and the user can hard-reload or revisit the page
        //   to see the eventual snapshot. Adding more polling iterations
        //   would just burn loader cycles in a dead-letter scenario.
        const refreshAt = Date.now();
        void invalidateAll();
        const FAST_ITERATIONS = 15;
        const TOTAL_ITERATIONS = FAST_ITERATIONS + 21; // ~120s budget
        for (let i = 0; i < TOTAL_ITERATIONS; i++) {
          if (!mounted) break;
          const sleepMs = i < FAST_ITERATIONS ? 1_000 : 5_000;
          await new Promise((r) => setTimeout(r, sleepMs));
          if (!mounted) break;
          await invalidateAll();
          const polledRaw = event.lastPolledAt;
          const polledAt =
            polledRaw == null
              ? null
              : typeof polledRaw === "string"
                ? Date.parse(polledRaw)
                : polledRaw instanceof Date
                  ? polledRaw.getTime()
                  : null;
          if (polledAt !== null && polledAt > refreshAt) break;
        }
        return;
      }
      if (resp.status === 429) {
        // The server sets Retry-After in seconds from err.metadata.retryAfterSeconds.
        const retryAfter = resp.headers.get("Retry-After");
        const seconds = retryAfter !== null ? Number(retryAfter) : COOLDOWN_MS / 1000;
        const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : COOLDOWN_MS / 1000;
        cooldownSecondsLeft = Math.max(1, Math.ceil(safeSeconds));
        uiState = "cooldown";
        return;
      }
      uiState = "error";
    } catch {
      uiState = "error";
    }
  }

  const disabled = $derived(uiState === "pending" || uiState === "cooldown" || uiState === "done");

  const cooldownTooltipId = "refresh-cooldown-tip";
</script>

<button
  type="button"
  class="refresh-now"
  class:refresh-now--pending={uiState === "pending"}
  class:refresh-now--cooldown={uiState === "cooldown"}
  class:refresh-now--done={uiState === "done"}
  aria-label={m.polling_refresh_now_aria()}
  aria-busy={uiState === "pending"}
  aria-describedby={uiState === "cooldown" ? cooldownTooltipId : undefined}
  {disabled}
  onclick={handleClick}
>
  <span class="refresh-now__icon" class:refresh-now__icon--spinning={uiState === "pending"}>
    ↻
  </span>
  {#if uiState === "cooldown"}
    <span class="refresh-now__count">{cooldownSecondsLeft}s</span>
    <span id={cooldownTooltipId} class="sr-only">
      Cooldown — wait {cooldownSecondsLeft} seconds
    </span>
  {:else if uiState === "pending"}
    <span class="sr-only">{m.polling_refresh_now_pending()}</span>
  {:else if uiState === "done"}
    <span class="sr-only">{m.polling_refresh_now_done()}</span>
  {/if}
</button>
{#if uiState === "error"}
  <small class="refresh-now-error" role="alert">{m.polling_refresh_now_error()}</small>
{/if}

<style>
  /* v2 RefreshNowButton — preserves Phase 03.0 plan 11 5-min cooldown
   * gate + prefers-reduced-motion rotation animation handling. Visual
   * treatment migrates to v2 tokens. */
  .refresh-now {
    min-width: 3rem;
    height: 2rem;
    padding: var(--s-1) var(--s-2);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    cursor: pointer;
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    line-height: 1;
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .refresh-now:hover:not(:disabled) {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent-strong);
  }
  .refresh-now:disabled {
    cursor: not-allowed;
  }
  .refresh-now--cooldown {
    opacity: 0.6;
  }
  .refresh-now--done {
    opacity: 0.7;
  }
  .refresh-now__icon {
    display: inline-block;
    font-size: 1.05rem;
    line-height: 1;
  }
  .refresh-now__count {
    font-size: var(--t-12);
    opacity: 0.85;
    font-variant-numeric: tabular-nums;
  }

  /* prefers-reduced-motion gate — PRESERVED (Phase 03.0 plan 11 contract).
   * @media (prefers-reduced-motion: no-preference) is the default-on
   * variant: animation runs ONLY when the user hasn't requested reduced
   * motion. Pair with the transition-disable block below for full
   * accessibility coverage. */
  @media (prefers-reduced-motion: no-preference) {
    .refresh-now__icon--spinning {
      animation: refresh-spin 1.4s linear infinite;
    }
    @keyframes refresh-spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .refresh-now {
      transition: none;
    }
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .refresh-now-error {
    color: var(--danger);
    display: block;
    margin-top: var(--s-1);
    font-family: var(--f-sans);
    font-size: var(--t-12);
  }
</style>
