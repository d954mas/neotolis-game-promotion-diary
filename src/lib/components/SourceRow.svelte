<script lang="ts">
  // SourceRow — one row in the /sources list (Phase 2.1, replaces the
  // retired Phase 2 per-platform channel row). Kind-aware: SourceKindIcon + display_name +
  // Mine/Tracking badge + handle URL + polling status (CONTEXT D-12 — no
  // YouTube API key warning in 2.1; the only signal is "Phase 3 will start
  // polling") + auto_import toggle + edit + remove (44×44 hit areas).
  //
  // Edit affordance opens an inline form to rename `display_name` only;
  // auto_import is toggled directly on the row (PATCH /api/sources/:id).
  // Remove opens <ConfirmDialog> using m.confirm_source_remove({display_name})
  // and DELETEs /api/sources/:id (60-day soft-delete window — restore lives
  // on the /sources page below the active list).
  //
  // PollingBadge text is rendered INLINE here (not via a shared <PollingBadge>
  // component) — Plan 02.1-07 owns the FeedRow PollingBadge and ships its
  // own component file; SourceRow only needs the two-state status text and
  // does not benefit from the role="status" announce wrapper that FeedRow
  // wants for inbox/polling state changes inside the chronological pool.

  import { invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import SourceKindIcon from "./SourceKindIcon.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import InlineError from "./InlineError.svelte";

  type SourceKind =
    | "youtube_channel"
    | "reddit_account"
    | "twitter_account"
    | "telegram_channel"
    | "discord_server";

  type DataSourceDto = {
    id: string;
    kind: SourceKind;
    handleUrl: string;
    displayName: string | null;
    isOwnedByMe: boolean;
    autoImport: boolean;
    deletedAt: Date | string | null;
  };

  let { source }: { source: DataSourceDto } = $props();

  let editing = $state(false);
  // Hold the rename buffer in plain state — when the edit form opens we
  // re-seed it from the current source row in `openEdit()`. Initialising
  // directly from `source.displayName` here captures only the initial prop
  // value, so a parent passing a fresh source after rename would render
  // stale text in the input on next open.
  let editName = $state("");
  let confirmingRemove = $state(false);
  let mutating = $state(false);
  let rowError = $state<string | null>(null);

  async function toggleAutoImport(next: boolean): Promise<void> {
    if (mutating) return;
    mutating = true;
    rowError = null;
    try {
      const res = await fetch(`/api/sources/${source.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoImport: next }),
      });
      if (!res.ok) {
        rowError = m.error_server_generic();
        return;
      }
      await invalidateAll();
    } catch {
      rowError = m.error_network();
    } finally {
      mutating = false;
    }
  }

  async function saveDisplayName(e: Event): Promise<void> {
    e.preventDefault();
    if (mutating) return;
    mutating = true;
    rowError = null;
    try {
      const res = await fetch(`/api/sources/${source.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: editName.trim() || null }),
      });
      if (!res.ok) {
        rowError = m.error_server_generic();
        return;
      }
      editing = false;
      await invalidateAll();
    } catch {
      rowError = m.error_network();
    } finally {
      mutating = false;
    }
  }

  async function confirmRemove(): Promise<void> {
    confirmingRemove = false;
    mutating = true;
    rowError = null;
    try {
      const res = await fetch(`/api/sources/${source.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 200 && res.status !== 204) {
        rowError = m.error_server_generic();
        return;
      }
      await invalidateAll();
    } catch {
      rowError = m.error_network();
    } finally {
      mutating = false;
    }
  }
</script>

<div class="row">
  <div class="primary">
    <SourceKindIcon kind={source.kind} />
    {#if editing}
      <form class="rename" onsubmit={saveDisplayName}>
        <input
          class="input"
          type="text"
          bind:value={editName}
          maxlength="120"
          aria-label="Display name"
        />
        <button type="submit" class="rename-save" disabled={mutating}>
          {m.toast_saved()}
        </button>
        <button type="button" class="rename-cancel" onclick={() => (editing = false)}>
          {m.common_cancel()}
        </button>
      </form>
    {:else}
      <span class="display">{source.displayName ?? source.handleUrl}</span>
    {/if}
    <span class="ownership-badge" class:mine={source.isOwnedByMe}>
      {source.isOwnedByMe ? m.sources_owned_by_me() : m.sources_owned_by_other()}
    </span>
  </div>

  <div class="meta">
    <code class="handle">{source.handleUrl}</code>
  </div>

  <div class="status">
    <span class="polling-status" role="status">
      {source.autoImport ? m.sources_status_auto_on_pending() : m.sources_status_auto_off()}
    </span>
    <label class="toggle">
      <input
        type="checkbox"
        checked={source.autoImport}
        disabled={mutating}
        onchange={(e) => toggleAutoImport((e.currentTarget as HTMLInputElement).checked)}
      />
      <span>Auto-import</span>
    </label>
  </div>

  <div class="actions">
    <button
      type="button"
      class="icon-btn"
      aria-label={m.common_edit()}
      onclick={() => {
        if (!editing) editName = source.displayName ?? "";
        editing = !editing;
      }}
    >
      {m.common_edit()}
    </button>
    <button
      type="button"
      class="icon-btn destructive"
      aria-label={m.common_remove()}
      onclick={() => (confirmingRemove = true)}
    >
      {m.common_remove()}
    </button>
  </div>

  {#if rowError}
    <InlineError message={rowError} />
  {/if}
</div>

<ConfirmDialog
  open={confirmingRemove}
  message={m.confirm_source_remove({ display_name: source.displayName ?? source.handleUrl })}
  confirmLabel={m.common_remove()}
  onConfirm={confirmRemove}
  onCancel={() => (confirmingRemove = false)}
/>

<style>
  .row {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    padding: var(--space-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    min-width: 0;
  }
  .primary {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;
    min-width: 0;
  }
  .display {
    color: var(--color-text);
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    word-break: break-word;
    min-width: 0;
  }
  .rename {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    flex-grow: 1;
    flex-wrap: wrap;
  }
  .input {
    min-height: 36px;
    padding: 0 var(--space-sm);
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
    flex-grow: 1;
    min-width: 0;
  }
  .rename-save,
  .rename-cancel {
    min-height: 36px;
    padding: 0 var(--space-sm);
    border-radius: 4px;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-label);
  }
  .rename-save {
    background: var(--color-accent);
    color: var(--color-accent-text);
    border-color: var(--color-accent);
  }
  .ownership-badge {
    display: inline-flex;
    align-items: center;
    padding: 2px var(--space-sm);
    background: var(--color-bg);
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    font-size: var(--font-size-label);
  }
  .ownership-badge.mine {
    color: var(--color-text);
    border-color: var(--color-text-muted);
  }
  .meta {
    min-width: 0;
  }
  .handle {
    font-family: var(--font-family-mono);
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    word-break: break-all;
  }
  .status {
    display: flex;
    align-items: center;
    gap: var(--space-md);
    flex-wrap: wrap;
  }
  .polling-status {
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    cursor: pointer;
  }
  .actions {
    display: flex;
    gap: var(--space-xs);
    flex-wrap: wrap;
  }
  .icon-btn {
    min-height: 44px;
    min-width: 44px;
    padding: 0 var(--space-sm);
    background: transparent;
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-label);
  }
  .icon-btn:hover {
    color: var(--color-text);
  }
  .icon-btn.destructive {
    color: var(--color-destructive);
    border-color: var(--color-border);
  }
  .icon-btn.destructive:hover {
    border-color: var(--color-destructive);
  }
  @media (min-width: 768px) {
    .row {
      flex-direction: row;
      align-items: center;
      flex-wrap: wrap;
    }
    .primary {
      flex-grow: 1;
    }
    .meta {
      flex-basis: 100%;
      order: 99;
    }
  }
</style>
