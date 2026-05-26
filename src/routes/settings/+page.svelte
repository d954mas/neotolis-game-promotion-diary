<script lang="ts">
  // /settings — theme + account + retention info + active sessions.
  //
  // Sections:
  //   - Theme (existing) + sub-blurb (m.settings_theme_blurb()) +
  //     ThemeToggle (relocated from AppHeader; only here now)
  //   - Account (existing)
  //   - Data retention (existing)
  //   - Active sessions (uses <SessionsList>)
  //
  // The single-shot sign-out + sign-out-all-devices wiring carries forward;
  // the sessions section adds per-session DELETE.

  import { goto } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import ThemeToggle from "$lib/components/ThemeToggle.svelte";
  import SessionsList from "$lib/components/SessionsList.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import InlineError from "$lib/components/InlineError.svelte";
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
  let signOutAllError = $state<string | null>(null);

  // Account-management state (merged from former /settings/account route).
  let exportInProgress = $state(false);
  let exportError = $state<string | null>(null);
  let confirmDeleteOpen = $state(false);
  let deleteInProgress = $state(false);
  let deleteError = $state<string | null>(null);
  const isDeleted = $derived(data.user?.deletedAt != null);

  // Immediate-purge UI lives here, not in the AccountDeletedBanner. Banner
  // stays minimal (Restore only) so the destructive action isn't a
  // one-click reach on every page.
  let purgeConfirmOpen = $state(false);
  let purgeInProgress = $state(false);
  let purgeError = $state<string | null>(null);

  async function handlePurgeConfirm(): Promise<void> {
    if (purgeInProgress) return;
    purgeInProgress = true;
    purgeError = null;
    purgeConfirmOpen = false;
    try {
      const res = await fetch("/api/me/account/purge", { method: "DELETE" });
      if (!res.ok) {
        purgeError = m.account_deleted_banner_permanent_delete_failed();
        return;
      }
      await signOut();
      await goto("/", { invalidateAll: true });
    } catch {
      purgeError = m.account_deleted_banner_permanent_delete_failed();
    } finally {
      purgeInProgress = false;
    }
  }

  async function handleSignOut(): Promise<void> {
    await signOut();
    await goto("/", { invalidateAll: true });
  }

  async function handleSignOutAllConfirm(): Promise<void> {
    confirmSignOutAllOpen = false;
    signOutAllError = null;
    try {
      const res = await fetch("/api/me/sessions/all", { method: "POST" });
      if (!res.ok) {
        signOutAllError = m.sign_out_all_failed();
        return;
      }
      await goto("/", { invalidateAll: true });
    } catch {
      signOutAllError = m.sign_out_all_failed();
    }
  }

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
      confirmDeleteOpen = false;
      await goto("/login", { invalidateAll: true });
    } catch {
      deleteError = m.settings_account_delete_failed();
      deleteInProgress = false;
    }
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
    {#if signOutAllError}
      <InlineError message={signOutAllError} />
    {/if}

    <div class="sub-section">
      <h3>{m.settings_account_section_export_title()}</h3>
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
    </div>

    {#if !isDeleted}
      <div class="sub-section danger-zone">
        <h3>{m.settings_account_section_danger_title()}</h3>
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
      </div>
    {:else}
      <div class="sub-section danger-zone">
        <h3>{m.settings_account_section_purge_now_title()}</h3>
        <p class="muted">{m.settings_account_section_purge_now_blurb()}</p>
        <div class="actions">
          <button
            type="button"
            class="delete"
            onclick={() => (purgeConfirmOpen = true)}
            disabled={purgeInProgress}
          >
            {m.account_deleted_banner_permanent_delete_button()}
          </button>
        </div>
        {#if purgeError}
          <InlineError message={purgeError} />
        {/if}
      </div>
    {/if}
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
    <h2>{m.settings_credentials_heading()}</h2>
    <!-- /keys/steam was previously unreachable from any nav. This is the
         minimal fix — a single link from /settings. The unified
         /settings/credentials hub is DEFERRED (it pairs with the YouTube +
         Reddit key flows which are not yet wired). The `_credentials_`
         prefix on the Paraglide keys means the later rebuild is a
         search-and-restructure, not a from-scratch rewrite. -->
    <p class="muted">Manage API keys for external services.</p>
    <a href="/keys/steam" class="audit-link">
      {m.settings_credentials_steam_link_label()} →
    </a>
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

<ConfirmDialog
  open={confirmDeleteOpen}
  message={m.settings_account_delete_confirm_body({ days: data.retentionDays })}
  confirmLabel={m.settings_account_delete_button()}
  requireText="DELETE"
  onConfirm={handleDeleteConfirm}
  onCancel={() => (confirmDeleteOpen = false)}
/>

<ConfirmDialog
  open={purgeConfirmOpen}
  message={m.account_deleted_banner_permanent_delete_confirm()}
  confirmLabel={m.account_deleted_banner_permanent_delete_button()}
  isIrreversible={true}
  requireText="DELETE"
  onConfirm={handlePurgeConfirm}
  onCancel={() => (purgeConfirmOpen = false)}
/>

<style>
  /* Bounded reading width so the .block cards do not sprawl across a
   * 1280px viewport — settings is single-column content, no reason to
   * fill the full layout column. Matches /sources/[id] + /sources/new
   * detail surfaces (720-960px tier). */
  .settings {
    display: flex;
    flex-direction: column;
    gap: var(--s-6);
    max-width: 960px;
    min-width: 0;
  }
  h1 {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    line-height: var(--lh-tight);
    letter-spacing: -0.01em;
    color: var(--text);
  }
  .block {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    padding: var(--s-4);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
  }
  .block h2 {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-15);
    font-weight: var(--w-sb);
    color: var(--text);
  }
  .muted {
    margin: 0;
    color: var(--text-3);
    font-size: var(--t-13);
    line-height: var(--lh-body);
  }
  .theme-row {
    display: flex;
    align-items: center;
    gap: var(--s-4);
    flex-wrap: wrap;
  }
  .account {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--s-1) var(--s-4);
    margin: 0;
    font-size: var(--t-14);
  }
  .account dt {
    color: var(--text-3);
    font-size: var(--t-13);
  }
  .account dd {
    margin: 0;
    color: var(--text);
  }
  .actions {
    display: flex;
    gap: var(--s-2);
    flex-wrap: wrap;
    margin-top: var(--s-2);
  }
  .signout,
  .signout-all {
    min-height: var(--hit);
    padding: 0 var(--s-4);
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .signout:hover {
    background: var(--accent-soft);
  }
  /* "Sign out from all devices" — same neutral ghost as regular
   * sign-out (P2-8: danger styling drew too much visual weight for a
   * rarely-used action). ConfirmDialog still gates the destructive
   * action; the button itself doesn't need to scream. */
  .signout-all:hover {
    background: var(--accent-soft);
  }
  .sub-section {
    margin-top: var(--s-4);
    padding-top: var(--s-4);
    border-top: 1px solid var(--border-hairline);
  }
  .sub-section h3 {
    margin: 0 0 var(--s-1);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    font-weight: var(--w-sb);
    color: var(--text);
  }
  .sub-section.danger-zone h3 {
    color: var(--danger);
  }
  .export,
  .delete {
    min-height: var(--hit);
    padding: 0 var(--s-4);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    font-weight: var(--w-sb);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .export {
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--border);
  }
  .export:hover:not(:disabled) {
    background: var(--accent-soft);
    border-color: var(--accent-strong);
  }
  .export:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .delete {
    background: transparent;
    color: var(--danger);
    border: 1px solid var(--danger);
  }
  .delete:hover:not(:disabled) {
    background: var(--danger);
    color: #fff;
  }
  .delete:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  /* removed: .block.danger no longer used (Delete is now a sub-section) */
  .badge {
    display: inline-block;
    width: fit-content;
    font-size: var(--t-12);
    color: var(--text-3);
    background: var(--surface-3);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    padding: 2px var(--s-2);
  }
  .audit-link {
    color: var(--accent);
    text-decoration: none;
    font-size: var(--t-14);
  }
  .audit-link:hover {
    color: var(--accent-strong);
    text-decoration: underline;
  }
  @media (prefers-reduced-motion: reduce) {
    .signout,
    .signout-all,
    .export,
    .delete {
      transition: none;
    }
  }
</style>
