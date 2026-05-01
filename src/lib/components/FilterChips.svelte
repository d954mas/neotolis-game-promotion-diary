<script lang="ts">
  // FilterChips — per-axis chip strip rendering active /feed filters
  // (UI-SPEC §"Component inventory" + §"/feed filter row — chips → sheet
  // pattern"; Plan 02.1-19 rewrites the chip emission to one chip per
  // active axis, not one per value).
  //
  // Layout contract (Plan 02.1-19):
  //   - One chip per active axis (kind / source / show / authorIsMe), with
  //     value labels comma-joined inside the chip text. No '+N more'
  //     truncation — long chips wrap text inside (word-break: break-word;
  //     min-width: 0). flex-wrap moves whole chips to a new row when
  //     natural width exceeds the strip.
  //   - Click chip body → opens FiltersSheet with focusAxis hint so the
  //     sheet scrolls/focuses the corresponding fieldset.
  //   - Click × → clears the entire axis (drops all values for that axis,
  //     NOT a single value).
  //   - Date-range chip is NOT emitted — the visible from/to inputs above
  //     the chip strip ARE the indicator (round-2 UAT gap "no chip
  //     duplication").

  import { m } from "$lib/paraglide/messages.js";

  type ShowFilter =
    | { kind: "any" }
    | { kind: "inbox" }
    | { kind: "standalone" }
    | { kind: "specific"; gameIds: string[] };

  type ActiveFilters = {
    source: string[];
    kind: string[];
    show: ShowFilter;
    authorIsMe?: boolean;
    from?: string;
    to?: string;
    defaultDateRange: boolean;
    all: boolean;
    // Plan 02.1-20 carry-over: action stays in the type so /audit can
    // populate it. Plan 02.1-21: chip emission is gated on `schema`,
    // not on the presence of this field.
    action?: string[];
  };
  type SourceOption = { id: string; displayName: string | null; handleUrl: string };
  type GameOption = { id: string; title: string };

  // Plan 02.1-21: the FilterChips axis union mirrors FiltersSheet's
  // FilterAxis type. 'date' is intentionally NOT included — the visible
  // from/to inputs in <DateRangeControl> are the date indicator (round-2
  // UAT contract preserved).
  type ChipAxis = "kind" | "source" | "show" | "authorIsMe" | "action";
  type FilterAxis = ChipAxis | "date";

  let {
    filters,
    sources,
    games,
    schema,
    onDismiss,
    onOpenSheet,
    onClearAll,
  }: {
    filters: ActiveFilters;
    sources: SourceOption[];
    games: GameOption[];
    // Plan 02.1-21: REQUIRED — same shape as FiltersSheet's schema. Chips
    // are only emitted for axes present in schema. /feed passes
    // ['kind','source','show','authorIsMe','date']; /audit passes
    // ['action','date']. (The 'date' entry has no chip — the date inputs
    // ARE the indicator — but it stays in the schema to keep the array a
    // single source of truth across both components.)
    schema: ReadonlyArray<FilterAxis>;
    onDismiss: (axis: ChipAxis) => void;
    onOpenSheet: (focusAxis?: ChipAxis) => void;
    onClearAll: () => void;
  } = $props();

  function kindLabel(k: string): string {
    switch (k) {
      case "youtube_video":
        return m.event_kind_label_youtube_video();
      case "reddit_post":
        return m.event_kind_label_reddit_post();
      case "twitter_post":
        return m.event_kind_label_twitter_post();
      case "telegram_post":
        return m.event_kind_label_telegram_post();
      case "discord_drop":
        return m.event_kind_label_discord_drop();
      case "conference":
        return m.event_kind_label_conference();
      case "talk":
        return m.event_kind_label_talk();
      case "press":
        return m.event_kind_label_press();
      case "other":
        return m.event_kind_label_other();
      case "post":
        return m.event_kind_label_post();
      default:
        return k;
    }
  }

  // Plan 02.1-20: AUDIT_ACTIONS mirror for the /audit reuse. Drift caught
  // by tests/integration/audit-render.test.ts (Task 5) which iterates
  // AUDIT_ACTIONS and asserts every value renders a non-fallback label.
  function auditActionLabel(a: string): string {
    switch (a) {
      case "session.signin":
        return m.audit_action_session_signin();
      case "session.signout":
        return m.audit_action_session_signout();
      case "session.signout_all":
        return m.audit_action_session_signout_all();
      case "user.signup":
        return m.audit_action_user_signup();
      case "key.add":
        return m.audit_action_key_add();
      case "key.rotate":
        return m.audit_action_key_rotate();
      case "key.remove":
        return m.audit_action_key_remove();
      case "game.created":
        return m.audit_action_game_created();
      case "game.deleted":
        return m.audit_action_game_deleted();
      case "game.restored":
        return m.audit_action_game_restored();
      case "event.created":
        return m.audit_action_event_created();
      case "event.edited":
        return m.audit_action_event_edited();
      case "event.deleted":
        return m.audit_action_event_deleted();
      case "event.attached_to_game":
        return m.audit_action_event_attached_to_game();
      case "event.detached_from_game":
        return m.audit_action_event_detached_from_game();
      case "event.dismissed_from_inbox":
        return m.audit_action_event_dismissed_from_inbox();
      case "event.restored":
        return m.audit_action_event_restored();
      case "event.marked_standalone":
        return m.audit_action_event_marked_standalone();
      case "event.unmarked_standalone":
        return m.audit_action_event_unmarked_standalone();
      case "source.added":
        return m.audit_action_source_added();
      case "source.removed":
        return m.audit_action_source_removed();
      case "source.toggled_auto_import":
        return m.audit_action_source_toggled_auto_import();
      case "theme.changed":
        return m.audit_action_theme_changed();
      // Phase 02.2 (D-11 / D-16) — see AuditRow.svelte for the lock-step
      // contract; same 4 verbs land here for the /audit chip strip reuse.
      case "account.deleted":
        return m.audit_action_account_deleted();
      case "account.restored":
        return m.audit_action_account_restored();
      case "account.exported":
        return m.audit_action_account_exported();
      case "quota.limit_hit":
        return m.audit_action_quota_limit_hit();
      default:
        return a;
    }
  }

  type Chip = { axis: ChipAxis; label: string; ariaName: string; key: string };
  const chips = $derived.by((): Chip[] => {
    const out: Chip[] = [];

    // Plan 02.1-21: each axis emits a chip only when the consumer's schema
    // includes it. Replaces Plan 02.1-20's implicit gate (was: action
    // presence on filters). /audit passes schema=['action','date'] so
    // /feed-only axes (kind/source/show/authorIsMe) don't leak into the
    // audit chip strip even if filters carries default values for them.

    // Kind axis — one chip with comma-joined value labels.
    if (schema.includes("kind") && filters.kind.length > 0) {
      const labels = filters.kind.map(kindLabel).join(", ");
      const label = `${m.feed_chip_axis_kind()}: ${labels}`;
      out.push({ axis: "kind", label, ariaName: label, key: "axis:kind" });
    }

    // Source axis — one chip with comma-joined display names.
    if (schema.includes("source") && filters.source.length > 0) {
      const labels = filters.source
        .map((id) => {
          const s = sources.find((x) => x.id === id);
          return s ? (s.displayName ?? s.handleUrl) : id;
        })
        .join(", ");
      const label = `${m.feed_chip_axis_source()}: ${labels}`;
      out.push({ axis: "source", label, ariaName: label, key: "axis:source" });
    }

    // Show axis (merged from old game + attached).
    if (schema.includes("show")) {
      if (filters.show.kind === "inbox") {
        const label = `${m.feed_chip_axis_show()}: ${m.feed_filter_show_inbox()}`;
        out.push({ axis: "show", label, ariaName: label, key: "axis:show:inbox" });
      } else if (filters.show.kind === "standalone") {
        // Plan 02.1-24: standalone triage state chip.
        const label = `${m.feed_chip_axis_show()}: ${m.feed_filter_show_standalone()}`;
        out.push({ axis: "show", label, ariaName: label, key: "axis:show:standalone" });
      } else if (filters.show.kind === "specific" && filters.show.gameIds.length > 0) {
        const labels = filters.show.gameIds
          .map((id) => {
            const g = games.find((x) => x.id === id);
            return g ? g.title : id;
          })
          .join(", ");
        const label = `${m.feed_chip_axis_show()}: ${labels}`;
        out.push({ axis: "show", label, ariaName: label, key: "axis:show:specific" });
      }
      // show.kind === "any": no chip (default).
    }

    // Author axis — single value, kept as-is.
    if (schema.includes("authorIsMe")) {
      if (filters.authorIsMe === true) {
        const label = m.feed_filter_author_me();
        out.push({ axis: "authorIsMe", label, ariaName: label, key: "authorIsMe:true" });
      } else if (filters.authorIsMe === false) {
        const label = m.feed_filter_author_others();
        out.push({ axis: "authorIsMe", label, ariaName: label, key: "authorIsMe:false" });
      }
    }

    // Action axis (used by /audit). One chip with comma-joined translated
    // labels. /feed never passes 'action' in its schema so this branch is
    // dormant on /feed.
    if (schema.includes("action") && (filters.action?.length ?? 0) > 0) {
      const labels = filters.action!.map(auditActionLabel).join(", ");
      const label = `${m.feed_chip_axis_action()}: ${labels}`;
      out.push({ axis: "action", label, ariaName: label, key: "axis:action" });
    }

    // Plan 02.1-19/21: NO date-range chip emission. The visible from/to
    // inputs in <DateRangeControl> ARE the indicator. Duplication is
    // confusing (UAT round-2 gap "FilterChips MUST NOT emit any chip for
    // date range"). 'date' may appear in schema (it does on /audit and
    // /feed) but the chip strip stays silent on it.
    return out;
  });

  const activeCount = $derived(chips.length);
