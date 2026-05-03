<script lang="ts">
  // /settings/account — Export + Delete UI for D-15 / D-16 (account
  // portability + soft-delete with grace window). Plan 02.2-04 surface
  // for the endpoints landed by Plan 02.2-03.
  //
  // Endpoints consumed (all tenant-scoped via /api/me/*):
  //   - GET    /api/me/export             → JSON Article-20 export envelope.
  //   - DELETE /api/me/account            → soft-delete user + cascade.
  //   - POST   /api/me/account/restore    → reverse soft-delete within grace.
  //
  // The Delete button uses the Phase 2.1 ConfirmDialog with the Plan
  // 02.2-04 requireText="DELETE" variant — the user must literally type
  // "DELETE" before the confirm button activates (D-S3, industry-standard
  // pattern; layered with the 60-day grace for two layers of mistake
  // protection).

  import { goto } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import InlineError from "$lib/components/InlineError.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let exportInProgress = $state(false);
  let exportError = $state<string | null>(null);

  let confirmDeleteOpen = $state(false);
  let deleteInProgress = $state(false);
  let deleteError = $state<string | null>(null);

  async function handleExport(): Promise<void> {
    if (exportInProgress) return;
    exportInProgress = true;
    exportError = null;
    try {
      const res = await fetch("/api/me/export", { method: "GET" });
      if (!res.ok) throw new Error(`export_failed_${res.status}`);
      const blob = await res.blob();
      const today = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `diary-export-${today}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke after the click handler — the download should have started by
      // the time the microtask runs.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      exportError = m.settings_account_export_failed();
    } finally {
      exportInProgress = false;
    }
  }

  async function handleDeleteConfirm(): Promise<void> {
    if (deleteInProgress) return;
    deleteInProgress = true;
    deleteError = null;
    try {
      const res = await fetch("/api/me/account", { method: "DELETE" });
      if (!res.ok) throw new Error(`delete_failed_${res.status}`);
      // Better Auth signs the user out as part of softDeleteAccount (per Plan
      // 02.2-03); a fresh GET of any protected route would 401 → /login. We
      // navigate explicitly so the user lands on a stable target without an
      // intermediate redirect ping.
      confirmDeleteOpen = false;
      await goto("/login", { invalidateAll: true });
    } catch {
      deleteError = m.settings_account_delete_failed();
      deleteInProgress = false;
    }
  }

  // Restore CTA lives in <AccountDeletedBanner> mounted by src/routes/+layout.svelte
  // — it surfaces on every auth-gated page when deletedAt is set. Inlining a
  // second restore button on /settings/account would render two CTAs side-by-side.

  const isDeleted = $derived(data.user?.deletedAt != null);
</script>

<section class="account">
  <h1>{m.settings_account_title()}</h1>

  <article class="block">
    <h2>{m.settings_account_section_export_title()}</h2>
    <p class="muted">{m.settings_account_section_export_blurb()}</p>
    <div class="actions">
      <button type="button" class="export" onclick={handleExport} disabled={exportInProgress}>
        {exportInProgress
          ? m.settings_account_export_in_progress()
          : m.settings_account_export_button()}
      </button>
    </div>
    {#if exportError}
      <InlineError message={exportError} />
    {/if}
  </article>

  {#if !isDeleted}
    <article class="block danger">
      <h2>{m.settings_account_section_danger_title()}</h2>
      <p class="muted">
        {m.settings_account_grace_explainer({ days: data.retentionDays })}
      </p>
      <div class="actions">
        <button
          type="button"
          class="delete"
          onclick={() => (confirmDeleteOpen = true)}
          disabled={deleteInProgress}
        >
          {m.settings_account_delete_button()}
        </button>
      </div>
      {#if deleteError}
        <InlineError message={deleteError} />
      {/if}
    </article>
  {/if}
</section>

<ConfirmDialog
  open={confirmDeleteOpen}
  message={m.settings_account_delete_confirm_body({ days: data.retentionDays })}
  confirmLabel={m.settings_account_delete_button()}
  requireText="DELETE"
  onConfirm={handleDeleteConfirm}
  onCancel={() => (confirmDeleteOpen = false)}
/>

<style>
  .account {
    display: flex;
    flex-direction: column;
    gap: var(--space-xl);
    min-width: 0;
  }
  h1 {
    margin: 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
  }
  .block {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    padding: var(--space-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
  }
  .block.danger {
    border-color: var(--color-destructive);
  }
  .block h2 {
    margin: 0;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
  }
  .muted {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    line-height: var(--line-height-body);
  }
  .actions {
    display: flex;
    gap: var(--space-sm);
    flex-wrap: wrap;
    margin-top: var(--space-sm);
  }
  .export,
  .delete {
    min-height: 44px;
    padding: 0 var(--space-md);
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .export {
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }
  .export:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .delete {
    background: var(--color-surface);
    color: var(--color-destructive);
    border: 1px solid var(--color-destructive);
  }
  .delete:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
