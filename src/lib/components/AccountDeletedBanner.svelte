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
  /* v2 AccountDeletedBanner — --surface-2 panel with --danger bottom edge
   * signaling destructive context. Permanent-delete-now CTA lives in
   * /settings (per existing component contract); this banner stays simple
   * with the Restore affordance only. */
  .banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
    padding: var(--s-3) var(--s-4);
    background: var(--surface-2);
    color: var(--text);
    border-bottom: 3px solid var(--danger);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    line-height: var(--lh-body);
  }
  .copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .title {
    color: var(--danger);
    font-weight: var(--w-sb);
    font-size: var(--t-15);
  }
  .meta {
    color: var(--text-2);
    font-size: var(--t-13);
  }
  .actions {
    display: flex;
    gap: var(--s-2);
    flex-wrap: wrap;
    flex-shrink: 0;
  }
  .restore {
    min-height: var(--hit);
    padding: var(--s-2) var(--s-4);
    background: var(--accent);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .restore:hover:not(:disabled) {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .restore:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .error {
    flex: 1 1 100%;
    margin: 0;
    padding: var(--s-1) 0 0 0;
    color: var(--danger);
    font-size: var(--t-13);
  }
  @media (prefers-reduced-motion: reduce) {
    .restore {
      transition: none;
    }
  }
</style>
