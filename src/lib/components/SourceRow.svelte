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

  // Plan 02.1-25 (UAT-NOTES.md §2.1-redesign): kind icon + TEXT label
  // rendered together so users can scan the source list and see "YouTube
  // channel" / "Reddit account" / etc. at a glance. User quote: "И еще
  // писать тип и иконку типа". The 5 source_kind_label_* keys already
  // existed in messages/en.json (Plan 02.1-08); this plan adds the
  // visible inline rendering.
  function kindLabel(k: SourceKind): string {
    switch (k) {
      case "youtube_channel":
        return m.source_kind_label_youtube_channel();
      case "reddit_account":
        return m.source_kind_label_reddit_account();
      case "twitter_account":
        return m.source_kind_label_twitter_account();
      case "telegram_channel":
        return m.source_kind_label_telegram_channel();
      case "discord_server":
        return m.source_kind_label_discord_server();
    }
  }

  let editing = $state(false);
  // Hold the rename buffer in plain state — when the edit form opens we
  // re-seed it from the current source row in `openEdit()`. Initialising
  // directly from `source.displayName` here captures only the initial prop
  // value, so a parent passing a fresh source after rename would render
  // stale text in the input on next open.
  let editName = $state("");
  // Plan 02.1-22 (UAT-NOTES.md §2.4-decision option A): auto_import editing
  // moved out of the always-visible row UI into the edit form. Local buffer
  // mirrors `source.autoImport` and is re-seeded each time the edit form
  // opens (mirrors editName seeding). Sent in the PATCH /api/sources/:id
  // payload alongside displayName when the user saves.
  let editAutoImport = $state(false);
  let confirmingRemove = $state(false);
  let mutating = $state(false);
  let rowError = $state<string | null>(null);

  // Plan 02.1-22 (UAT-NOTES.md §2.4-decision option A): the standalone
  // auto-import toggle handler was DELETED — the previous one-click toggle
  // in row-display mode was too easy to mis-tap and there was no audit
  // discoverability before the round-3 UAT. The toggle now lives inside the
  // edit form and ships in the same PATCH as a display-name change.

  async function saveSourceEdit(e: Event): Promise<void> {
    e.preventDefault();
    if (mutating) return;
    mutating = true;
    rowError = null;
    try {
      const res = await fetch(`/api/sources/${source.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        // Plan 02.1-22: PATCH body now sends BOTH displayName AND autoImport.
        // The /api/sources/:id route already accepts both fields in the same
        // payload (Plan 02.1-06) — no service or zod schema change needed.
        body: JSON.stringify({
          displayName: editName.trim() || null,
          autoImport: editAutoImport,
        }),
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

<div class="row" class:mine={source.isOwnedByMe}>
  <div class="primary">
    <!-- Plan 02.1-25 (UAT-NOTES.md §2.1-redesign): kind icon + text label
         rendered together so the source list is scannable. Mirrors the
         FeedCard overlay-kind pattern from Plan 02.1-23 but adapted to
         SourceRow's row-display surface. -->
    <span class="kind-tag">
      <SourceKindIcon kind={source.kind} />
      {kindLabel(source.kind)}
    </span>
    {#if editing}
      <form class="rename" onsubmit={saveSourceEdit}>
        <input
          class="input"
          type="text"
          bind:value={editName}
          maxlength="120"
          aria-label="Display name"
        />
        <!-- Plan 02.1-22 (§2.4-decision option A): the auto_import toggle
             lives inside the edit form so it can't be mis-tapped from the
             row-display surface. Saved alongside displayName in one PATCH. -->
        <label class="toggle">
          <input type="checkbox" bind:checked={editAutoImport} />
          <span>Auto-import</span>
        </label>
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
    <!-- Plan 02.1-22 (§2.4-decision option A): non-interactive pill replaces
         the inline checkbox. The toggle moved into the edit form so a misclick
         can't flip auto-import without going through the same PATCH path that
         renames also use. -->
    <span class="auto-pill">
      {source.autoImport ? m.sources_auto_import_on() : m.sources_auto_import_off()}
    </span>
  </div>

  <div class="actions">
    <button
      type="button"
      class="icon-btn"
      aria-label={m.common_edit()}
      onclick={() => {
        if (!editing) {
          editName = source.displayName ?? "";
          // Plan 02.1-22: re-seed editAutoImport from the live row each
          // time the edit form opens so a stale toggle from a previous
          // open doesn't mask the current persisted value.
          editAutoImport = source.autoImport;
        }
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
  /* Plan 02.1-25 (UAT-NOTES.md §2.1-redesign): mirror FeedCard's Mine
     treatment from Plan 02.1-23. User quote: "Тут нужно как в feed
     сделать для mine". The 4px accent left-border + the upgraded
     overlay-style "Mine" pill combine for the same C+A treatment users
     get on FeedCard. */
  .row.mine {
    border-left: 4px solid var(--color-accent);
  }
  .primary {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;
    min-width: 0;
  }
  /* Plan 02.1-25: kind icon+text bundle. Visually pairs with the
     SourceKindIcon (currentColor inherits from this span). */
  .kind-tag {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    color: var(--color-text);
    font-weight: var(--font-weight-semibold);
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
  /* Plan 02.1-25 (UAT-NOTES.md §2.1-redesign): upgrade the Mine pill to the
     overlay-mine visual style used by FeedCard (Plan 02.1-23). Accent
     background + white text reads as a strong, consistent "this is yours"
     signal across feed and sources. */
  .ownership-badge.mine {
    background: var(--color-accent);
    color: var(--color-accent-text, #fff);
    border-color: var(--color-accent);
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
  /* Plan 02.1-22 (§2.4-decision option A): non-interactive auto-import pill
     in row-display mode. Visually similar to .ownership-badge but borrowed
     into the row-status surface. */
  .auto-pill {
    display: inline-flex;
    align-items: center;
    padding: 2px var(--space-sm);
    background: var(--color-bg);
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    font-size: var(--font-size-label);
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
