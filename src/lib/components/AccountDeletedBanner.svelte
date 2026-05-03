<script lang="ts">
  // AccountDeletedBanner — top-of-layout banner shown ONLY when the
  // authenticated user's `deletedAt` is non-null (Plan 02.2-04, D-15 / D-16).
  //
  // Rendering is gated by the parent layout (src/routes/+layout.svelte),
  // which checks `data.user?.deletedAt`. The banner itself is render-only;
  // it never decides on its own whether to show.
  //
  // Phase 2.2 PUTOFF: the "Permanently delete now" CTA listed in CONTEXT
  // D-16 is HIDDEN in this phase — the purge endpoint does not ship until
  // the Phase 3 purge worker. The user can either restore (the only active
  // CTA here) OR wait out the grace window and let the Phase 3 worker do
  // the hard delete. The PUTOFF marker carries the closing plan number.
  //
  // PUTOFF: re-introduce permanent-delete-now button when Phase 3 ships
  // the purge endpoint (POST /api/me/account/purge) — see CONTEXT D-15
  // "purged" line.

  import { invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";

  let {
    deletedAt,
    retentionDays,
  }: {
    deletedAt: Date | string;
    retentionDays: number;
  } = $props();

  let pending = $state(false);

  // daysLeft = max(0, retentionDays - daysSince(deletedAt)). Date math via
  // milliseconds — Date arithmetic is forgiving across timezones because the
  // JS Date is UTC under the hood and we floor-div to whole-day buckets.
  const daysLeft = $derived(
    Math.max(
      0,
      retentionDays -
        Math.floor((Date.now() - new Date(deletedAt).getTime()) / (24 * 60 * 60 * 1000)),
    ),
  );

  async function handleRestore(): Promise<void> {
    if (pending) return;
    pending = true;
    try {
      await fetch("/api/me/account/restore", { method: "POST" });
      // invalidateAll re-runs the +layout.server.ts load → user.deletedAt is
      // null after restoreAccount → the parent's {#if} hides this banner.
      await invalidateAll();
    } finally {
      pending = false;
    }
  }
</script>

<aside class="banner" role="alert" aria-live="polite">
  <div class="copy">
    <strong class="title">{m.account_deleted_banner_title()}</strong>
    <span class="meta">{m.account_deleted_banner_days_left({ days: daysLeft })}</span>
  </div>
  <div class="actions">
    <button type="button" class="restore" disabled={pending} onclick={handleRestore}>
      {m.account_deleted_banner_restore_button()}
    </button>
  </div>
</aside>

<style>
  .banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
    padding: var(--space-sm) var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border-bottom: 3px solid var(--color-destructive);
    font-size: var(--font-size-body);
    line-height: var(--line-height-body);
  }
  .copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .title {
    color: var(--color-destructive);
    font-weight: var(--font-weight-semibold);
  }
  .meta {
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
  }
  .actions {
    display: flex;
    gap: var(--space-sm);
    flex-shrink: 0;
  }
  .restore {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-accent);
    color: #fff;
    border: 1px solid var(--color-accent);
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .restore:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