</script>

<div class="filter-row">
  {#if activeCount > 0}
    <!-- Inline chip strip — visible at >= 600px via CSS media query. -->
    <div class="chips" aria-label="Active filters">
      {#each chips as chip (chip.key)}
        <span class="chip">
          <button
            type="button"
            class="chip-label"
            aria-pressed="true"
            onclick={() => onOpenSheet(chip.axis)}
          >
            {chip.label}
          </button>
          <button
            type="button"
            class="chip-dismiss"
            aria-label={m.feed_filter_chip_dismiss_aria({ filter: chip.ariaName })}
            onclick={() => onDismiss(chip.axis)}
          >
            ×
          </button>
        </span>
      {/each}
      <button type="button" class="clear-all" onclick={onClearAll}>
        {m.feed_filters_clear_all()}
      </button>
    </div>
  {/if}

  <!-- Sheet trigger — always visible so users can discover and add filters. -->
  <button type="button" class="sheet-trigger" onclick={() => onOpenSheet()}>
    Filters{activeCount > 0 ? ` (${activeCount})` : ""}
  </button>
</div>

<style>
  .filter-row {
    display: flex;
    gap: var(--space-sm);
  }
  .chips {
    display: none;
    flex-wrap: wrap;
    gap: var(--space-sm);
    align-items: center;
    flex: 1 1 auto;
    min-width: 0;
  }
  .sheet-trigger {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  /* Chips inline at >= 600px. Sheet trigger stays visible at all widths so
   * users can always open the full filter sheet (date range, etc.) — chips
   * alone only let users dismiss already-applied filters. */
  @media (min-width: 600px) {
    .chips {
      display: flex;
    }
  }
  .chip {
    display: inline-flex;
    align-items: center;
    background: var(--color-surface);
    border: 1px solid var(--color-text);
    border-radius: 999px;
    padding: 0 var(--space-xs) 0 var(--space-sm);
    font-size: var(--font-size-label);
    line-height: 1;
    /* Plan 02.1-19: chip text wraps inside the chip when natural width
     * exceeds the strip. No '+N more' truncation. */
    max-width: 100%;
    min-width: 0;
    word-break: break-word;
  }
  .chip-label {
    background: transparent;
    color: var(--color-text);
    border: none;
    padding: var(--space-xs) var(--space-xs);
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
    white-space: normal;
    text-align: left;
  }
  .chip-dismiss {
    min-width: 44px;
    min-height: 44px;
    background: transparent;
    color: var(--color-text-muted);
    border: none;
    cursor: pointer;
    font-size: var(--font-size-body);
    line-height: 1;
    border-radius: 999px;
    flex-shrink: 0;
  }
  .chip-dismiss:hover {
    color: var(--color-text);
  }
  .clear-all {
    background: transparent;
    color: var(--color-text-muted);
    border: none;
    text-decoration: underline;
    font-size: var(--font-size-label);
    cursor: pointer;
    padding: var(--space-xs) var(--space-sm);
  }
  .clear-all:hover {
    color: var(--color-text);
  }
</style>
