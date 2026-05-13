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
  }: { source: DataSourceDto; cooldownSec?: number; pulling?: boolean } = $props();

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
      <!-- displayName is not surfaced — the canonical channel title is
           the identifier. Existing rows keep their displayName column
           data for legacy compat but nothing renders it. -->
      <a class="display" href="/sources/{source.id}">
        {source.channelTitle ?? source.handleUrl}
      </a>
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
  /* Mirror FeedCard's Mine treatment. The 4px mine-token left-border +
     the upgraded overlay-style "Mine" pill combine for the same C+A
     treatment users get on FeedCard. var(--color-mine) is the shared
     token (defaults to accent; can diverge). */
  .row.mine {
    border-left: 4px solid var(--color-mine);
  }
  .primary {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;
    min-width: 0;
  }
  /* Kind icon+text bundle. Visually pairs with the SourceKindIcon
     (currentColor inherits from this span). */
  .kind-tag {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    color: var(--color-text);
    font-weight: var(--font-weight-semibold);
  }
  /* Label font-size reduced so the kind tag reads as subordinate
     metadata next to the .display name (which keeps the body 16px
     size). The labels are also single-word forms in messages/en.json.
     FiltersSheet.source-kind-label carries the same font-size reduction
     for visual consistency. */
  .kind-tag-label {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .display {
    color: var(--color-text);
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    word-break: break-word;
    min-width: 0;
    text-decoration: none;
  }
  .display:hover {
    text-decoration: underline;
  }
  /* Real YouTube channel title shown alongside the user's own
   * displayName, in the muted secondary tone. Same visual idea as
   * FeedCard's channel chip — surfaces the cache row from
   * youtube_channels so /sources is honest about what each tracking
   * record points at. */
  .channel-title {
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    padding: 2px var(--space-sm);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    white-space: nowrap;
  }
  /* Edit-form is its own row in the .row column flex with a fields
     stack on top and a footer action row at the bottom. */
  .edit-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    width: 100%;
    min-width: 0;
  }
  .input {
    min-height: 36px;
    padding: 0 var(--space-sm);
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
    width: 100%;
    min-width: 0;
  }
  .checkbox-row {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    color: var(--color-text);
    font-size: var(--font-size-body);
    cursor: pointer;
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
  /* Mine pill uses the overlay-mine visual style. Accent background +
     white text reads as a strong, consistent "this is yours" signal
     across feed and sources. Pill background + border resolve via
     var(--color-mine) — same shared token as the .row.mine
     border-left. The accent-text foreground stays on
     --color-accent-text because it is a paired text-on-accent token
     (Mine pill is white-on-accent by visual contract). */
  .ownership-badge.mine {
    background: var(--color-mine);
    color: var(--color-accent-text, #fff);
    border-color: var(--color-mine);
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
  .description {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
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
  .last-polled,
  .event-range {
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
  }
  /* Non-interactive auto-import pill in row-display mode. Visually
     similar to .ownership-badge but borrowed into the row-status
     surface. */
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
  /* Section divider visually separates form fields from the action row
     that follows. Border-top on a zero-height <hr> keeps the stacking
     simple while honoring the "fields above, actions below" read
     order. */
  .section-divider {
    width: 100%;
    margin: 0;
    border: 0;
    border-top: 1px solid var(--color-border);
  }
  /* Edit-form footer. Save / Cancel / Remove sit at the BOTTOM of the
     form block, full-width and reachable at 360px without horizontal
     scroll. Save is the primary action (--color-accent fill), Cancel is
     the ghost variant (transparent + border), Remove is the danger
     variant (--color-destructive border and label color). */
  .form-footer {
    display: flex;
    gap: var(--space-xs);
    flex-wrap: wrap;
    margin-top: 0;
  }
  .footer-btn {
    min-height: 44px;
    padding: 0 var(--space-md);
    border-radius: 4px;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-label);
    flex: 1 1 auto;
  }
  .footer-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .footer-btn-primary {
    background: var(--color-accent);
    color: var(--color-accent-text, #fff);
    border-color: var(--color-accent);
  }
  .footer-btn-ghost {
    background: transparent;
    color: var(--color-text);
    border-color: var(--color-border);
  }
  .footer-btn-danger {
    background: transparent;
    color: var(--color-destructive);
    border-color: var(--color-border);
  }
  .footer-btn-danger:hover {
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
    .edit-form {
      /* Edit form takes a full row when active so the field stack +
         section divider + footer all line up correctly. */
      flex-basis: 100%;
      order: 50;
    }
  }
</style>
