<script lang="ts">
  // SourceRow — one row in the /sources list, restructured for 1:1
  // parity with docs/design/v2/ui-kit/sources-page.jsx.
  //
  // Layout (CSS grid: 1fr auto / "title acts" / "foot foot"):
  //   - Title row: <kind-icon> <author-avatar> <handle-text>
  //   - Right cluster: [Sync button] [on/off toggle]
  //   - Footer: N events · date range · synced X ago
  //   - Absolute top-right: ⋯ overflow menu (Remove source)
  //
  // Behaviors preserved from Wave 2 Plan 09:
  //   - Click handle → inline rename → PATCH /api/sources/:id { displayName }
  //   - Click avatar → AuthorPopover → PATCH /api/sources/:id { isOwnedByMe }
  //   - Click toggle → flips autoImport → PATCH /api/sources/:id { autoImport }
  //     (prototype calls it Live/Paused / "active"; backend field is
  //     autoImport — same semantic: does the polling worker pull this source?)
  //
  // Behaviors removed (superseded by prototype affordances):
  //   - Phase 02.1-33 edit-mode form (rename + auto-import checkbox + Remove
  //     in form footer): all four moves now have a dedicated inline
  //     affordance. Removing the form eliminates the D-08 mutual exclusion
  //     concern (there is no longer an edit-mode footer to compete with).
  //   - .ownership-badge (Mine / Tracking pill): the avatar's data-mine
  //     attribute already carries the same signal visually.
  //   - .auto-pill (Auto-import chip): the toggle switch IS this signal.
  //
  // Remove now lives behind the ⋯ overflow menu, mirroring feed-card.

  import { invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import SourceKindIcon from "./SourceKindIcon.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import InlineError from "./InlineError.svelte";
  import RefreshContentButton from "./RefreshContentButton.svelte";
  import AuthorPopover from "./shared/AuthorPopover.svelte";
  import { type SourceKind } from "$lib/util/source-kind-label.js";

  type DataSourceDto = {
    id: string;
    kind: SourceKind;
    handleUrl: string;
    displayName: string | null;
    isOwnedByMe: boolean;
    autoImport: boolean;
    deletedAt: Date | string | null;
    channelTitle?: string | null;
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
    /** Display name for the AuthorPopover "(you)" line. */
    currentUserName?: string;
  } = $props();

  // Map data_sources.kind → CSS variable so .source-row::before and the
  // .kind-icon pick up the per-platform accent. The data_sources kinds
  // (youtube_channel / reddit_account / …) don't 1:1 match the event
  // kinds (--k-youtube / --k-reddit / …), so this mapping translates.
  const KIND_VAR: Record<SourceKind, string> = {
    youtube_channel: "--k-youtube",
    reddit_account: "--k-reddit",
    reddit_subreddit: "--k-reddit",
    twitter_account: "--k-twitter",
    telegram_channel: "--k-telegram",
    discord_server: "--k-discord",
  };

  // Relative-time formatter for "synced X ago".
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

  // Compact date label ("Apr 19" / "May 12") — matches the prototype's
  // date-range footer. Year is dropped: the source list is current-year
  // bias; if the range spans years the user can open the detail page.
  function formatDateShort(when: Date | string): string {
    const t = typeof when === "string" ? new Date(when) : when;
    return t.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  // Inline-rename state. Click handle text → input replaces it; Enter or
  // blur commits via PATCH /api/sources/:id { displayName }.
  let renameMode = $state(false);
  let renameDraft = $state("");
  let authorPopoverOpen = $state(false);
  let menuOpen = $state(false);
  let liveToggling = $state(false);
  let confirmingRemove = $state(false);
  let mutating = $state(false);
  let rowError = $state<string | null>(null);

  async function commitRename(): Promise<void> {
    const next = renameDraft.trim();
    const current = source.displayName ?? "";
    if (next === "" || next === current) {
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

  // Toggle autoImport (the prototype's "active"). The polling worker
  // pulls new content iff autoImport=true, which is exactly what the
  // prototype's Live/Paused switch represents.
  async function toggleActive(): Promise<void> {
    if (liveToggling) return;
    liveToggling = true;
    rowError = null;
    try {
      const res = await fetch(`/api/sources/${source.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoImport: !source.autoImport }),
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

  // Computed: handle label. Prefer the user-chosen displayName, then the
  // YouTube channel title from the cache, finally the raw URL/handle.
  const handleLabel = $derived(
    source.displayName ?? source.channelTitle ?? source.handleUrl,
  );

  // Footer string parts. The prototype puts events · date range · synced
  // on one mono line.
  const eventCount = $derived(source.eventCount ?? 0);
  const hasRange = $derived(!!(source.firstEventAt && source.lastEventAt));
  const dateRangeLabel = $derived(
    hasRange
      ? `${formatDateShort(source.firstEventAt as Date | string)} — ${formatDateShort(source.lastEventAt as Date | string)}`
      : "",
  );
  const lastSyncedLabel = $derived(
    source.lastPolledAt
      ? `synced ${formatRelativeTime(source.lastPolledAt)}`
      : "never synced",
  );
</script>

<article
  class="source-row"
  data-active={source.autoImport ? "1" : "0"}
  data-mine={source.isOwnedByMe ? "1" : "0"}
  data-kind={source.kind}
  style="--card-accent: var({KIND_VAR[source.kind]});"
>
  <!-- ⋯ overflow — absolute top-right, mirrors feed-card affordance. -->
  <div class="card-actions">
    <button
      type="button"
      class="card-action-btn overflow"
      onclick={(e) => {
        e.stopPropagation();
        menuOpen = !menuOpen;
      }}
      title="More actions"
      aria-label="More actions"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="5" r="1.8" fill="currentColor" />
        <circle cx="12" cy="12" r="1.8" fill="currentColor" />
        <circle cx="12" cy="19" r="1.8" fill="currentColor" />
      </svg>
    </button>
    {#if menuOpen}
      <!-- Scrim closes the menu on outside click. Same dismissal pattern
           as AuthorPopover. -->
      <button
        type="button"
        class="picker-scrim"
        onclick={() => (menuOpen = false)}
        aria-label="Close menu"
      ></button>
      <div class="card-menu" role="menu">
        <button
          type="button"
          class="card-menu-item danger"
          role="menuitem"
          onclick={() => {
            menuOpen = false;
            confirmingRemove = true;
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 6h18" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          </svg>
          <span>{m.common_remove()}</span>
        </button>
      </div>
    {/if}
  </div>

  <!-- Title row — mini kind icon + clickable author avatar + handle text. -->
  <h3 class="source-title">
    <span class="kind-icon" aria-hidden="true">
      <SourceKindIcon kind={source.kind} />
    </span>

    <span class="author-pick">
      <button
        type="button"
        class="author-avatar source-author-trigger"
        data-mine={source.isOwnedByMe ? "1" : "0"}
        onclick={(e) => {
          e.stopPropagation();
          authorPopoverOpen = !authorPopoverOpen;
        }}
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

    {#if renameMode}
      <input
        class="source-title-input"
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
    {:else}
      <button
        type="button"
        class="source-title-text"
        title={handleLabel}
        onclick={() => {
          renameMode = true;
          renameDraft = source.displayName ?? source.channelTitle ?? source.handleUrl;
        }}
      >
        {handleLabel}
      </button>
    {/if}
  </h3>

  <!-- Right cluster — Sync (compact, ghost) + Live/Paused toggle. -->
  <div class="source-actions">
    <RefreshContentButton
      sourceId={source.id}
      sourceKind={source.kind}
      compact
      initialCooldownSec={cooldownSec}
      {pulling}
    />
    <button
      type="button"
      class="source-toggle"
      data-on={source.autoImport ? "1" : "0"}
      onclick={toggleActive}
      disabled={liveToggling}
      aria-pressed={source.autoImport}
      aria-label={source.autoImport ? "Pause source" : "Resume source"}
      title={source.autoImport ? "Pause" : "Resume"}
    >
      <span class="source-toggle-thumb"></span>
    </button>
  </div>

  <!-- Footer — single mono line: events · date range · synced X ago. -->
  <div class="source-foot">
    <span>{eventCount} {eventCount === 1 ? "event" : "events"}</span>
    {#if hasRange}
      <span class="source-foot-sep">·</span>
      <span class="source-foot-range">{dateRangeLabel}</span>
    {/if}
    <span class="source-foot-sep">·</span>
    <span>{lastSyncedLabel}</span>
  </div>

  {#if rowError}
    <InlineError message={rowError} />
  {/if}
</article>

<ConfirmDialog
  open={confirmingRemove}
  message={m.confirm_source_remove({ display_name: source.displayName ?? source.handleUrl })}
  confirmLabel={m.common_remove()}
  onConfirm={confirmRemove}
  onCancel={() => (confirmingRemove = false)}
/>

<style>
  /* SourceRow — 1:1 parity with docs/design/v2/ui-kit/sources-page.jsx.
   *
   * Grid layout:
   *   "title acts"
   *   "foot  foot"
   * with a 2px --card-accent left bar (::before) per platform color and
   * a top-right ⋯ overflow menu absolutely positioned over the row. */

  .source-row {
    position: relative;
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-areas:
      "title acts"
      "foot  foot";
    align-items: center;
    gap: 6px 12px;
    padding: 12px 14px 10px;
    padding-right: 44px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-card);
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease),
      opacity var(--m-fast) var(--m-ease);
  }
  .source-row::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--card-accent, var(--border-2));
    border-top-left-radius: var(--r-md);
    border-bottom-left-radius: var(--r-md);
  }
  @media (hover: hover) {
    .source-row:hover {
      background: var(--surface-2);
      border-color: var(--border-2);
    }
  }
  .source-row[data-active="0"] {
    opacity: 0.6;
  }
  .source-row[data-active="0"]:hover {
    opacity: 0.85;
  }

  /* ⋯ overflow — absolute top-right corner. Quieter than feed-card's
   * lifted button: no surface, no border, just a dim glyph until hover. */
  .card-actions {
    position: absolute;
    top: 8px;
    right: 10px;
    z-index: 2;
  }
  .card-action-btn.overflow {
    background: transparent;
    border: 0;
    color: var(--text-4);
    width: 24px;
    height: 24px;
    padding: 0;
    border-radius: var(--r-sm);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background var(--m-fast), color var(--m-fast);
  }
  .card-action-btn.overflow:hover,
  .card-action-btn.overflow[aria-expanded="true"] {
    background: var(--surface-2);
    color: var(--text-2);
  }

  /* Card menu — small popover anchored under the ⋯ trigger. */
  .picker-scrim {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    padding: 0;
    margin: 0;
    z-index: 49;
    cursor: default;
  }
  .card-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 50;
    min-width: 200px;
    padding: var(--s-1);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-elev);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .card-menu-item {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    background: transparent;
    border: none;
    text-align: left;
    padding: var(--s-2) var(--s-3);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    color: var(--text);
    cursor: pointer;
    border-radius: var(--r-sm);
    transition: background var(--m-fast) var(--m-ease);
  }
  .card-menu-item:hover {
    background: var(--surface-3);
  }
  .card-menu-item.danger {
    color: var(--danger);
  }
  .card-menu-item.danger:hover {
    background: color-mix(in oklab, var(--danger) 14%, var(--surface-2));
  }

  /* Title row — single line: kind icon + author avatar + handle text. */
  .source-title {
    grid-area: title;
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    min-width: 0;
    font-family: var(--f-mono);
    font-size: var(--t-15);
    font-weight: var(--w-sb);
    color: var(--text);
    letter-spacing: -0.005em;
    line-height: 1.25;
  }
  .kind-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    color: var(--card-accent, var(--text-3));
    flex-shrink: 0;
  }
  .source-title-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: transparent;
    border: none;
    padding: 0;
    margin: 0;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    cursor: pointer;
    text-align: left;
    transition: color var(--m-fast) var(--m-ease);
  }
  .source-title-text:hover {
    color: var(--accent);
    text-decoration: underline dotted;
  }
  .source-title-input {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 26px;
    padding: 2px 6px;
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--accent-strong);
    border-radius: var(--r-sm);
    font-family: var(--f-mono);
    font-size: var(--t-15);
    font-weight: var(--w-sb);
    letter-spacing: -0.005em;
  }

  /* Clickable author avatar in the title row — matches feed-card
   * .author-avatar in size and treatment. Hover gently scales. */
  .author-pick {
    position: relative;
    display: inline-flex;
  }
  .author-avatar.source-author-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    background: var(--surface-3);
    color: var(--text-3);
    border: 1px solid var(--border);
    border-radius: 50%;
    font-family: var(--f-sans);
    font-size: 11px;
    font-weight: var(--w-sb);
    cursor: pointer;
    flex-shrink: 0;
    transition:
      background var(--m-fast),
      border-color var(--m-fast),
      transform var(--m-fast) var(--m-ease),
      box-shadow var(--m-fast) var(--m-ease);
  }
  .author-avatar[data-mine="1"] {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
  }
  @media (hover: hover) {
    .author-avatar.source-author-trigger:hover {
      transform: scale(1.1);
      box-shadow: 0 0 0 2px var(--accent-soft);
    }
  }

  /* Right action cluster — compact Sync (Refresh) + on/off toggle. */
  .source-actions {
    grid-area: acts;
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
    flex-shrink: 0;
  }

  /* On/off toggle — classic switch. Accent fill when on. */
  .source-toggle {
    position: relative;
    width: 38px;
    height: 22px;
    padding: 0;
    background: var(--surface-3);
    border: 1px solid var(--border-2);
    border-radius: 11px;
    cursor: pointer;
    transition:
      background var(--m-fast),
      border-color var(--m-fast);
    flex-shrink: 0;
  }
  .source-toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--text-3);
    transition:
      left var(--m-fast) var(--m-ease),
      background var(--m-fast) var(--m-ease);
  }
  .source-toggle[data-on="1"] {
    background: var(--accent);
    border-color: var(--accent);
  }
  .source-toggle[data-on="1"] .source-toggle-thumb {
    left: 18px;
    background: var(--accent-text);
  }
  .source-toggle:hover:not(:disabled) {
    border-color: var(--text-3);
  }
  .source-toggle:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  /* Footer — single mono line: events · date range · synced X ago.
   * Spans both grid columns. */
  .source-foot {
    grid-area: foot;
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 2px 8px;
    color: var(--text-3);
    font-family: var(--f-mono);
    font-size: 11.5px;
    letter-spacing: 0.01em;
    font-variant-numeric: tabular-nums;
  }
  .source-foot-sep {
    color: var(--text-4);
    opacity: 0.6;
  }
  .source-foot-range {
    color: var(--text-2);
  }

  /* Mobile — actions wrap below title on narrow screens. */
  @media (max-width: 560px) {
    .source-row {
      grid-template-columns: 1fr;
      grid-template-areas:
        "title"
        "acts"
        "foot";
      gap: 8px;
    }
    .source-actions {
      justify-content: flex-start;
      flex-wrap: wrap;
      gap: 10px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .source-row,
    .source-toggle,
    .source-toggle-thumb,
    .author-avatar.source-author-trigger,
    .source-title-text,
    .card-action-btn.overflow {
      transition: none;
    }
  }
</style>
