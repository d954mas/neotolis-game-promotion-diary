<script lang="ts">
  // /settings — theme + account + retention info + active sessions
  // (Phase 2.1 Plan 02.1-09 extension).
  //
  // UI-SPEC §"/settings (EXTENDED — sessions list + theme blurb)":
  //   - Theme (existing) + new sub-blurb (m.settings_theme_blurb()) +
  //     ThemeToggle (relocated from AppHeader; only here now)
  //   - Account (existing)
  //   - Data retention (existing)
  //   - Active sessions (NEW — uses <SessionsList>)
  //
  // The Phase 2 single-shot sign-out + sign-out-all-devices wiring carries
  // forward; the new section adds per-session DELETE.

  import { goto } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import ThemeToggle from "$lib/components/ThemeToggle.svelte";
  import SessionsList from "$lib/components/SessionsList.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import { signOut } from "$lib/auth-client";
  import type { PageData } from "./$types";

  type SessionDtoLocal = {
    id: string;
    expiresAt: Date | string;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: Date | string;
  };

  let { data }: { data: PageData } = $props();

  const sessions = $derived(data.sessions as SessionDtoLocal[]);
  const currentSessionId = $derived(data.currentSessionId as string);

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
    <h2>{m.settings_theme_heading()}</h2>
    <p class="muted">{m.settings_theme_blurb()}</p>
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

  <article class="block">
    <h2>{m.settings_sessions_heading()}</h2>
    <p class="muted">{m.settings_sessions_blurb()}</p>
    <SessionsList {sessions} {currentSessionId} />
  </article>

  <article class="block">
    <h2>Activity log</h2>
    <p class="muted">Audit trail of every action on your account.</p>
    <a href="/audit" class="audit-link">View audit log →</a>
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
  .audit-link {
    color: var(--color-accent);
    text-decoration: none;
    font-size: var(--font-size-body);
  }
  .audit-link:hover {
    text-decoration: underline;
  }
</style>
