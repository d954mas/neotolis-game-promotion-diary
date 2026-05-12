<script lang="ts">
  // AccountDeletedBanner — top-of-layout banner shown ONLY when the
  // authenticated user's `deletedAt` is non-null.
  //
  // Rendering is gated by the parent layout (src/routes/+layout.svelte),
  // which checks `data.user?.deletedAt`. The banner itself is render-only;
  // it never decides on its own whether to show.
  //
  // The "Permanently delete now" CTA is intentionally NOT on this banner.
  // The banner stays simple — just a Restore button. Immediate-purge UI
  // lives in /settings under an "Advanced" disclosure to reduce the
  // footgun risk of a destructive button living next to Restore on every
  // page.

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
  let restoreError = $state<string | null>(null);

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
    restoreError = null;
    try {
      const res = await fetch("/api/me/account/restore", { method: "POST" });
      if (res.status === 410) {
        // Grace window expired (account.ts:127 throws AppError 410). Hard-purge
        // is now in flight or imminent — the user cannot restore.
        restoreError = m.account_deleted_banner_restore_expired();
        return;
      }
      if (!res.ok) {
        restoreError = m.account_deleted_banner_restore_failed();
        return;
      }
      // invalidateAll re-runs the +layout.server.ts load → user.deletedAt is
      // null after restoreAccount → the parent's {#if} hides this banner.
      await invalidateAll();
    } catch {
      restoreError = m.account_deleted_banner_restore_failed();
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
  {#if restoreError}
    <p class="error" role="status">{restoreError}</p>
  {/if}
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
    flex-wrap: wrap;
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
  .error {
    flex: 1 1 100%;
    margin: 0;
    padding: var(--space-xs) 0 0 0;
    color: var(--color-destructive);
    font-size: var(--font-size-label);
  }
</style>
