<script lang="ts">
  // RefreshContentButton — Phase 03.0.1 Plan 10. The user-facing payoff of
  // the Wave 0-8 source-plugin refactor: a "Pull new content" button on
  // /sources/[id] that POSTs to /api/sources/:id/refresh-content. The
  // route dispatches via getAdapter(source.kind).backfillSource — for
  // YouTube this enqueues a youtube.backfill.user job (singletonKey-deduped
  // ~5min). Phase 03.1 lights this up for Reddit by writing the Reddit
  // adapter's backfillSource; this component requires zero edits.
  //
  // CONTRACT (matches the route's wire format):
  //   - 202 → { enqueued: true, queue: 'youtube.backfill.user', jobId: <string|null> }
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

  // sourceKind is threaded so future per-kind copy (e.g. "Pull new Reddit
  // posts") can land without a prop-shape change. Currently unused — the
  // underscore prefix matches the existing project convention for
  // intentionally-unused destructured props.
  let { sourceId, sourceKind: _sourceKind }: { sourceId: string; sourceKind: string } = $props();

  const COOLDOWN_SEC = 300; // 5min UI cooldown to mirror singletonKey window

  let pending = $state(false);
  let cooldownSec = $state(0);
  let toast = $state<{ kind: "ok" | "err"; text: string } | null>(null);

  // Cleanup the cooldown interval on unmount so we don't leak timers.
  let cooldownTimer: ReturnType<typeof setInterval> | null = null;
  $effect(() => () => {
    if (cooldownTimer !== null) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
  });

  function startCooldown(): void {
    cooldownSec = COOLDOWN_SEC;
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
        toast = { kind: "ok", text: m.sources_detail_pull_new_content_success() };
        startCooldown();
        await invalidateAll();
      } else if (res.status === 422) {
        toast = { kind: "err", text: m.sources_detail_pull_new_content_unsupported() };
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
    aria-busy={pending}
    {disabled}
    onclick={onClick}
  >
    {#if pending}
      {m.sources_detail_pull_new_content_pending()}
    {:else if cooldownSec > 0}
      {m.sources_detail_pull_new_content_cooldown({ seconds: String(cooldownSec) })}
    {:else}
      {m.sources_detail_pull_new_content()}
    {/if}
  </button>
  {#if toast}
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
  .refresh-content {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }
  .refresh-content__button {
    padding: var(--space-sm) var(--space-md);
    background: var(--color-accent);
    color: var(--color-on-accent, white);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    cursor: pointer;
    font-size: var(--font-size-body);
    font-weight: 500;
  }
  .refresh-content__button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  .refresh-content__button:hover:not(:disabled) {
    filter: brightness(1.05);
  }
  .refresh-content__toast {
    margin: 0;
    font-size: var(--font-size-label);
  }
  .refresh-content__toast--ok {
    color: var(--color-text-muted);
  }
  .refresh-content__toast--err {
    color: var(--color-destructive);
  }
</style>
