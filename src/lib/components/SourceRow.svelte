<script lang="ts">
  // SourceRow — one row in the /sources list (Phase 2.1, replaces the
  // retired Phase 2 per-platform channel row). Kind-aware: SourceKindIcon + display_name +
  // Mine/Tracking badge + handle URL + polling status (CONTEXT D-12 — no
  // YouTube API key warning in 2.1; the only signal is "Phase 3 will start
  // polling") + auto_import toggle + edit + remove (44×44 hit areas).
  //
  // Edit affordance opens an inline form to rename `display_name` and toggle
  // auto_import; both fields ship in one PATCH /api/sources/:id (Plan 02.1-22
  // contract). Remove opens <ConfirmDialog> using
  // m.confirm_source_remove({display_name}) and DELETEs /api/sources/:id
  // (60-day soft-delete window — restore lives on the /sources page below
  // the active list).
  //
  // Plan 02.1-33 (UAT-NOTES.md §4.22.B + §4.22.C + §4.22.E): edit-mode
  // visibility-gates and footer placement.
  //   - Read mode renders ONLY the Edit pencil in .actions; the destructive
  //     Remove button moved into the edit-form footer where /events parity
  //     keeps destructive actions confined to the edit surface.
  //   - Edit mode hides the read-mode Edit pencil entirely (the user is
  //     already editing — a second pencil-to-enter-edit-mode would duplicate
  //     state).
  //   - The edit form ends with a section divider followed by a 3-button
  //     footer (Save primary / Cancel ghost / Remove danger) at the BOTTOM
  //     of the form block so users can find the action row without
  //     scanning the middle of the card. Closes user quote
  //     "Кнопки save cancel нужно внизу карточки делать, иначе не очевидно
  //     где они и зачем".
  //
  // Plan 02.1-33 (UAT-NOTES.md §4.22.D): auto_import is rendered as exactly
  // ONE checkbox bound to editAutoImport. Plan-time review found no
  // duplicate text input on this branch — the §4.22.D finding was stale —
  // but the negative-grep regression assertions in the audit-render
  // integration test and the responsive-360 browser describe block catch
  // any future reintroduction of a parallel text-input control.
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
  // Plan 02.1-39 (UAT-NOTES.md §5.6): kindLabel extracted to a shared
  // helper so SourceRow and FiltersSheet's new kind glyph + label render
  // resolve to the same wording. Single source of truth.
  import { sourceKindLabel as kindLabel, type SourceKind } from "$lib/util/source-kind-label.js";

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

  // Plan 02.1-33: explicit open/cancel helpers re-seed the local buffers
  // each time. Splitting the open path from the cancel path makes the
  // edit-mode visibility gates (§4.22.B / §4.22.C) read straightforwardly:
  // the Edit pencil in read mode invokes openEdit; the Cancel button in
  // the edit-form footer invokes cancelEdit.
  function openEdit(): void {
    editName = source.displayName ?? "";
    editAutoImport = source.autoImport;
    editing = true;
  }

  function cancelEdit(): void {
    editing = false;
    editName = source.displayName ?? "";
    editAutoImport = source.autoImport;
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
         SourceRow's row-display surface.
         Plan 02.1-39 round-6 polish #7 (UAT-NOTES.md §5.6 follow-up #7,
         2026-04-30): kind label wrapped in a span so its font-size can be
         reduced independently of the body baseline — kind is metadata,
         displayName is the primary identifier. Mirrors FiltersSheet's
         .source-kind-label treatment for visual consistency across the two
         surfaces that show the kind glyph + label pattern. -->
    <span class="kind-tag">
      <SourceKindIcon kind={source.kind} />
      <span class="kind-tag-label">{kindLabel(source.kind)}</span>
    </span>
    {#if !editing}
      <span class="display">{source.displayName ?? source.handleUrl}</span>
    {/if}
    <span class="ownership-badge" class:mine={source.isOwnedByMe}>
      {source.isOwnedByMe ? m.sources_owned_by_me() : m.sources_owned_by_other()}
    </span>
  </div>

  <div class="meta">
    <code class="handle">{source.handleUrl}</code>
  </div>

  {#if !editing}
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
  {/if}

  {#if !editing}
    <!-- Plan 02.1-33 (UAT-NOTES.md §4.22.B): read-mode .actions hosts ONLY
         the Edit pencil. Remove moved into the edit-form footer below — its
         visibility gate is the {#if editing} branch. -->
    <div class="actions">
      <button
        type="button"
        class="icon-btn edit-icon"
        aria-label={m.common_edit()}
        onclick={openEdit}
      >
        {m.common_edit()}
      </button>
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
      <!-- Plan 02.1-22 (§2.4-decision option A): the auto_import toggle
           lives inside the edit form so it can't be mis-tapped from the
           row-display surface. Saved alongside displayName in one PATCH.

           Plan 02.1-33 (UAT-NOTES.md §4.22.D — regression prevention):
           auto_import is rendered as EXACTLY ONE checkbox here. There is
           no parallel <input type="text"> control bound to editAutoImport
           anywhere in this component; the negative-grep assertions in the
           audit-render integration test enforce that contract. -->
      <label class="checkbox-row">
        <input type="checkbox" bind:checked={editAutoImport} />
        <span>Auto-import</span>
      </label>

      <!-- Plan 02.1-33 (UAT-NOTES.md §4.22.E): section divider above the
           form footer so the user reads top-to-bottom (fields → divider
           → action row). User quote: "Кнопки save cancel нужно внизу
           карточки делать, иначе не очевидно где они и зачем". -->
      <hr class="section-divider" />

      <!-- Plan 02.1-33 (UAT-NOTES.md §4.22.B + §4.22.C + §4.22.E):
           form-footer hosts Save (primary) / Cancel (ghost) / Remove
           (danger) at the BOTTOM of the edit-form block. The Remove
           button's visibility gate is THIS branch — not the read-mode
           .actions row above. The read-mode Edit pencil is intentionally
           NOT rendered here (no duplicate edit affordance once the user
           is already editing). -->
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
  /* Plan 02.1-25 (UAT-NOTES.md §2.1-redesign): mirror FeedCard's Mine
     treatment from Plan 02.1-23. User quote: "Тут нужно как в feed
     сделать для mine". The 4px accent left-border + the upgraded
     overlay-style "Mine" pill combine for the same C+A treatment users
     get on FeedCard.
     Plan 02.1-30 (UAT-NOTES.md §4.25.A): swap var(--color-accent) for
     var(--color-mine) so FeedCard.mine + SourceRow.mine resolve to the
     same shared token (defaults to accent today; can diverge). */
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
  /* Plan 02.1-25: kind icon+text bundle. Visually pairs with the
     SourceKindIcon (currentColor inherits from this span). */
  .kind-tag {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    color: var(--color-text);
    font-weight: var(--font-weight-semibold);
  }
  /* Plan 02.1-39 round-6 polish #7 (UAT-NOTES.md §5.6 follow-up #7,
     2026-04-30): label font-size reduced so the kind tag reads as
     subordinate metadata next to the .display name (which keeps the body
     16px size). User quote during round-6 UAT walking §5.6: "тип занимает
     слишком много места. МОжно просто ютую и шрифт меньше". The labels
     themselves shortened from "YouTube channel" / "Reddit account" / ...
     to single-word forms in messages/en.json for the same reason.
     FiltersSheet.source-kind-label carries the same font-size reduction
     to keep the two surfaces visually consistent. */
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
  }
  /* Plan 02.1-33: edit-form replaces the previous .rename inline strip.
     The form is now its own row in the .row column flex with a fields
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
  /* Plan 02.1-25 (UAT-NOTES.md §2.1-redesign): upgrade the Mine pill to the
     overlay-mine visual style used by FeedCard (Plan 02.1-23). Accent
     background + white text reads as a strong, consistent "this is yours"
     signal across feed and sources.
     Plan 02.1-30 (UAT-NOTES.md §4.25.A): pill background + border resolved
     via var(--color-mine) — same shared token as the .row.mine border-left.
     The accent-text foreground intentionally stays on --color-accent-text
     because it is a paired text-on-accent token (Mine pill is white-on-accent
     by visual contract). */
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
  /* Plan 02.1-33: section divider visually separates form fields from the
     action row that follows. Border-top on a zero-height <hr> keeps the
     stacking simple while honoring the "fields above, actions below"
     read order. */
  .section-divider {
    width: 100%;
    margin: 0;
    border: 0;
    border-top: 1px solid var(--color-border);
  }
  /* Plan 02.1-33 (UAT-NOTES.md §4.22.E): edit-form footer. Save / Cancel /
     Remove sit at the BOTTOM of the form block, full-width and reachable
     at 360px without horizontal scroll. Save is the primary action
     (--color-accent fill), Cancel is the ghost variant (transparent +
     border), Remove is the danger variant (--color-destructive border
     and label color). */
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
