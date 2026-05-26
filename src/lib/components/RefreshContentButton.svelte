<script lang="ts">
  // RefreshContentButton — "Pull new content" button on /sources/[id]
  // that POSTs to /api/sources/:id/refresh-content. The route dispatches
  // via getAdapter(source.kind).backfillSource — for YouTube this
  // enqueues a youtube.backfill.channel job (singletonKey-deduped ~5min).
  // Adding a new source kind requires zero edits to this component.
  //
  // CONTRACT (matches the route's wire format):
  //   - 202 → { enqueued: true, queue: 'youtube.backfill.channel', jobId: <string|null> }
  //   - 401 → never seen here (the page loader gates anonymous access; if
  //           the cookie expires mid-session the layout-level handler picks
  //           it up and routes the user to /login).
  //   - 404 → row deleted / cross-tenant — the page itself would 404 first.
  //   - 422 → 'kind_not_yet_functional' (unsupported kind in the registry).
  //   - 5xx → operator-side problem, surface via a generic error toast.
  //
  // UI states:
  //   - idle       → button enabled, label = m.sources_detail_pull_new_content().
  //   - pending    → button disabled, label = m.sources_detail_pull_new_content_pending();
  //                  client-side fetch is in flight.
  //   - cooldown   → button disabled, label = m.sources_detail_pull_new_content_cooldown({seconds}).
  //                  5min UI cooldown started after a successful 202;
  //                  mirrors the singletonKey window so the user doesn't
  //                  re-click into a no-op.
  //
  // Toast surfaces below the button (success or error). Calls invalidateAll()
  // on 202 so the parent loader re-runs and any new events the backfill
  // produces show up on the page (lastErrorAt clears, etc.).

  import { m } from "$lib/paraglide/messages.js";
  import { invalidateAll } from "$app/navigation";

  // sourceKind is threaded so future per-kind copy (e.g. "Pull new
  // Reddit posts") can land without a prop-shape change. Currently
  // unused — the underscore prefix matches the existing project
  // convention for intentionally-unused destructured props.
  //
  // compact mode: icon-only button for inline placement (e.g., /sources
  // row). Default mode = full text label for the detail page where the
  // affordance is the primary action.
  //
  // initialCooldownSec — server-rendered cooldown state. The /sources
  // loader queries audit_log for the most-recent refresh-content INTENT
  // row per source within the 5-minute singletonKey window; the row
  // passes the remaining seconds here so the UI cooldown survives page
  // reload.
  let {
    sourceId,
    sourceKind: _sourceKind,
    compact = false,
    initialCooldownSec = 0,
    pulling = false,
  }: {
    sourceId: string;
    sourceKind: string;
    compact?: boolean;
    initialCooldownSec?: number;
    pulling?: boolean;
  } = $props();

  const COOLDOWN_SEC = 300; // 5min UI cooldown to mirror singletonKey window

  let pending = $state(false);
  let cooldownSec = $state(initialCooldownSec);

  // Resume cooldown ticker on mount when initial state is set.
  $effect(() => {
    if (initialCooldownSec > 0 && cooldownTimer === null) {
      startCooldown(initialCooldownSec);
    }
  });
  let toast = $state<{ kind: "ok" | "err"; text: string } | null>(null);

  // Cleanup the cooldown interval on unmount so we don't leak timers.
  let cooldownTimer: ReturnType<typeof setInterval> | null = null;
  $effect(() => () => {
    if (cooldownTimer !== null) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
  });

  function startCooldown(seconds: number = COOLDOWN_SEC): void {
    cooldownSec = seconds;
    if (cooldownTimer !== null) clearInterval(cooldownTimer);
    cooldownTimer = setInterval(() => {
      cooldownSec = Math.max(0, cooldownSec - 1);
      if (cooldownSec === 0 && cooldownTimer !== null) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
      }
    }, 1000);
  }

  async function onClick(): Promise<void> {
    if (pending || cooldownSec > 0) return;
    pending = true;
    toast = null;
    try {
      const res = await fetch(`/api/sources/${sourceId}/refresh-content`, {
        method: "POST",
        credentials: "include",
      });
      if (res.status === 202) {
        // No «Refresh started» success toast. The spinning ↻ icon +
        // live-refresh loop are the visual signal the pull is in
        // flight; a redundant text toast just adds noise.
        startCooldown();
        await invalidateAll();
      } else if (res.status === 422) {
        toast = { kind: "err", text: m.sources_detail_pull_new_content_unsupported() };
      } else if (res.status === 429) {
        // Distinct error codes for per-axis quota exhaustion. Banner UI
        // shows full quota state; toast gives quick feedback.
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error === "platform_quota_exhausted") {
            toast = { kind: "err", text: m.sources_detail_pull_platform_quota_exhausted() };
          } else if (body.error === "requests_quota_exhausted") {
            toast = { kind: "err", text: m.sources_detail_pull_requests_quota_exhausted() };
          } else if (body.error === "events_quota_exhausted") {
            toast = { kind: "err", text: m.sources_detail_pull_events_quota_exhausted() };
          } else {
            // rate_limited (10/min) or unknown 429 — generic message.
            toast = { kind: "err", text: m.sources_detail_pull_rate_limited() };
          }
        } catch {
          toast = { kind: "err", text: m.sources_detail_pull_rate_limited() };
        }
      } else {
        toast = { kind: "err", text: m.sources_detail_pull_new_content_error() };
      }
    } catch {
      toast = { kind: "err", text: m.sources_detail_pull_new_content_error() };
    } finally {
      pending = false;
    }
  }

  const disabled = $derived(pending || cooldownSec > 0);
