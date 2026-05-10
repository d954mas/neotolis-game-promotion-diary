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
  let cooldownSecondsLeft = $state(0);

  // 5-min cooldown — CONTEXT D-10. Matches the server-side cooldown enforced
  // by Plan 04's requestRefreshPoll service (which throws AppError 429
  // 'too_many_refreshes' with metadata.minutesLeft + retryAfterSeconds).
  const COOLDOWN_MS = 5 * 60 * 1000;
  const COOLDOWN_RECHECK_MS = 1_000;

  function readMetadataLastRefresh(): number | null {
    const meta = event.metadata;
    if (meta === null || typeof meta !== "object") return null;
    const v = (meta as { last_user_refresh_at?: unknown }).last_user_refresh_at;
    if (typeof v !== "string") return null;
    const ts = Date.parse(v);
    return Number.isFinite(ts) ? ts : null;
  }

  function computeCooldownSeconds(): number {
    const last = readMetadataLastRefresh();
    if (last === null) return 0;
    const elapsed = Date.now() - last;
    if (elapsed >= COOLDOWN_MS) return 0;
    return Math.ceil((COOLDOWN_MS - elapsed) / 1000);
  }

  // Initial cooldown evaluation + per-second interval re-evaluation so
  // the visible countdown ticks down smoothly. $effect cleanup clears
  // the interval on unmount so we don't leak timers.
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
  .refresh-now {
    min-width: 3rem;
    height: 2rem;
    padding: 0 var(--space-sm);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    background: transparent;
    border: 1px solid var(--color-border, #ccc);
    border-radius: 4px;
    cursor: pointer;
    color: var(--color-text-muted);
    font-size: 0.85rem;
    line-height: 1;
  }
  .refresh-now:hover:not(:disabled) {
    color: var(--color-text);
    border-color: var(--color-text);
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
    font-size: 0.75rem;
    opacity: 0.85;
    font-variant-numeric: tabular-nums;
  }

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
