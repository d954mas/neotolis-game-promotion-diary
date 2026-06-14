<script lang="ts">
  // SourceRow — one row in the /sources list, restructured for 1:1
  // parity with docs/design/v2/ui-kit/sources-page.jsx.
  //
  // Layout (CSS grid: 1fr auto / "title acts" / "note note" / "foot foot"):
  //   - Title row: <kind-icon> <author-avatar> <handle-text>
  //   - Right cluster: [Sync button] [on/off toggle]
  //   - Optional note row: <source-note> with edit pencil OR "+ Add note" ghost
  //   - Footer: N events · date range · synced X ago
  //   - Absolute top-right: ⋯ overflow menu (Remove source)
  //
  // Behaviors preserved from Wave 2 Plan 09:
  //   - Click avatar → AuthorPopover → PATCH /api/sources/:id { isOwnedByMe }
  //   - Click toggle → flips autoImport → PATCH /api/sources/:id { autoImport }
  //     (prototype calls it Live/Paused / "active"; backend field is
  //     autoImport — same semantic: does the polling worker pull this source?)
  //
  // Behaviors removed by Plan 03.4-08:
  //   - Click-handle inline rename → PATCH { displayName }. Source titles
  //     arrive canonical from the platform (YouTube channelTitle, Reddit
  //     r/<sub> / u/<handle> from handleUrl); a user-typed override
  //     duplicated information and stale-ified on upstream rename. The
  //     new private `note` field replaces it as the disambiguation knob.
  //
  // Behaviors removed (superseded by prototype affordances earlier):
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
  import BackfillPicker from "./BackfillPicker.svelte";
  import RetentionBadge from "./RetentionBadge.svelte";
  import { type SourceKind } from "$lib/util/source-kind-label.js";
  import { telegramHandleFromUrl } from "$lib/util/telegram-handle.js";

  type BackfillWindow = "1d" | "7d" | "30d" | "90d" | "1y" | "everything";

  type DataSourceDto = {
    id: string;
    kind: SourceKind;
    handleUrl: string;
    displayName: string | null;
    note: string | null;
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
    backfillTargetSince?: Date | string | null;
    // AdapterError surface — populated by markSourceNeedsReconnect() when
    // an adapter throws operator-issue / permanent / not-found / rate-
    // limited against this source. The DTO has carried these since Phase
    // 03 (see src/lib/server/dto.ts:250) but this component's local Dto
    // shape only listed the fields the row needed for layout; once the
    // status pill surfaces them, the local type must list them too.
    needsReconnect?: boolean;
    lastErrorAt?: Date | string | null;
    lastErrorKind?: string | null;
  };

  let {
    source,
    cooldownSec = 0,
    pulling = false,
    currentUserName = "",
    view = "feed",
    onRestore,
    onDeleteForever,
  }: {
    source: DataSourceDto;
    cooldownSec?: number;
    pulling?: boolean;
    /** Display name for the AuthorPopover "(you)" line. */
    currentUserName?: string;
    /** "feed" (default) or "trash" — drives which affordances are rendered. */
    view?: "feed" | "trash";
    /** Restore callback — only used in trash view. */
    onRestore?: () => void;
    /** Delete-forever callback — only used in trash view. */
    onDeleteForever?: () => void;
  } = $props();

  const isTrash = $derived(view === "trash");

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
    instagram_account: "--k-instagram",
    tiktok_account: "--k-tiktok",
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

  // Note-edit state. Click the note text (or "+ Add note" ghost) → opens
  // .note-dialog with a textarea; Save commits via PATCH /api/sources/:id
  // { note }. Empty-string save is normalized to null at the route layer.
  let noteDialogOpen = $state(false);
  let noteDraft = $state("");
  let noteSaving = $state(false);
  let noteError = $state<string | null>(null);
  let authorPopoverOpen = $state(false);
  let authorAvatarEl = $state<HTMLButtonElement | null>(null);
  let menuOpen = $state(false);
  let backfillDialogOpen = $state(false);
  let backfillWindow = $state<BackfillWindow>("30d");
  let backfillCustomDate = $state<string | null>(null);
  let backfillSaving = $state(false);
  let backfillError = $state<string | null>(null);

  // Sentinel 1970-01-01 = "all history". Anything earlier than 1971 is
  // the sentinel; show 'all history' instead of a meaningless 1970 date.
  const currentTargetLabel = $derived.by((): string => {
    const ts = source.backfillTargetSince;
    if (!ts) return "—";
    const d = typeof ts === "string" ? new Date(ts) : ts;
    if (d.getTime() < new Date("1971-01-01").getTime()) return "all history";
    return d.toISOString().slice(0, 10);
  });

  // Map preset to absolute date (ms-since-epoch, midnight UTC).
  function backfillPresetToDate(preset: BackfillWindow): Date {
    const now = new Date();
    if (preset === "everything") return new Date("1970-01-01T00:00:00.000Z");
    const days = { "1d": 1, "7d": 7, "30d": 30, "90d": 90, "1y": 365 }[preset];
    const t = new Date(now);
    t.setUTCDate(t.getUTCDate() - days);
    t.setUTCHours(0, 0, 0, 0);
    return t;
  }

  // Reverse map: returns the preset whose computed date matches `ts`
  // within a 1-day tolerance. Returns null if `ts` doesn't fit any
  // preset — the dialog uses the custom-date input in that case.
  function matchPresetForTarget(ts: Date | string | null | undefined): BackfillWindow | null {
    if (!ts) return null;
    const target = typeof ts === "string" ? new Date(ts) : ts;
    // Sentinel 1970-01-01 = 'everything'
    if (target.getTime() < new Date("1971-01-01").getTime()) return "everything";
    const presets: BackfillWindow[] = ["1d", "7d", "30d", "90d", "1y"];
    const ONE_DAY_MS = 86_400_000;
    for (const p of presets) {
      const presetDate = backfillPresetToDate(p);
      if (Math.abs(target.getTime() - presetDate.getTime()) < ONE_DAY_MS) return p;
    }
    return null;
  }

  async function commitBackfill(): Promise<void> {
    if (backfillSaving) return;
    backfillSaving = true;
    backfillError = null;
    try {
      // Custom date wins over preset when both are present (BackfillPicker
      // clears the preset selection when a custom date is set).
      const target = backfillCustomDate
        ? new Date(`${backfillCustomDate}T00:00:00.000Z`)
        : backfillPresetToDate(backfillWindow);
      const res = await fetch(`/api/sources/${source.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backfillTargetSince: target.toISOString() }),
      });
      if (!res.ok) {
        let code = "error_server_generic";
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) code = body.error;
        } catch {
          /* ignore */
        }
        backfillError = code;
        return;
      }
      backfillDialogOpen = false;
      await invalidateAll();
    } catch {
      backfillError = "error_network";
    } finally {
      backfillSaving = false;
    }
  }
  let liveToggling = $state(false);
  let confirmingRemove = $state(false);
  let rowError = $state<string | null>(null);

  function openNoteDialog(): void {
    noteDraft = source.note ?? "";
    noteError = null;
    noteDialogOpen = true;
  }

  // Commit the note. Empty-string trims to null at the boundary (route
  // normalizes; we send the literal string so server-side trim is the
  // single source of truth). The current-value short-circuit matches the
  // legacy rename: no PATCH when nothing changed.
  async function commitNote(): Promise<void> {
    if (noteSaving) return;
    const next = noteDraft;
    const current = source.note ?? "";
    if (next === current) {
      noteDialogOpen = false;
      return;
    }
    noteSaving = true;
    noteError = null;
    try {
      const res = await fetch(`/api/sources/${source.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: next }),
      });
      if (!res.ok) {
        noteError = m.error_server_generic();
        return;
      }
      noteDialogOpen = false;
      await invalidateAll();
    } catch {
      noteError = m.error_network();
    } finally {
      noteSaving = false;
    }
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
    }
  }

  // Derive a Reddit-flavored handle ("r/<sub>" or "u/<handle>") from the
  // canonical handleUrl. Reddit URLs follow a fixed shape — see
  // src/lib/sources/reddit/server/adapter.ts parseSourceUrl. When the URL
  // doesn't match (corrupt data, future kinds), fall through to the URL
  // itself.
  function deriveRedditHandle(kind: SourceKind, url: string): string | null {
    if (kind === "reddit_subreddit") {
      const m = url.match(/reddit\.com\/r\/([^/?#]+)/i);
      return m ? `r/${m[1]}` : null;
    }
    if (kind === "reddit_account") {
      const m = url.match(/reddit\.com\/(?:user|u)\/([^/?#]+)/i);
      return m ? `u/${m[1]}` : null;
    }
    return null;
  }

  // Computed: handle label. The title is READ-ONLY canonical per Plan
  // 03.4-08 — pick what the platform owns, then fall back to the user's
  // legacy displayName (Phase 02 sources still have it set), then the
  // derived Reddit form, then the raw URL as last resort.
  //
  // The legacy precedence (displayName first) flipped intentionally:
  // channelTitle/canonical platform identity beats a user-typed override
  // because rename should round-trip with the upstream rename, not lock
  // to a typo from 2026. Stale displayName values are visible noise but
  // not editable here anymore — they're fading out as users re-add
  // sources, and the `note` field is the new disambiguation surface.
  const handleLabel = $derived.by((): string => {
    if (source.channelTitle) return source.channelTitle;
    if (source.displayName) return source.displayName;
    const reddit = deriveRedditHandle(source.kind, source.handleUrl);
    if (reddit) return reddit;
    if (source.kind === "telegram_channel") {
      const telegram = telegramHandleFromUrl(source.handleUrl);
      if (telegram) return telegram;
    }
    return source.handleUrl;
  });

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
    source.lastPolledAt ? `synced ${formatRelativeTime(source.lastPolledAt)}` : "never synced",
  );

  // Map stored AdapterError category → human-friendly UI label. Unknown
  // kinds fall through to a passthrough so we never hide an emergent
  // signal behind "Error" alone — the operator still sees WHICH kind.
  function errorLabel(kind: string): string {
    switch (kind) {
      case "not-found":
        return "Error: Not found";
      case "rate-limited":
        return "Error: Rate limited";
      case "permanent":
        return "Error: Banned";
      case "operator-issue":
      case "invalid_metadata":
        return "Error: Setup";
      default:
        return `Error: ${kind}`;
    }
  }

  // Status pill — user mental model: «есть ли в очереди, и обновляется
  // ли прямо сейчас». Driven SOLELY by signals that reflect actual
  // worker / queue state — never by stored defaults that may not have
  // been overwritten (the old branch `!backfillComplete → Updating` was
  // wrong: that field defaults to false from toDataSourceDto and
  // enrichWithChannelState only overwrites it when a state row exists
  // for the channelId — sources without one stayed "Updating now"
  // forever even with no job in flight).
  //
  //   needsReconnect|lastErrorKind → "Error: <kind>" (top priority — a
  //                                  broken source must not masquerade
  //                                  as "Queued" forever)
  //   pulling=true            → "Updating now"  (pg-boss job active/created)
  //   !autoImport             → "Paused"         (user toggled off)
  //   cooldownSec>0           → "Cooldown M:SS"  (manual refresh blocked)
  //   !lastPolledAt           → "Queued"         (never polled yet)
  //   default                 → "Up to date"
  type StatusVariant = "error" | "updating" | "paused" | "cooldown" | "queued" | "idle";
  const status = $derived.by((): { variant: StatusVariant; label: string } => {
    if (source.needsReconnect || source.lastErrorKind) {
      // lastErrorKind is the most specific signal; fall back to a
      // generic 'setup' label when only needsReconnect is set (defensive
      // — the markSourceNeedsReconnect helper always writes both, but
      // an external/manual UPDATE could leave kind null).
      const kind = source.lastErrorKind ?? "operator-issue";
      return { variant: "error", label: errorLabel(kind) };
    }
    if (pulling) return { variant: "updating", label: "Updating now" };
    if (!source.autoImport) return { variant: "paused", label: "Paused" };
    if (cooldownSec > 0) {
      const min = Math.floor(cooldownSec / 60);
      const sec = cooldownSec % 60;
      return {
        variant: "cooldown",
        label: `Cooldown ${min}:${String(sec).padStart(2, "0")}`,
      };
    }
    if (!source.lastPolledAt) return { variant: "queued", label: "Queued" };
    return { variant: "idle", label: "Up to date" };
  });
</script>

<article
  class="source-row"
  data-active={isTrash ? "1" : source.autoImport ? "1" : "0"}
  data-mine={source.isOwnedByMe ? "1" : "0"}
  data-kind={source.kind}
  style="--card-accent: var({KIND_VAR[source.kind]});"
>
  {#if isTrash}
    <!-- Trash view — same full card layout as live mode, no opacity dim.
         ⋮ menu carries Restore + Delete forever (same pattern as /feed
         trash cards). RetentionBadge in footer shows days remaining. -->
    <div class="card-actions">
      <button
        type="button"
        class="card-action-btn overflow"
        onclick={(e) => {
          e.stopPropagation();
          menuOpen = !menuOpen;
        }}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="More actions"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="5" r="1.8" fill="currentColor" />
          <circle cx="12" cy="12" r="1.8" fill="currentColor" />
          <circle cx="12" cy="19" r="1.8" fill="currentColor" />
        </svg>
      </button>
      {#if menuOpen}
        <button
          type="button"
          class="picker-scrim"
          onclick={() => (menuOpen = false)}
          aria-label="Close menu"
        ></button>
        <div class="card-menu" role="menu">
          {#if onRestore}
            <button
              type="button"
              class="card-menu-item"
              role="menuitem"
              onclick={() => {
                menuOpen = false;
                onRestore?.();
              }}
            >
              {m.common_restore()}
            </button>
          {/if}
          {#if onDeleteForever}
            <button
              type="button"
              class="card-menu-item danger"
              role="menuitem"
              onclick={() => {
                menuOpen = false;
                onDeleteForever?.();
              }}
            >
              {m.sources_trash_delete_forever()}
            </button>
          {/if}
        </div>
      {/if}
    </div>

    <h3 class="source-title">
      <span class="kind-icon" aria-hidden="true">
        <SourceKindIcon kind={source.kind} />
      </span>
      <span class="source-title-text" title={handleLabel}>
        {handleLabel}
      </span>
    </h3>

    <div class="source-actions">
      {#if source.deletedAt}
        <RetentionBadge deletedAt={source.deletedAt} />
      {/if}
    </div>

    {#if source.note}
      <div class="source-note">
        <span class="source-note-text">{source.note}</span>
      </div>
    {/if}

    <div class="source-foot">
      <span>{eventCount} {eventCount === 1 ? "event" : "events"}</span>
      {#if hasRange}
        <span class="source-foot-sep">·</span>
        <span class="source-foot-range">{dateRangeLabel}</span>
      {/if}
    </div>
  {:else}
    <!-- Feed view — full interactive row with sync, toggle, menu. -->
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
        <button
          type="button"
          class="picker-scrim"
          onclick={() => (menuOpen = false)}
          aria-label="Close menu"
        ></button>
        <div class="card-menu" role="menu">
          <button
            type="button"
            class="card-menu-item"
            role="menuitem"
            onclick={() => {
              menuOpen = false;
              const ts = source.backfillTargetSince;
              const matched = matchPresetForTarget(ts);
              if (matched) {
                backfillWindow = matched;
                backfillCustomDate = null;
              } else if (ts) {
                const d = typeof ts === "string" ? new Date(ts) : ts;
                backfillCustomDate = d.toISOString().slice(0, 10);
              } else {
                backfillWindow = "30d";
                backfillCustomDate = null;
              }
              backfillError = null;
              backfillDialogOpen = true;
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            <span>Backfill window…</span>
          </button>

          <button
            type="button"
            class="card-menu-item danger"
            role="menuitem"
            onclick={() => {
              menuOpen = false;
              confirmingRemove = true;
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 6h18" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            </svg>
            <span>{m.common_remove()}</span>
          </button>
        </div>
      {/if}
    </div>

    <h3 class="source-title">
      <span class="kind-icon" aria-hidden="true">
        <SourceKindIcon kind={source.kind} />
      </span>

      <span class="author-pick">
        <button
          bind:this={authorAvatarEl}
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
            anchor={authorAvatarEl}
            onchange={changeAuthor}
            onclose={() => (authorPopoverOpen = false)}
          />
        {/if}
      </span>

      <span class="source-title-text" title={handleLabel}>
        {handleLabel}
      </span>
    </h3>

    <div class="source-actions">
      <span class="status-pill" data-variant={status.variant}>
        {#if status.variant === "updating"}
          <span class="status-dot" aria-hidden="true"></span>
        {/if}
        {status.label}
      </span>
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

    {#if source.deletedAt === null}
      <div class="source-note">
        {#if source.note}
          <span class="source-note-text">{source.note}</span>
          <button
            type="button"
            class="source-note-edit"
            onclick={openNoteDialog}
            aria-label={m.source_note_edit_aria()}
            title={m.source_note_edit_aria()}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
        {:else}
          <button type="button" class="source-note-add" onclick={openNoteDialog}>
            {m.source_note_add()}
          </button>
        {/if}
      </div>
    {/if}

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
  {/if}
</article>

<ConfirmDialog
  open={confirmingRemove}
  message={m.confirm_source_remove({ display_name: source.displayName ?? source.handleUrl })}
  confirmLabel={m.common_remove()}
  onConfirm={confirmRemove}
  onCancel={() => (confirmingRemove = false)}
/>

<!-- Note editor — same dialog vocabulary as .backfill-dialog so the user
     recognises the surface from /sources interactions. Esc + backdrop +
     × all close non-destructively (Save is the only commit path). -->
{#if noteDialogOpen}
  <dialog
    class="note-dialog"
    open
    oncancel={(e) => {
      e.preventDefault();
      noteDialogOpen = false;
    }}
    onclick={(e) => {
      if (e.target === e.currentTarget) noteDialogOpen = false;
    }}
  >
    <header class="note-dialog-head">
      <h2 class="note-dialog-title">{m.source_note_dialog_title()}</h2>
      <button
        type="button"
        class="note-dialog-close"
        onclick={() => (noteDialogOpen = false)}
        aria-label={m.common_close()}>×</button
      >
    </header>
    <div class="note-dialog-body">
      <p class="note-dialog-hint">{m.source_note_dialog_hint()}</p>
      <textarea
        class="note-dialog-textarea"
        bind:value={noteDraft}
        rows="4"
        maxlength="500"
        placeholder={m.source_note_placeholder()}
      ></textarea>
      {#if noteError}
        <InlineError message={noteError} />
      {/if}
    </div>
    <footer class="note-dialog-foot">
      <button type="button" class="btn ghost" onclick={() => (noteDialogOpen = false)}>
        {m.common_cancel()}
      </button>
      <button
        type="button"
        class="btn primary"
        onclick={() => void commitNote()}
        disabled={noteSaving}
      >
        {noteSaving ? "Saving…" : m.common_save()}
      </button>
    </footer>
  </dialog>
{/if}

<!-- Backfill window dialog — opened from ⋮ menu. Reuses BackfillPicker
     (the same preset selector /sources/new ships). Saving issues a
     PATCH with backfillTargetSince derived from the preset. Server-side
     guard (services/data-sources.ts:698) rejects forward moves; the
     dialog surfaces the resulting 422 via backfillError. -->
{#if backfillDialogOpen}
  <dialog
    class="backfill-dialog"
    open
    oncancel={(e) => {
      e.preventDefault();
      backfillDialogOpen = false;
    }}
    onclick={(e) => {
      if (e.target === e.currentTarget) backfillDialogOpen = false;
    }}
  >
    <header class="backfill-dialog-head">
      <h2 class="backfill-dialog-title">Backfill window</h2>
      <button
        type="button"
        class="backfill-dialog-close"
        onclick={() => (backfillDialogOpen = false)}
        aria-label="Close">×</button
      >
    </header>
    <div class="backfill-dialog-body">
      {#if source.backfillTargetSince}
        <p class="backfill-dialog-current">
          Currently pulling from <b>{currentTargetLabel}</b>
        </p>
      {/if}
      <p class="backfill-dialog-hint">
        Window can only move <b>earlier</b> in time (you can't drop already-imported events).
      </p>
      <BackfillPicker
        bind:value={backfillWindow}
        bind:customDate={backfillCustomDate}
        maxDate={source.backfillTargetSince
          ? new Date(
              typeof source.backfillTargetSince === "string"
                ? source.backfillTargetSince
                : source.backfillTargetSince.toISOString(),
            )
              .toISOString()
              .slice(0, 10)
          : undefined}
      />
      {#if backfillError}
        <InlineError message={backfillError} />
      {/if}
    </div>
    <footer class="backfill-dialog-foot">
      <button type="button" class="btn ghost" onclick={() => (backfillDialogOpen = false)}
        >Cancel</button
      >
      <button
        type="button"
        class="btn primary"
        onclick={() => void commitBackfill()}
        disabled={backfillSaving}
      >
        {backfillSaving ? "Saving…" : "Save"}
      </button>
    </footer>
  </dialog>
{/if}

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
      "note  note"
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
  /* Paused (auto-import off) rows are de-emphasised, but the dim must not
   * crush the footer (events · range · synced) below WCAG AA — that mono
   * line is a paused source's only accumulated-data signal. opacity:0.6
   * dropped --text-3 there to ~3.6:1; 0.85 keeps it ≥4.5:1. The explicit
   * dashed "Paused" status pill carries the state, so a light dim suffices. */
  .source-row[data-active="0"] {
    opacity: 0.85;
  }
  .source-row[data-active="0"]:hover {
    opacity: 1;
  }

  /* ⋯ overflow — absolute top-right corner. Quieter than feed-card's
   * lifted button: no surface, no border, just a dim glyph until hover. */
  .card-actions {
    position: absolute;
    top: 8px;
    right: 10px;
    z-index: 2;
  }
  /* ⋮ button — make it discoverable. Subtle border + filled surface so
   * the user sees it as an actionable affordance instead of disappearing
   * into the background. */
  .card-action-btn.overflow {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-2);
    width: 28px;
    height: 28px;
    padding: 0;
    border-radius: var(--r-sm);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition:
      background var(--m-fast),
      border-color var(--m-fast),
      color var(--m-fast);
  }
  .card-action-btn.overflow:hover,
  .card-action-btn.overflow[aria-expanded="true"] {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent-strong);
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
    text-decoration: none;
  }
  .card-menu-item:hover {
    background: var(--surface-3);
  }
  .card-menu-item:disabled {
    opacity: 0.55;
    cursor: not-allowed;
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
  /* Title is read-only canonical (Plan 03.4-08). No click affordance,
   * no hover treatment — it's text, not a button. The user-facing
   * disambiguation moves to the .source-note row below. */
  .source-title-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
  }

  /* Note row — appears below the title row. Single-line preview when
   * populated (truncated with ellipsis on overflow; full note visible in
   * the editor dialog); ghost "+ Add note" button when empty. Mono font
   * matches the prototype's note styling on /sources. */
  .source-note {
    grid-area: note;
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    margin-top: 2px;
    font-family: var(--f-mono);
    font-size: 12px;
    color: var(--text-3);
    line-height: 1.4;
  }
  .source-note-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-2);
    font-style: italic;
  }
  .source-note-edit {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    color: var(--text-3);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
    flex-shrink: 0;
  }
  .source-note-edit:hover {
    background: var(--surface-2);
    border-color: var(--border);
    color: var(--accent);
  }
  .source-note-add {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    background: transparent;
    border: 1px dashed var(--border-2);
    border-radius: var(--r-sm);
    color: var(--text-3);
    font-family: var(--f-mono);
    font-size: 11.5px;
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .source-note-add:hover {
    background: var(--accent-soft);
    border-color: var(--accent);
    border-style: solid;
    color: var(--accent-strong);
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

  /* Status pill — mirrors event PollingBadge vocab. One per row,
   * variant-tinted background + label. */
  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border-radius: var(--r-pill);
    font-family: var(--f-mono);
    font-size: 11px;
    font-weight: var(--w-sb);
    letter-spacing: 0.01em;
    text-transform: uppercase;
    line-height: 1.4;
  }
  .status-pill[data-variant="updating"] {
    background: color-mix(in oklab, var(--accent) 18%, var(--surface));
    border: 1px solid color-mix(in oklab, var(--accent) 55%, var(--border));
    color: var(--accent-strong);
  }
  .status-pill[data-variant="cooldown"] {
    background: color-mix(in oklab, var(--warn) 14%, var(--surface));
    border: 1px solid color-mix(in oklab, var(--warn) 50%, var(--border));
    color: var(--text);
  }
  .status-pill[data-variant="paused"] {
    background: var(--surface-2);
    border: 1px dashed var(--border-2);
    color: var(--text-3);
  }
  .status-pill[data-variant="queued"] {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-3);
  }
  .status-pill[data-variant="idle"] {
    background: color-mix(in oklab, var(--success, #5eb572) 14%, var(--surface));
    border: 1px solid color-mix(in oklab, var(--success, #5eb572) 45%, var(--border));
    color: color-mix(in oklab, var(--success, #5eb572) 70%, var(--text));
  }
  /* Error variant — danger-tinted pill that displaces every other
   * status. The user MUST see that the source is broken, so the
   * priority chain in `status` puts this branch first. */
  .status-pill[data-variant="error"] {
    background: color-mix(in oklab, var(--danger) 14%, var(--surface));
    border: 1px solid color-mix(in oklab, var(--danger) 55%, var(--border));
    color: var(--danger);
  }
  /* Animated dot for the "Refreshing now" state. */
  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    animation: status-pulse 1s ease-in-out infinite;
  }
  @keyframes status-pulse {
    0%,
    100% {
      opacity: 0.35;
      transform: scale(0.7);
    }
    50% {
      opacity: 1;
      transform: scale(1.1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .status-dot {
      animation: none;
    }
  }

  /* Backfill window dialog — sibling <dialog open> rendered fixed on
   * top of the page chrome (browser top-layer). Reuses the same
   * vocabulary as notes-editor-modal / GamesPicker. */
  .backfill-dialog {
    width: min(480px, calc(100vw - 32px));
    padding: 0;
    margin: auto;
    border: 1px solid var(--border-2);
    border-radius: var(--r-lg);
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-elev);
    display: flex;
    flex-direction: column;
    position: fixed;
    inset: 0;
    z-index: 1000;
  }
  .backfill-dialog::backdrop {
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
  }
  .backfill-dialog-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-hairline);
  }
  .backfill-dialog-title {
    flex: 1;
    margin: 0;
    font-size: var(--t-15);
    font-weight: var(--w-sb);
  }
  .backfill-dialog-close {
    width: 30px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    color: var(--text-3);
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
  }
  .backfill-dialog-close:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .backfill-dialog-body {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .backfill-dialog-current {
    margin: 0;
    padding: 8px 12px;
    background: color-mix(in oklab, var(--accent) 14%, var(--surface));
    border: 1px solid color-mix(in oklab, var(--accent) 40%, var(--border));
    border-radius: var(--r-sm);
    color: var(--text);
    font-size: var(--t-13);
  }
  .backfill-dialog-current b {
    color: var(--accent-strong);
    font-weight: var(--w-sb);
    font-family: var(--f-mono);
  }
  .backfill-dialog-hint {
    margin: 0;
    font-size: var(--t-13);
    color: var(--text-3);
    line-height: 1.5;
  }
  .backfill-dialog-hint b {
    color: var(--text);
    font-weight: var(--w-sb);
  }
  .backfill-dialog-foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border-hairline);
  }
  .backfill-dialog-foot .btn {
    display: inline-flex;
    align-items: center;
    min-height: var(--hit);
    padding: 0 var(--s-3);
    border-radius: var(--r-sm);
    font-size: var(--t-13);
    font-weight: var(--w-md);
    cursor: pointer;
    transition:
      background var(--m-fast),
      border-color var(--m-fast);
  }
  .backfill-dialog-foot .btn.ghost {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
  }
  .backfill-dialog-foot .btn.ghost:hover {
    background: var(--surface-3);
    border-color: var(--border-2);
  }
  .backfill-dialog-foot .btn.primary {
    background: var(--accent);
    border: 1px solid var(--accent);
    color: var(--accent-text);
    font-weight: var(--w-sb);
  }
  .backfill-dialog-foot .btn.primary:hover:not(:disabled) {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .backfill-dialog-foot .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Mobile — actions wrap below title on narrow screens. */
  @media (max-width: 560px) {
    .source-row {
      grid-template-columns: 1fr;
      grid-template-areas:
        "title"
        "acts"
        "note"
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
    .source-note-edit,
    .source-note-add,
    .card-action-btn.overflow {
      transition: none;
    }
  }

  /* Trash-view inline button styles removed — Restore + Delete forever
   * now live in the ⋮ menu (same pattern as /feed trash cards). No
   * opacity dim on trash rows — matches /feed where deleted events
   * render at full readability. */

  /* Note dialog — same vocabulary as .backfill-dialog. The user already
   * meets this surface from the ⋮ menu's "Backfill window…" item; reusing
   * the same chrome keeps the row's two modal affordances visually
   * coherent. */
  .note-dialog {
    width: min(480px, calc(100vw - 32px));
    padding: 0;
    margin: auto;
    border: 1px solid var(--border-2);
    border-radius: var(--r-lg);
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-elev);
    display: flex;
    flex-direction: column;
    position: fixed;
    inset: 0;
    z-index: 1000;
  }
  .note-dialog::backdrop {
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
  }
  .note-dialog-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-hairline);
  }
  .note-dialog-title {
    flex: 1;
    margin: 0;
    font-size: var(--t-15);
    font-weight: var(--w-sb);
  }
  .note-dialog-close {
    width: 30px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    color: var(--text-3);
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
  }
  .note-dialog-close:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .note-dialog-body {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .note-dialog-hint {
    margin: 0;
    font-size: var(--t-13);
    color: var(--text-3);
    line-height: 1.5;
  }
  .note-dialog-textarea {
    width: 100%;
    padding: 8px 10px;
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    line-height: var(--lh-body);
    resize: vertical;
    min-height: 80px;
    transition: border-color var(--m-fast) var(--m-ease);
  }
  .note-dialog-textarea::placeholder {
    color: var(--text-3);
  }
  .note-dialog-textarea:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: var(--focus-ring);
  }
  .note-dialog-foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border-hairline);
  }
  .note-dialog-foot .btn {
    display: inline-flex;
    align-items: center;
    min-height: var(--hit);
    padding: 0 var(--s-3);
    border-radius: var(--r-sm);
    font-size: var(--t-13);
    font-weight: var(--w-md);
    cursor: pointer;
    transition:
      background var(--m-fast),
      border-color var(--m-fast);
  }
  .note-dialog-foot .btn.ghost {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
  }
  .note-dialog-foot .btn.ghost:hover {
    background: var(--surface-3);
    border-color: var(--border-2);
  }
  .note-dialog-foot .btn.primary {
    background: var(--accent);
    border: 1px solid var(--accent);
    color: var(--accent-text);
    font-weight: var(--w-sb);
  }
  .note-dialog-foot .btn.primary:hover:not(:disabled) {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .note-dialog-foot .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