</script>

<div class="refresh-content">
  <button
    type="button"
    class="refresh-content__button"
    class:refresh-content__button--compact={compact}
    aria-busy={pending}
    aria-label={compact ? m.sources_detail_pull_new_content() : undefined}
    title={compact ? m.sources_detail_pull_new_content() : undefined}
    {disabled}
    onclick={onClick}
  >
    {#if compact}
      <!-- Compact mode = the "Sync" button on /sources row: ghost-style,
           icon + "Sync" label (matches docs/design/v2/ui-kit/sources-page
           .jsx .btn.ghost.source-sync-btn). Spinning ONLY while worker is
           actively pulling (pgboss job state in active/created/retry) OR
           while the client-side fetch is pending. Cooldown without active
           pull = static icon + countdown. -->
      <svg
        class="refresh-content__svg"
        class:refresh-content__svg--spinning={pending || pulling}
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M3 12a9 9 0 0 1 15-6.7L21 7" />
        <path d="M21 3v4h-4" />
        <path d="M21 12a9 9 0 0 1-15 6.7L3 17" />
        <path d="M3 21v-4h4" />
      </svg>
      {#if cooldownSec > 0 && !pending}
        <span class="refresh-content__compact-count">{cooldownSec}</span>
      {:else}
        <span class="refresh-content__compact-label">Sync</span>
      {/if}
    {:else if pending}
      {m.sources_detail_pull_new_content_pending()}
    {:else if cooldownSec > 0}
      {m.sources_detail_pull_new_content_cooldown({ seconds: String(cooldownSec) })}
    {:else}
      {m.sources_detail_pull_new_content()}
    {/if}
  </button>
  {#if toast && !compact}
    <!-- Toast hidden in compact mode (icon-only inline placement) so the
         text doesn't push surrounding row layout. Errors still surface
         in the full-button mode on /sources/[id] detail page. -->
    <p
      class="refresh-content__toast"
      class:refresh-content__toast--ok={toast.kind === "ok"}
      class:refresh-content__toast--err={toast.kind === "err"}
      role={toast.kind === "err" ? "alert" : "status"}
    >
      {toast.text}
    </p>
  {/if}
</div>

<style>
  /* v2 RefreshContentButton — D-01 redraw via button-on-source-row
   * pattern. Preserves Phase 03.0.1 plan 10 POST /api/sources/:id
   * /refresh-content trigger. */
  .refresh-content {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }
  /* Compact mode — used in SourceRow as the "Sync" button. Ghost style
   * (transparent + border) matching the prototype's
   * `.btn.ghost.source-sync-btn`: 32px tall, icon + "Sync" label.
   *
   * Selector chains both classes so this wins the cascade over the base
   * `.refresh-content__button` block below (which is filled-accent for
   * the /sources/[id] detail page). */
  .refresh-content__button.refresh-content__button--compact {
    height: 32px;
    min-height: 32px;
    padding: 0 12px;
    gap: 6px;
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-md);
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    border-radius: var(--r-sm);
  }
  .refresh-content__button.refresh-content__button--compact:hover:not(:disabled) {
    background: var(--surface-2);
    border-color: var(--border-2);
    color: var(--text);
  }
  .refresh-content__button.refresh-content__button--compact:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .refresh-content__svg {
    transition: transform var(--m-base) var(--m-ease);
  }
  .refresh-content__button.refresh-content__button--compact:hover:not(:disabled)
    .refresh-content__svg {
    transform: rotate(-90deg);
  }
  .refresh-content__svg--spinning {
    animation: refresh-spin 1.4s linear infinite;
  }
  .refresh-content__compact-count {
    font-family: var(--f-mono);
    font-size: var(--t-12);
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }
  .refresh-content__compact-label {
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-md);
  }
  @keyframes refresh-spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .refresh-content__svg--spinning {
      animation: none;
    }
    .refresh-content__button.refresh-content__button--compact:hover:not(:disabled)
      .refresh-content__svg {
      transform: none;
    }
  }
  @media (max-width: 480px) {
    .refresh-content__button.refresh-content__button--compact {
      padding: 0;
      width: 32px;
      justify-content: center;
    }
    .refresh-content__compact-label {
      display: none;
    }
  }
  .refresh-content__button {
    padding: var(--s-2) var(--s-4);
    background: var(--accent);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    cursor: pointer;
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .refresh-content__button:hover:not(:disabled) {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .refresh-content__button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .refresh-content__toast {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-13);
  }
  .refresh-content__toast--ok {
    color: var(--text-3);
  }
  .refresh-content__toast--err {
    color: var(--danger);
  }
  @media (prefers-reduced-motion: reduce) {
    .refresh-content__button {
      transition: none;
    }
  }
</style>
