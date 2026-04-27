<script lang="ts">
  // /settings — theme + account + retention info (Plan 02-10).
  //
  // Three sections per UI-SPEC §"/settings":
  //   - Theme:      <ThemeToggle current={data.theme}> (write side already
  //                 lands via POST /api/me/theme; toggle handles its own
  //                 optimistic update + revert).
  //   - Account:    read-only email + name + sign-out + sign-out-all-devices
  //                 (the latter gated by <ConfirmDialog>).
  //   - Retention:  read-only badge with the env.RETENTION_DAYS value passed
  //                 through the layout (NOT read from the Node env in this
  //                 page — see +page.server.ts comment).

  import { goto } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import ThemeToggle from "$lib/components/ThemeToggle.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import { signOut } from "$lib/auth-client";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let confirmSignOutAllOpen = $state(false);

  async function handleSignOut(): Promise<void> {
    await signOut();
    await goto("/", { invalidateAll: true });
  }

  async function handleSignOutAllConfirm(): Promise<void> {
    confirmSignOutAllOpen = false;
    await fetch("/api/me/sessions/all", { method: "POST" });
    await goto("/", { invalidateAll: true });
  }
</script>

<section class="settings">
  <h1>Settings</h1>

  <article class="block">
    <h2>Theme</h2>
    <p class="muted">Choose how the app looks. System follows your OS setting.</p>
    <div class="theme-row">
      <ThemeToggle current={data.theme} />
      <span class="muted">Current: {data.theme}</span>
    </div>
  </article>

  <article class="block">
    <h2>Account</h2>
    {#if data.user}
      <dl class="account">
        <dt>Name</dt>
        <dd>{data.user.name}</dd>
        <dt>Email</dt>
        <dd>{data.user.email}</dd>
      </dl>
    {/if}
    <div class="actions">
      <button type="button" class="signout" onclick={handleSignOut}>
        {m.sign_out()}
      </button>
      <button type="button" class="signout-all" onclick={() => (confirmSignOutAllOpen = true)}>
        {m.sign_out_all_devices()}
      </button>
    </div>
  </article>

  <article class="block">
    <h2>Data retention</h2>
    <p class="muted">
      Soft-deleted items are kept for {data.retentionDays} days before permanent purge.
    </p>
    <span class="badge">Retention: {data.retentionDays} days</span>
  </article>
</section>

<ConfirmDialog
  open={confirmSignOutAllOpen}
  message={m.confirm_signout_all()}
  confirmLabel={m.sign_out_all_devices()}
  onConfirm={handleSignOutAllConfirm}
  onCancel={() => (confirmSignOutAllOpen = false)}
/>

<style>
  .settings {
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
  .theme-row {
    display: flex;
    align-items: center;
    gap: var(--space-md);
    flex-wrap: wrap;
  }
  .account {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-xs) var(--space-md);
    margin: 0;
    font-size: var(--font-size-body);
  }
  .account dt {
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
  }
  .account dd {
    margin: 0;
    color: var(--color-text);
  }
  .actions {
    display: flex;
    gap: var(--space-sm);
    flex-wrap: wrap;
    margin-top: var(--space-sm);
  }
  .signout,
  .signout-all {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
    cursor: pointer;
  }
  .signout-all {
    color: var(--color-destructive);
    border-color: var(--color-destructive);
  }
  .badge {
    display: inline-block;
    width: fit-content;
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    padding: 2px var(--space-sm);
  }
</style>
