<script lang="ts">
  // AccountDeletedBanner — top-of-layout banner shown ONLY when the
  // authenticated user's `deletedAt` is non-null (Plan 02.2-04, D-15 / D-16).
  //
  // Rendering is gated by the parent layout (src/routes/+layout.svelte),
  // which checks `data.user?.deletedAt`. The banner itself is render-only;
  // it never decides on its own whether to show.
  //
  // Phase 03.0-12 (DV-6 activation): the "Permanently delete now" CTA that
  // shipped HIDDEN in Phase 02.2-04 is now VISIBLE alongside the existing
  // Restore button. Click → ConfirmDialog (Type-DELETE + speedbump, Phase
  // 02.2 D-S3 pattern reused verbatim) → DELETE /api/me/account/purge →
  // signOut() + goto('/', {invalidateAll: true}) per UI-SPEC §"Interaction
  // Contracts → AccountDeletedBanner". The endpoint cascades session rows
  // out in the same tx, so any subsequent request with the pre-purge
  // cookie returns 401 — the explicit signOut() is belt-and-suspenders for
  // Better Auth's client-side state.

  import { goto, invalidateAll } from "$app/navigation";
  import { signOut } from "$lib/auth-client";
  import { m } from "$lib/paraglide/messages.js";
  import ConfirmDialog from "./ConfirmDialog.svelte";

  let {
    deletedAt,
    retentionDays,
  }: {
    deletedAt: Date | string;
    retentionDays: number;
  } = $props();

  let pending = $state(false);
  let restoreError = $state<string | null>(null);

  // Phase 03.0-12 — Permanent-delete-now CTA state. Mirrors the restore-
  // pending / restore-error pattern above so the banner has a consistent
  // shape for both buttons.
  let purgeConfirmOpen = $state(false);
  let purgePending = $state(false);
  let purgeError = $state<string | null>(null);

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

  function openPurgeConfirm(): void {
    if (purgePending) return;
    purgeError = null;
    purgeConfirmOpen = true;
  }

  function cancelPurgeConfirm(): void {
    purgeConfirmOpen = false;
  }

  async function handlePurgeConfirm(): Promise<void> {
    if (purgePending) return;
    purgePending = true;
    purgeError = null;
    purgeConfirmOpen = false;
    try {
      const res = await fetch("/api/me/account/purge", { method: "DELETE" });
      if (!res.ok) {
        purgeError = m.account_deleted_banner_permanent_delete_failed();
        return;
      }
      // 200 response: client-side signOut() (clears Better Auth session
      // state) + redirect to / via goto with invalidateAll: true so the
      // root loader re-runs against the now-purged session (which 401s
      // server-side; the layout treats anonymous as the public landing).
      await signOut();
      await goto("/", { invalidateAll: true });
    } catch {
      purgeError = m.account_deleted_banner_permanent_delete_failed();
    } finally {
      purgePending = false;
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
    <button
      type="button"
      class="purge-cta"
      disabled={purgePending}
      onclick={openPurgeConfirm}
    >
      {purgePending
        ? m.account_deleted_banner_permanent_delete_pending()
        : m.account_deleted_banner_permanent_delete_button()}
    </button>
  </div>
  {#if restoreError}
    <p class="error" role="status">{restoreError}</p>
  {/if}
  {#if purgeError}
    <p class="error" role="status">{purgeError}</p>
  {/if}
</aside>

<ConfirmDialog
  open={purgeConfirmOpen}
  message={m.account_deleted_banner_permanent_delete_confirm()}
  confirmLabel={m.account_deleted_banner_permanent_delete_button()}
  isIrreversible={true}
  requireText="DELETE"
  onConfirm={handlePurgeConfirm}
  onCancel={cancelPurgeConfirm}
/>

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
  /* Phase 03.0-12 — Permanent-delete-now CTA. Destructive fill matches the
     ConfirmDialog confirm button (var(--color-destructive)) — UI-SPEC
     §Color → Destructive new surfaces. 44px min height matches the existing
     Restore CTA so both buttons share the row visually. */
  .purge-cta {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-destructive);
    color: #fff;
    border: 1px solid var(--color-destructive);
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .purge-cta:disabled {
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
