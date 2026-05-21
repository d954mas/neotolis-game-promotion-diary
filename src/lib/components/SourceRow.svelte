<script lang="ts">
  // SourceRow — one row in the /sources list. Kind-aware: SourceKindIcon
  // + display_name + Mine/Tracking badge + handle URL + polling status +
  // auto_import toggle + edit + remove (44×44 hit areas).
  //
  // Edit affordance opens an inline form to rename `display_name` and
  // toggle auto_import; both fields ship in one PATCH /api/sources/:id.
  // Remove opens <ConfirmDialog> using
  // m.confirm_source_remove({display_name}) and DELETEs /api/sources/:id
  // (60-day soft-delete window — restore lives on the /sources page).
  //
  // Edit-mode contract:
  //   - Read mode renders ONLY the Edit pencil in .actions; the
  //     destructive Remove button lives in the edit-form footer where
  //     /events parity keeps destructive actions confined to the edit
  //     surface.
  //   - Edit mode hides the read-mode Edit pencil entirely.
  //   - The edit form ends with a section divider followed by a
  //     3-button footer (Save primary / Cancel ghost / Remove danger) at
  //     the BOTTOM of the form block so users can find the action row
  //     without scanning the middle of the card.
  //   - auto_import is rendered as exactly ONE checkbox bound to
  //     editAutoImport.
  //
  // PollingBadge text is rendered INLINE here (not via a shared
  // <PollingBadge> component) — the FeedRow PollingBadge has its own
  // component file; SourceRow only needs the two-state status text and
  // does not benefit from the role="status" announce wrapper FeedRow
  // uses for inbox/polling state changes inside the chronological pool.

  import { invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import SourceKindIcon from "./SourceKindIcon.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import InlineError from "./InlineError.svelte";
  import RefreshContentButton from "./RefreshContentButton.svelte";
  import AuthorPopover from "./shared/AuthorPopover.svelte";
  // kindLabel is a shared helper so SourceRow and FiltersSheet's kind
  // glyph + label render resolve to the same wording.
  import { sourceKindLabel as kindLabel, type SourceKind } from "$lib/util/source-kind-label.js";

  type DataSourceDto = {
    id: string;
    kind: SourceKind;
    handleUrl: string;
    displayName: string | null;
    isOwnedByMe: boolean;
    autoImport: boolean;
    deletedAt: Date | string | null;
    // Real YouTube channel title from the youtube_channels cache. Shown
    // as a chip alongside the user's own displayName so /sources
    // displays both names.
    channelTitle?: string | null;
    // Backfill state surfaced inline so the user can see «when was this
    // last refreshed» without opening detail.
    lastPolledAt?: Date | string | null;
    backfillComplete?: boolean;
    firstEventAt?: Date | string | null;
    lastEventAt?: Date | string | null;
    eventCount?: number;
    metadata?: Record<string, unknown> | null;
  };

  let {
    source,
    cooldownSec = 0,
    pulling = false,
    currentUserName = "",
  }: {
    source: DataSourceDto;
    cooldownSec?: number;
    pulling?: boolean;
    /** Display name for the AuthorPopover "(you)" line. Optional — when
     *  omitted (no parent passes it) the popover falls back to the
     *  generic "You" label. */
    currentUserName?: string;
  } = $props();

  const descriptionText = $derived(
    typeof source.metadata?.description === "string" && source.metadata.description.trim()
      ? source.metadata.description
      : "",
  );

  // Relative-time formatter for the «Last pulled» display. Inline (no
  // luxon dep) — minimal English-only.
  function formatRelativeTime(when: Date | string): string {
    const t = typeof when === "string" ? new Date(when) : when;
    const diffMs = Date.now() - t.getTime();
    if (diffMs < 0) return "just now";
    const sec = Math.floor(diffMs / 1000);
    if (sec < 60) return "just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour}h ago`;
    const day = Math.floor(hour / 24);
    if (day < 30) return `${day}d ago`;
    const month = Math.floor(day / 30);
    return `${month}mo ago`;
  }

  // Human-readable date: "22 Feb 2026". en-GB puts day before month
  // (Russian / European convention; matches user's expectation).
  function formatDateShort(when: Date | string): string {
    const t = typeof when === "string" ? new Date(when) : when;
    return t.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" });
  }

  // ── Inline-affordance state (Wave 2 Plan 09 — coexists with editing
  //    edit-mode footer per D-08 mutual exclusion). The three new
  //    inline patterns ride ON TOP of the existing Phase 02.1-33
  //    edit-form footer; the gates below ensure renameMode and
  //    editing are NEVER both true.
  //
  //    1. handle click → renameMode → contenteditable rename →
  //       Enter/blur commits via PATCH /api/sources/:id (displayName)
  //    2. avatar click → authorPopoverOpen → AuthorPopover →
  //       PATCH /api/sources/:id (isOwnedByMe)
  //    3. status pill (Live/Paused) click → toggle "active" → PATCH
  //       /api/sources/:id. The backend schema accepts `autoImport`
  //       (NOT a top-level `active` column on data_sources — autoImport
  //       is the field that gates whether the polling worker pulls
  //       new content for this source, which is exactly what the
  //       Live/Paused pill represents). The prototype-side `source.active`
  //       maps to our `source.autoImport`. See SUMMARY.md "Deviations"
  //       for the rationale.
  let renameMode = $state(false);
  // Re-seeded from the current source row each time renameMode flips on
  // (matches the existing editName seeding pattern below); a bare
  // `$state(source.displayName ?? "")` initializer only captures the
  // initial prop value and would render stale text on next open.
  let renameDraft = $state("");
  let authorPopoverOpen = $state(false);
  let liveToggling = $state(false);

  async function commitRename(): Promise<void> {
    const next = renameDraft.trim();
    if (next === "" || next === (source.displayName ?? "")) {
      renameMode = false;
      return;
    }
    try {
      const res = await fetch(`/api/sources/${source.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: next }),
      });
      if (!res.ok) {
        rowError = m.error_server_generic();
      } else {
        await invalidateAll();
      }
    } catch {
      rowError = m.error_network();
    } finally {
      renameMode = false;
    }
  }

  function cancelRename(): void {
    renameMode = false;
    renameDraft = "";
  }

  // Toggle the "active" status (Live ↔ Paused). The status pill is the
  // user-facing label; the backend field is `autoImport` — same
  // semantic (is this source pulling new content?).
  async function toggleActive(): Promise<void> {
    if (liveToggling) return;
    liveToggling = true;
    rowError = null;
    const nextActive = !source.autoImport;
    try {
      const res = await fetch(`/api/sources/${source.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        // Prototype literal `active` mirrored as the semantically
        // equivalent `autoImport` field. Backend Zod schema accepts
        // autoImport on PATCH /api/sources/:id (Phase 02.1).
        body: JSON.stringify({ autoImport: nextActive }),
      });
      if (!res.ok) {
        rowError = m.error_server_generic();
      } else {
        await invalidateAll();
      }
    } catch {
      rowError = m.error_network();
    } finally {
      liveToggling = false;
    }
  }

  async function changeAuthor(isMe: boolean): Promise<void> {
    rowError = null;
    try {
      const res = await fetch(`/api/sources/${source.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isOwnedByMe: isMe }),
      });
      if (!res.ok) {
        rowError = m.error_server_generic();
      } else {
        await invalidateAll();
      }
    } catch {
      rowError = m.error_network();
    } finally {
      authorPopoverOpen = false;
    }
  }

  let editing = $state(false);
  // Hold the rename buffer in plain state — when the edit form opens we
  // re-seed it from the current source row in `openEdit()`. Initialising
  // directly from `source.displayName` here captures only the initial prop
  // value, so a parent passing a fresh source after rename would render
  // stale text in the input on next open.
  let editName = $state("");
  // auto_import editing lives inside the edit form. Local buffer mirrors
  // `source.autoImport` and is re-seeded each time the edit form opens
  // (mirrors editName seeding). Sent in the PATCH /api/sources/:id
  // payload alongside displayName when the user saves.
  let editAutoImport = $state(false);
  // is_owned_by_me is editable inline. Independent from auto_import —
  // auto-poll is available for tracking channels too, so no lock-step.
  let editIsOwnedByMe = $state(false);
  let confirmingRemove = $state(false);
  let mutating = $state(false);
  let rowError = $state<string | null>(null);

  // The standalone auto-import toggle handler was removed — a one-click
  // toggle in row-display mode was too easy to mis-tap. The toggle now
  // lives inside the edit form and ships in the same PATCH as a
  // display-name change.

  // Explicit open/cancel helpers re-seed the local buffers each time.
  // Splitting the open path from the cancel path makes the edit-mode
  // visibility gates read straightforwardly: the Edit pencil in read
  // mode invokes openEdit; the Cancel button in the edit-form footer
  // invokes cancelEdit.
  function _openEdit(): void {
    editName = source.displayName ?? "";
    editAutoImport = source.autoImport;
    editIsOwnedByMe = source.isOwnedByMe;
    editing = true;
  }

  function cancelEdit(): void {
    editing = false;
    editName = source.displayName ?? "";
    editAutoImport = source.autoImport;
    editIsOwnedByMe = source.isOwnedByMe;
  }

  async function saveSourceEdit(e: Event): Promise<void> {
    e.preventDefault();
    if (mutating) return;
    mutating = true;
    rowError = null;
    try {
      const res = await fetch(`/api/sources/${source.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        // PATCH body sends BOTH displayName AND autoImport. The
        // /api/sources/:id route accepts both fields in the same payload.
        body: JSON.stringify({
          displayName: editName.trim() || null,
          autoImport: editAutoImport,
          isOwnedByMe: editIsOwnedByMe,
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
    <!-- Kind icon + text label rendered together so the source list is
         scannable. Kind label wrapped in a span so its font-size can be
         reduced independently of the body baseline — kind is metadata,
         displayName is the primary identifier. Mirrors FiltersSheet's
         .source-kind-label treatment. -->
    <span class="kind-tag">
      <SourceKindIcon kind={source.kind} />
      <span class="kind-tag-label">{kindLabel(source.kind)}</span>
    </span>

    {#if !editing}
      <!-- Avatar — click opens AuthorPopover (D-11 — REUSE the same
           shared popover the FeedCard + EventDetailModal use, no
           re-implementation). Disabled while the edit-mode footer
           is open (D-08 mutual exclusion). -->
      <span class="author-pick">
        <button
          type="button"
          class="author-avatar"
          data-mine={source.isOwnedByMe ? "1" : "0"}
          onclick={() => (authorPopoverOpen = !authorPopoverOpen)}
          aria-haspopup="menu"
          aria-expanded={authorPopoverOpen}
          aria-label={source.isOwnedByMe
            ? m.author_avatar_mine_aria({ name: currentUserName || "you" })
            : m.author_avatar_unknown_aria()}
        >
          {source.isOwnedByMe ? (currentUserName[0] ?? "Y").toUpperCase() : "?"}
        </button>
        {#if authorPopoverOpen}
          <AuthorPopover
            authorIsMe={source.isOwnedByMe}
            mineName={currentUserName || "You"}
            onchange={changeAuthor}
            onclose={() => (authorPopoverOpen = false)}
          />
        {/if}
      </span>
    {/if}

    <!-- Handle text — click to rename (D-08: inline-edit ONLY when
         the existing Phase 02.1-33 edit-mode footer is NOT open).
         editing=true → renameMode is BLOCKED. renameMode=true → the
         pencil-to-edit-footer trigger is HIDDEN below. The canonical
         channel title remains the identifier; rename targets the
         user's displayName label, which the existing edit-form also
         binds to (same field, two affordances). -->
    {#if renameMode && !editing}
      <input
        class="handle-input"
        bind:value={renameDraft}
        onblur={commitRename}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commitRename();
          }
          if (e.key === "Escape") cancelRename();
        }}
        maxlength="120"
        aria-label="Rename source"
      />
    {:else if !editing}
      <button
        type="button"
        class="handle-text"
        onclick={() => {
          renameMode = true;
          renameDraft = source.displayName ?? source.channelTitle ?? source.handleUrl;
        }}
        title="Click to rename"
      >
        {source.channelTitle ?? source.handleUrl}
      </button>
    {:else}
      <!-- editing=true: footer rename is in flight; show the static
           name and keep inline rename mode disabled (D-08). -->
      <span class="handle-text handle-text-disabled">
        {source.channelTitle ?? source.handleUrl}
      </span>
    {/if}

    {#if !editing}
      <!-- Live/Paused status pill — click toggles "active" (backend
           field: autoImport). Standalone signal; sits beside the
           existing PollingBadge (preserved below) per D-09. -->
      <button
        type="button"
        class="status-pill"
        data-active={source.autoImport ? "1" : "0"}
        onclick={toggleActive}
        disabled={liveToggling}
        aria-pressed={source.autoImport}
        title={source.autoImport ? "Click to pause polling" : "Click to resume polling"}
      >
        {source.autoImport ? "Live" : "Paused"}
      </button>
    {/if}

    <span class="ownership-badge" class:mine={source.isOwnedByMe}>
      {source.isOwnedByMe ? m.sources_owned_by_me() : m.sources_owned_by_other()}
    </span>
  </div>

  <!-- handle URL is not surfaced in the row. Channel title is the
       identifier; the raw URL stays on the /sources/[id] detail header. -->

  {#if descriptionText}
    <div class="meta">
      <p class="description">{descriptionText}</p>
    </div>
  {/if}

  {#if !editing}
    <div class="status">
      <!-- Auto-import chip shown ONLY when ON. The presence of the chip
           itself is the signal. -->
      {#if source.autoImport}
        <span class="auto-pill">{m.source_chip_auto_import()}</span>
      {/if}
      <span class="last-polled" title="Last successful pull">
        {source.lastPolledAt
          ? `Last pulled: ${formatRelativeTime(source.lastPolledAt)}`
          : "Never pulled"}
      </span>
      {#if (source.eventCount ?? 0) > 0}
        <span class="event-range" title="Total events · earliest — latest event date">
          {source.eventCount}
          {source.eventCount === 1 ? "event" : "events"}{source.firstEventAt && source.lastEventAt
            ? ` · ${formatDateShort(source.firstEventAt)} — ${formatDateShort(source.lastEventAt)}`
            : ""}
        </span>
      {/if}
    </div>
  {/if}

  {#if !editing}
    <!-- Refresh-content inline. Row is read-only except for the refresh
         action; rename / toggle / delete live on /sources/[id]. -->
    <div class="actions">
      <RefreshContentButton
        sourceId={source.id}
        sourceKind={source.kind}
        compact
        initialCooldownSec={cooldownSec}
        {pulling}
      />
    </div>
  {:else}
    <form class="edit-form" onsubmit={saveSourceEdit}>
      <input
        class="input"
        type="text"
        bind:value={editName}
        maxlength="120"
        aria-label="Display name"
      />
      <!-- The auto_import toggle lives inside the edit form so it
           can't be mis-tapped from the row-display surface. Saved
           alongside displayName in one PATCH. Rendered as EXACTLY ONE
           checkbox; no parallel text-input control. -->
      <label class="checkbox-row">
        <input type="checkbox" bind:checked={editIsOwnedByMe} />
        <span>This is my own channel</span>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" bind:checked={editAutoImport} />
        <span>Auto-import</span>
      </label>

      <!-- Section divider above the form footer so the user reads
           top-to-bottom (fields → divider → action row). -->
      <hr class="section-divider" />

      <!-- form-footer hosts Save (primary) / Cancel (ghost) / Remove
           (danger) at the BOTTOM of the edit-form block. The Remove
           button's visibility gate is THIS branch — not the read-mode
           .actions row above. -->
      <div class="form-footer">
        <button type="submit" class="footer-btn footer-btn-primary" disabled={mutating}>
          {m.common_save()}
        </button>
        <button
          type="button"
          class="footer-btn footer-btn-ghost"
          onclick={cancelEdit}
          disabled={mutating}
        >
          {m.common_cancel()}
        </button>
        <button
          type="button"
          class="footer-btn footer-btn-danger remove-icon"
          aria-label={m.common_remove()}
          onclick={() => (confirmingRemove = true)}
          disabled={mutating}
        >
          {m.common_remove()}
        </button>
      </div>
    </form>
  {/if}

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
  /* v2 SourceRow — --surface-2 list-row + --r-md radius. Mine marker is a
   * 2px --accent left border (replaces 4px legacy color-mine token). Edit
   * pencil hidden in editing mode (Phase 02.1-33 contract); footer Save /
   * Cancel / Remove sit at the BOTTOM of the form below a section divider. */
  .row {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-4);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    min-width: 0;
  }
  /* Mine treatment — 2px --accent left border. */
  .row.mine {
    border-left: 2px solid var(--accent);
  }
  .primary {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
    min-width: 0;
  }
  /* Kind icon + text bundle. SourceKindIcon inherits currentColor from
   * this span. */
  .kind-tag {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    color: var(--text-3);
    font-family: var(--f-sans);
    font-weight: var(--w-md);
  }
  .kind-tag-label {
    font-size: var(--t-12);
    color: var(--text-3);
  }
  .display {
    color: var(--text);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    font-weight: var(--w-md);
    word-break: break-word;
    min-width: 0;
    text-decoration: none;
    transition: color var(--m-fast) var(--m-ease);
  }
  .display:hover {
    color: var(--accent);
    text-decoration: underline;
  }
  /* Inline-rename affordance — Wave 2 Plan 09. Click handle-text → button
   * morphs into an input; Enter/blur commits. D-08 mutual exclusion
   * keeps this hidden when the edit-mode footer is open. */
  .handle-text {
    background: transparent;
    border: none;
    padding: 0;
    color: var(--text);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    font-weight: var(--w-md);
    cursor: pointer;
    word-break: break-word;
    min-width: 0;
    text-align: left;
    transition: color var(--m-fast) var(--m-ease);
  }
  .handle-text:hover {
    color: var(--accent);
    text-decoration: underline dotted;
  }
  .handle-text-disabled {
    cursor: default;
    color: var(--text-3);
  }
  .handle-input {
    min-height: var(--hit);
    padding: var(--s-1) var(--s-2);
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--accent-strong);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    font-weight: var(--w-md);
    min-width: 0;
    flex: 1 1 auto;
  }
  /* AuthorPopover trigger — small 24×24 avatar; matches the
   * EventDetailContent + FeedCard treatment so the Mine/Other vocabulary
   * is consistent across surfaces. */
  .author-pick {
    position: relative;
    display: inline-flex;
  }
  .author-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    background: var(--surface-3);
    color: var(--text-3);
    border: 1px solid var(--border);
    border-radius: 50%;
    font-family: var(--f-sans);
    font-size: var(--t-12);
    font-weight: var(--w-sb);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .author-avatar[data-mine="1"] {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
  }
  .author-avatar:hover {
    border-color: var(--accent-strong);
  }
  /* Live/Paused status pill — small clickable chip. Live = accent wash
   * (same vocabulary as the existing .auto-pill); Paused = surface-3
   * with text-3. Sits on the same line as kind + handle so the user
   * can flip the source on/off without entering the edit-mode footer. */
  .status-pill {
    display: inline-flex;
    align-items: center;
    padding: var(--s-0) var(--s-2);
    background: var(--surface-3);
    color: var(--text-3);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    font-weight: var(--w-md);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .status-pill[data-active="1"] {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent-strong);
  }
  .status-pill:hover:not(:disabled) {
    border-color: var(--accent-strong);
  }
  .status-pill:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .channel-title {
    color: var(--text-3);
    font-size: var(--t-12);
    padding: var(--s-0) var(--s-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    white-space: nowrap;
  }
  .edit-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    width: 100%;
    min-width: 0;
  }
  .input {
    min-height: var(--hit);
    padding: var(--s-1) var(--s-3);
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    width: 100%;
    min-width: 0;
    transition: border-color var(--m-fast) var(--m-ease);
  }
  .input:hover {
    border-color: var(--accent-strong);
  }
  .checkbox-row {
    display: flex;
    align-items: center;
    gap: var(--s-1);
    color: var(--text);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    cursor: pointer;
  }
  .ownership-badge {
    display: inline-flex;
    align-items: center;
    padding: var(--s-0) var(--s-2);
    background: var(--surface-3);
    color: var(--text-3);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    font-family: var(--f-sans);
    font-size: var(--t-12);
  }
  /* Mine pill — --accent wash matches the row's Mine border-left. */
  .ownership-badge.mine {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
  }
  .meta {
    min-width: 0;
  }
  .handle {
    font-family: var(--f-mono);
    font-size: var(--t-12);
    color: var(--text-3);
    word-break: break-all;
  }
  .description {
    margin: 0;
    color: var(--text-2);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    line-height: var(--lh-body);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .status {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    flex-wrap: wrap;
  }
  .polling-status {
    color: var(--text-3);
    font-size: var(--t-12);
  }
  .last-polled,
  .event-range {
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-12);
  }
  /* Auto-import chip — accent-soft wash signals the auto-import is on. */
  .auto-pill {
    display: inline-flex;
    align-items: center;
    padding: var(--s-0) var(--s-2);
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid var(--accent-strong);
    border-radius: var(--r-pill);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    font-weight: var(--w-md);
  }
  .actions {
    display: flex;
    gap: var(--s-1);
    flex-wrap: wrap;
  }
  /* Phase 02.1-33: edit pencil hidden in edit mode. The icon-btn class
   * is the read-mode pencil affordance; editing toggles the row away
   * from the read surface so this rule is for the legacy icon-btn
   * (kept for future pencil reintroduction if the editing UX changes). */
  .icon-btn {
    min-height: var(--hit);
    min-width: var(--hit);
    padding: var(--s-1) var(--s-2);
    background: transparent;
    color: var(--text-3);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    cursor: pointer;
    font-family: var(--f-sans);
    font-size: var(--t-12);
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .icon-btn:hover {
    background: var(--accent-soft);
    color: var(--accent);
  }
  /* Section divider above the form footer — Phase 02.1-33 contract. */
  .section-divider {
    width: 100%;
    margin: var(--s-2) 0 0 0;
    border: 0;
    border-top: 1px solid var(--border-hairline);
  }
  /* Edit-form footer — Phase 02.1-33: Save (primary) / Cancel (ghost) /
   * Remove (danger) at the BOTTOM of the form block. */
  .form-footer {
    display: flex;
    gap: var(--s-2);
    flex-wrap: wrap;
    margin-top: 0;
  }
  .footer-btn {
    min-height: var(--hit);
    padding: var(--s-2) var(--s-4);
    border-radius: var(--r-sm);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    cursor: pointer;
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    flex: 1 1 auto;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .footer-btn:hover:not(:disabled) {
    background: var(--accent-soft);
    border-color: var(--accent-strong);
  }
  .footer-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .footer-btn-primary {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
  }
  .footer-btn-primary:hover:not(:disabled) {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .footer-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border);
  }
  .footer-btn-danger {
    background: transparent;
    color: var(--danger);
    border-color: var(--border);
  }
  .footer-btn-danger:hover {
    background: var(--danger);
    color: #fff;
    border-color: var(--danger);
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
    .edit-form {
      flex-basis: 100%;
      order: 50;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .display,
    .input,
    .icon-btn,
    .footer-btn {
      transition: none;
    }
  }
</style>
