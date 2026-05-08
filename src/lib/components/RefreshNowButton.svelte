<script lang="ts">
  // RefreshNowButton — Phase 3.0 Plan 11. Icon-only inline button rendered
  // inside <PollingBadge> for events where (last_polled_at IS NOT NULL) OR
  // tier=Frozen per CONTEXT D-10.
  //
  // UI-SPEC §"Interaction Contracts → RefreshNowButton interaction":
  //   - Idle: refresh icon at --color-text-muted; 44×44 hit area; 16×16 glyph.
  //   - Click → POST /api/events/{id}/refresh-poll (no body).
  //   - Pending: spinning rotation 360°/1s, aria-busy="true", aria-live="polite"
  //     announces m.polling_refresh_now_pending().
  //   - On 200/202: 2s "Polled just now" state, then invalidateAll() to refresh
  //     server-loaded data so the parent <PollingBadge> reads the new
  //     last_polled_at.
  //   - On 429: cooldown-disabled state. Reads Retry-After header (Plan 08
  //     contract) OR falls back to event.metadata.last_user_refresh_at + 5min
  //     to derive minutesLeft for the tooltip.
  //   - On 5xx / network: inline error below the badge via m.polling_refresh_now_error().
  //
  // Cooldown source of truth:
  //   - Initial state derived from event.metadata.last_user_refresh_at.
  //   - setInterval(30s) re-evaluates while mounted; cleared on unmount.
  //   - 5min cooldown from CONTEXT D-10.
  //
  // Accessibility (UI-SPEC §"Accessibility floor delta"):
  //   - aria-label on the icon-only button.
  //   - aria-busy="true" during pending state.
  //   - Cooldown tooltip via aria-describedby pointing at a sr-only span.
  //   - Spinning rotation gated on @media (prefers-reduced-motion: no-preference).

  import { m } from "$lib/paraglide/messages.js";
  import { invalidateAll } from "$app/navigation";

  type EventForRefresh = {
    id: string;
    metadata: Record<string, unknown> | null;
  };

  let { event }: { event: EventForRefresh } = $props();

  type UiState = "idle" | "pending" | "cooldown" | "done" | "error";
  let uiState = $state<UiState>("idle");
  let cooldownMinutesLeft = $state(0);

  // 5-min cooldown — CONTEXT D-10. Matches the server-side cooldown enforced
  // by Plan 04's requestRefreshPoll service (which throws AppError 429
  // 'too_many_refreshes' with metadata.minutesLeft + retryAfterSeconds).
  const COOLDOWN_MS = 5 * 60 * 1000;
  const COOLDOWN_RECHECK_MS = 30_000;

  function readMetadataLastRefresh(): number | null {
    const meta = event.metadata;
    if (meta === null || typeof meta !== "object") return null;
    const v = (meta as { last_user_refresh_at?: unknown }).last_user_refresh_at;
    if (typeof v !== "string") return null;
    const ts = Date.parse(v);
    return Number.isFinite(ts) ? ts : null;
  }

  function computeCooldownMinutes(): number {
    const last = readMetadataLastRefresh();
    if (last === null) return 0;
    const elapsed = Date.now() - last;
    if (elapsed >= COOLDOWN_MS) return 0;
    return Math.ceil((COOLDOWN_MS - elapsed) / 60_000);
  }

  // Initial cooldown evaluation + 30s interval re-evaluation. The $effect
  // cleanup clears the interval on unmount so we don't leak timers when the
  // parent <PollingBadge> rerenders or the FeedCard scrolls out of view.
  $effect(() => {
    cooldownMinutesLeft = computeCooldownMinutes();
    if (cooldownMinutesLeft > 0 && uiState !== "pending" && uiState !== "done") {
      uiState = "cooldown";
    }
    const timer = setInterval(() => {
      cooldownMinutesLeft = computeCooldownMinutes();
      if (cooldownMinutesLeft === 0 && uiState === "cooldown") {
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
        uiState = "done";
        // 2s "Polled just now" → invalidateAll() so the parent loader re-runs
        // and the badge picks up the fresh server-side last_polled_at.
        setTimeout(() => {
          uiState = "idle";
          void invalidateAll();
        }, 2000);
        return;
      }
      if (resp.status === 429) {
        // Plan 08 sets Retry-After in seconds from err.metadata.retryAfterSeconds.
        const retryAfter = resp.headers.get("Retry-After");
        const seconds = retryAfter !== null ? Number(retryAfter) : COOLDOWN_MS / 1000;
        const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : COOLDOWN_MS / 1000;
        cooldownMinutesLeft = Math.max(1, Math.ceil(safeSeconds / 60));
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
  <svg
    class="refresh-now__icon"
    viewBox="0 0 24 24"
    width="16"
    height="16"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    fill="none"
    aria-hidden="true"
  >
    <!-- Circular-arrow refresh glyph per UI-SPEC §"Inline-SVG icon additions" -->
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
  {#if uiState === "cooldown"}
    <span id={cooldownTooltipId} class="sr-only">
      {m.polling_refresh_now_cooldown_tooltip({ minutesLeft: cooldownMinutesLeft })}
    </span>
  {/if}
  {#if uiState === "pending"}
    <span class="sr-only">{m.polling_refresh_now_pending()}</span>
  {/if}
  {#if uiState === "done"}
    <span class="sr-only">{m.polling_refresh_now_done()}</span>
  {/if}
</button>
{#if uiState === "error"}
  <small class="refresh-now-error" role="alert">{m.polling_refresh_now_error()}</small>
{/if}

<style>
  .refresh-now {
    width: 44px;
    height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--color-text-muted);
    padding: 0;
  }
  .refresh-now:hover:not(:disabled) {
    color: var(--color-text);
  }
  .refresh-now:disabled {
    cursor: not-allowed;
  }
  .refresh-now--cooldown,
  .refresh-now--done {
    opacity: 0.5;
  }
  .refresh-now__icon {
    width: 16px;
    height: 16px;
  }

  /* Spinning animation honors @media (prefers-reduced-motion).
     UI-SPEC §"Accessibility floor delta": collapse to a static aria-busy
     state when the user has prefers-reduced-motion: reduce. */
  @media (prefers-reduced-motion: no-preference) {
    .refresh-now--pending .refresh-now__icon {
      animation: refresh-spin 1s linear infinite;
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
    color: var(--color-destructive);
    display: block;
    margin-top: var(--space-xs);
    font-size: var(--font-size-label);
  }
</style>
