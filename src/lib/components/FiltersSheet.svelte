<script lang="ts">
  // FiltersSheet — mobile-only <dialog>-based bottom-sheet filter UX
  // (UI-SPEC §"Component inventory" + §"/feed filter row — chips → sheet
  // pattern"; Plan 02.1-19 reshape over Plan 02.1-15).
  // Triggered by the FilterChips "Filters (N)" button.
  //
  // Native <dialog> + showModal() gives focus-trap + Esc-to-close out of
  // the box. Mirrors the ConfirmDialog pattern.
  //
  // Plan 02.1-19 changes (round-2 UAT):
  //   - Game checkbox-list + Attached radio MERGE into one "Show" 3-radio
  //     (Any / Inbox only / Attached to games). Picking "Attached to games"
  //     reveals the games multi-select; the conflict between
  //     "Attached=Inbox AND Game=X" is impossible by construction (UI guard).
  //   - onApply payload: replaces { game?, attached? } with
  //     { show: { kind: 'any' | 'inbox' | 'specific'; gameIds? } }.
  //
  // Plan 02.1-15 carry-over:
  //   - source / kind become checkbox LISTS (multi-select per Gap 4).
  //   - source + game lists carry a typeahead `<input type="search">` so a
  //     long source/game list stays scannable.
  //   - from / to date inputs are owned by <DateRangeControl> above the
  //     chip strip on /feed (Gap 10).
  //
  // Plan 02.1-21 changes (round-3 UAT closure for §9.2-bug):
  //   - REQUIRED `schema: ReadonlyArray<FilterAxis>` prop replaces Plan
  //     02.1-20's implicit axis-detection (was: filters.action presence as
  //     the gate). /feed passes ['kind','source','show','authorIsMe','date'];
  //     /audit passes ['action','date']. Each fieldset is gated on
  //     `schema.includes('axisName')` so the rendered surface mirrors the
  //     consumer's intent exactly.
  //   - New 'date' axis fieldset (two date inputs) renders when
  //     schema.includes('date'). /feed and /audit both keep <DateRangeControl>
  //     ABOVE the chip strip as the always-visible primary entry; the
  //     in-sheet date fieldset is the secondary entry for users opening the
  //     sheet from a chip click.

  import { m } from "$lib/paraglide/messages.js";
  import { sortByLabel } from "$lib/util/sort-kinds.js";
  // Plan 02.1-39 (UAT-NOTES.md §5.6): source list shows a kind glyph + short
  // kind label adjacent to displayName. Reuses SourceKindIcon (Plan 02.1-08)
  // and the shared sourceKindLabel helper (Plan 02.1-39 — extracted from
  // SourceRow). Round-5 UAT user quote: "вижу в фильтрах источники.
  // Хотелось бы еще там видеть тип источника(ютуб)".
  import SourceKindIcon from "./SourceKindIcon.svelte";
  import {
    sourceKindLabel,
    type SourceKind as DataSourceKind,
  } from "$lib/util/source-kind-label.js";

  type ShowFilter =
    | { kind: "any" }
    | { kind: "inbox" }
    | { kind: "standalone" }
    | { kind: "specific"; gameIds: string[] };

  // Plan 02.1-21: explicit axis enumeration. Each consumer page passes the
  // subset it wants rendered; FiltersSheet renders ONLY axes in `schema`.
  type FilterAxis = "kind" | "source" | "show" | "authorIsMe" | "date" | "action";

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
    // populate it. Plan 02.1-21: axis rendering is now driven by `schema`,
    // not by the presence of this field. The field is still a string[]
    // so the action checkbox state can survive a re-render.
    action?: string[];
  };
  // Plan 02.1-39 (UAT-NOTES.md §5.6): kind extends SourceOption so the
  // source-list rendering can show a kind glyph + short label adjacent to
  // displayName, AND so the typeahead filter matches against the kind label.
  // The DataSourceDto already exposes kind (src/lib/server/dto.ts:217); the
  // /feed loader maps it through (verified at plan time — see below).
  type SourceOption = {
    id: string;
    displayName: string | null;
    handleUrl: string;
    kind: DataSourceKind;
  };
  type GameOption = { id: string; title: string };

  let {
    filters,
    sources,
    games,
    focusAxis,
    schema,
    onApply,
    onClose,
  }: {
    filters: ActiveFilters;
    sources: SourceOption[];
    games: GameOption[];
    focusAxis?: FilterAxis;
    // Plan 02.1-21: REQUIRED — consumer pages opt in to each axis explicitly.
    // /feed passes ['kind','source','show','authorIsMe','date']; /audit
    // passes ['action','date']. Replaces Plan 02.1-20's implicit gate.
    schema: ReadonlyArray<FilterAxis>;
    onApply: (next: {
      source?: string[];
      kind?: string[];
      show?: ShowFilter;
      authorIsMe?: boolean;
      // Plan 02.1-21: date axis applied via this payload when 'date' is in
      // the schema. /feed continues to use <DateRangeControl> (date params
      // still flow via that path); the sheet's date inputs are a secondary
      // entry that emits the same shape.
      from?: string;
      to?: string;
      // Plan 02.1-20 carry-over: action axis emitted when schema includes it.
      action?: string[];
    }) => void;
    onClose: () => void;
  } = $props();

  let dialogEl: HTMLDialogElement | null = $state(null);

  // Track checkbox-list selections via Set<string> — toggle reassigns the
  // state ref (immutable update) so $derived(filteredSources) and the
  // checkbox `checked` bindings recompute.
  let sourceSelected = $state<Set<string>>(new Set(filters.source ?? []));
  let kindSelected = $state<Set<string>>(new Set(filters.kind ?? []));
  let showSelection = $state<"any" | "inbox" | "standalone" | "specific">(filters.show.kind);
  let gameSelected = $state<Set<string>>(
    filters.show.kind === "specific" ? new Set(filters.show.gameIds) : new Set(),
  );
  let sourceTypeahead = $state("");
  let gameTypeahead = $state("");

  let authorIsMe = $state<"any" | "true" | "false">(
    filters.authorIsMe === true ? "true" : filters.authorIsMe === false ? "false" : "any",
  );

  // Plan 02.1-20: action axis state (used by /audit). /feed leaves
  // filters.action undefined so this Set stays empty.
  // Plan 02.1-21: rendering gate moved to schema.includes('action').
  let actionSelected = $state<Set<string>>(new Set(filters.action ?? []));

  // Plan 02.1-21: in-sheet date axis (secondary entry; <DateRangeControl>
  // above the chip strip is the primary always-visible entry). Local state
  // mirrors the loader-supplied values so users can edit + Apply.
  let fromVal = $state<string>(filters.from ?? "");
  let toVal = $state<string>(filters.to ?? "");

  // Plan 02.1-20: functional-only allowlist + alphabetical-by-label sort.
  // Mirrors the /events/new picker — same allowlist, same sort. Hidden
  // kinds (reddit_post / twitter_post / telegram_post / discord_drop)
  // re-appear when their Phase 3+ adapter ships. Legacy rows of hidden
  // kinds still render via FilterChips' kindLabel switch (preserved — no
  // change to FilterChips kind cases).
  const FUNCTIONAL_KIND_OPTIONS: ReadonlyArray<string> = [
    "youtube_video",
    "post",
    "conference",
    "talk",
    "press",
    "other",
  ];
  const KIND_OPTIONS = $derived(
    sortByLabel(FUNCTIONAL_KIND_OPTIONS, (k) => kindLabel(k)),
  );

  // Plan 02.1-20: AUDIT_ACTIONS mirror for the /audit reuse. Inlined to keep
  // this client-side component out of server modules. Drift caught by
  // tests/integration/audit-render.test.ts (Task 5) which iterates AUDIT_ACTIONS
  // and asserts the rendered fieldset has one checkbox per action.
  const AUDIT_ACTIONS_MIRROR = [
    "session.signin",
    "session.signout",
    "session.signout_all",
    "user.signup",
    "key.add",
    "key.rotate",
    "key.remove",
    "game.created",
    "game.deleted",
    "game.restored",
    "event.created",
    "event.edited",
    "event.deleted",
    "event.attached_to_game",
    "event.detached_from_game",
    "event.dismissed_from_inbox",
    "event.restored",
    "event.marked_standalone",
    "event.unmarked_standalone",
    "source.added",
    "source.removed",
    "source.toggled_auto_import",
    "theme.changed",
  ] as const;

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
      default:
        return a;
    }
  }

  const ACTION_OPTIONS = $derived(
    sortByLabel(AUDIT_ACTIONS_MIRROR, (a) => auditActionLabel(a)),
  );

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
      case "post":
        return m.event_kind_label_post();
      default:
        return m.event_kind_label_other();
    }
  }

  // Plan 02.1-39 (UAT-NOTES.md §5.6): typeahead also matches against the
  // localized kind label so a search for "youtube" / "ютуб" surfaces every
  // YouTube source even when displayName / handleUrl don't contain that
  // literal substring.
  const filteredSources = $derived(
    sources.filter((s) => {
      if (sourceTypeahead === "") return true;
      const q = sourceTypeahead.toLowerCase();
      return (
        (s.displayName ?? s.handleUrl).toLowerCase().includes(q) ||
        sourceKindLabel(s.kind).toLowerCase().includes(q)
      );
    }),
  );
  const filteredGames = $derived(
    games.filter(
      (g) =>
        gameTypeahead === "" ||
        g.title.toLowerCase().includes(gameTypeahead.toLowerCase()),
    ),
  );

  $effect(() => {
    if (dialogEl && !dialogEl.open) {
      dialogEl.showModal();
      // Plan 02.1-34 (UAT-NOTES.md §4.22.F regression fix): the imperative
      // document.body.style.overflow = 'hidden' approach Plan 02.1-22 used
      // here regressed — Svelte 5 $effect cleanup timing was unreliable AND
      // nested ConfirmDialog instances could overwrite the inline style
      // back to ''. The body-scroll-lock is now declarative via
      // `body:has(dialog[open]) { overflow: hidden; }` in src/app.css —
      // the browser engine applies it the moment any <dialog open> exists
      // and self-restores when none does. No JS state to manage here.
      //
      // Plan 02.1-19: focus-jump support — when chip click opens the sheet
      // with a specific axis hint, scroll its fieldset into view + focus
      // the first interactive control. Lightweight UX nice-to-have.
      if (focusAxis) {
        queueMicrotask(() => {
          const el = dialogEl?.querySelector<HTMLElement>(
            `[data-axis="${focusAxis}"]`,
          );
          if (el) {
            el.scrollIntoView({ block: "nearest" });
            const firstControl = el.querySelector<HTMLElement>(
              "input, button, select, textarea",
            );
            firstControl?.focus();
          }
        });
      }
    }
  });

  function onDialogCancel(e: Event): void {
    e.preventDefault();
    // Plan 02.1-34: body-scroll lock is declarative (CSS :has(dialog[open]))
    // — no imperative restore needed on Esc/backdrop close.
    onClose();
  }

  function toggle(set: Set<string>, value: string): Set<string> {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  }

  function applyAll(): void {
    const showResult: ShowFilter =
      showSelection === "any"
        ? { kind: "any" }
        : showSelection === "inbox"
          ? { kind: "inbox" }
          : showSelection === "standalone"
            ? { kind: "standalone" }
            : { kind: "specific", gameIds: Array.from(gameSelected) };
    // Plan 02.1-21: emit each axis only when the consumer's schema includes
    // it. The consumer page maps the apply payload back to URL params; an
    // omitted key means "this consumer doesn't own this axis".
    const payload: {
      source?: string[];
      kind?: string[];
      show?: ShowFilter;
      authorIsMe?: boolean;
      from?: string;
      to?: string;
      action?: string[];
    } = {};
    if (schema.includes("source")) payload.source = Array.from(sourceSelected);
    if (schema.includes("kind")) payload.kind = Array.from(kindSelected);
    if (schema.includes("show")) payload.show = showResult;
    if (schema.includes("authorIsMe")) {
      payload.authorIsMe = authorIsMe === "any" ? undefined : authorIsMe === "true";
    }
    if (schema.includes("date")) {
      if (fromVal) payload.from = fromVal;
      if (toVal) payload.to = toVal;
    }
    if (schema.includes("action")) payload.action = Array.from(actionSelected);
    onApply(payload);
  }

  function clearAll(): void {
    // Plan 02.1-21: clearAll preserves the schema-presence contract. Each
    // axis the consumer owns is reset to its empty form; axes the consumer
    // does NOT own are omitted from the payload entirely.
    const payload: {
      source?: string[];
      kind?: string[];
      show?: ShowFilter;
      authorIsMe?: boolean;
      from?: string;
      to?: string;
      action?: string[];
    } = {};
    if (schema.includes("source")) payload.source = [];
    if (schema.includes("kind")) payload.kind = [];
    if (schema.includes("show")) payload.show = { kind: "any" };
    if (schema.includes("authorIsMe")) payload.authorIsMe = undefined;
    if (schema.includes("date")) {
      // Empty strings clear the date axis; the consumer maps this to
      // ?all=1 on /feed (opt-out of the 30-day default) or to no params
      // on /audit (no date constraint).
      payload.from = undefined;
      payload.to = undefined;
    }
    if (schema.includes("action")) payload.action = [];
    onApply(payload);
  }
</script>

<dialog
  bind:this={dialogEl}
  class="sheet"
  oncancel={onDialogCancel}
  aria-labelledby="filters-sheet-heading"
>
  <h2 id="filters-sheet-heading" class="heading">Filters</h2>

  <div class="grid">
    <!-- Plan 02.1-21: each fieldset is gated on schema.includes(axis).
         Replaces Plan 02.1-20's implicit filters.action-detection. -->
    {#if schema.includes("source")}
      <fieldset class="field" data-axis="source">
        <legend class="label">Source</legend>
        <input
          type="search"
          class="input"
          placeholder="Filter sources…"
          bind:value={sourceTypeahead}
        />
        <div class="checklist">
          {#each filteredSources as s (s.id)}
            <!-- Plan 02.1-39 (UAT-NOTES.md §5.6): kind glyph + label appear
                 BEFORE the displayName so users can scan the source list at
                 a glance. Mirrors SourceRow's existing kind-tag pattern from
                 Plan 02.1-25 — same SourceKindIcon + same sourceKindLabel
                 helper for visual + textual consistency. -->
            <label class="check">
              <input
                type="checkbox"
                checked={sourceSelected.has(s.id)}
                onchange={() => (sourceSelected = toggle(sourceSelected, s.id))}
              />
              <span class="source-kind-tag">
                <SourceKindIcon kind={s.kind} />
                <span class="source-kind-label">{sourceKindLabel(s.kind)}</span>
              </span>
              <span class="source-name">{s.displayName ?? s.handleUrl}</span>
            </label>
          {/each}
        </div>
      </fieldset>
    {/if}

    {#if schema.includes("kind")}
      <fieldset class="field" data-axis="kind">
        <legend class="label">Kind</legend>
        <div class="checklist">
          {#each KIND_OPTIONS as k (k)}
            <label class="check">
              <input
                type="checkbox"
                checked={kindSelected.has(k)}
                onchange={() => (kindSelected = toggle(kindSelected, k))}
              />
              {kindLabel(k)}
            </label>
          {/each}
        </div>
      </fieldset>
    {/if}

    <!-- Plan 02.1-19: Game checkbox-list + Attached radio MERGED into a
         single Show 3-radio with a conditional games multi-select. The
         conflict between "Inbox AND specific games" is impossible by
         construction. -->
    {#if schema.includes("show")}
      <fieldset class="field" data-axis="show">
        <legend class="label">{m.feed_filter_show_axis_label()}</legend>
        <label class="toggle">
          <input type="radio" name="show" value="any" bind:group={showSelection} />
          {m.feed_filter_show_any()}
        </label>
        <label class="toggle">
          <input type="radio" name="show" value="inbox" bind:group={showSelection} />
          {m.feed_filter_show_inbox()}
        </label>
        <label class="toggle">
          <input type="radio" name="show" value="standalone" bind:group={showSelection} />
          {m.feed_filter_show_standalone()}
        </label>
        <label class="toggle">
          <input type="radio" name="show" value="specific" bind:group={showSelection} />
          {m.feed_filter_show_specific()}
        </label>

        {#if showSelection === "specific"}
          <input
            type="search"
            class="input"
            placeholder="Filter games…"
            bind:value={gameTypeahead}
          />
          <div class="checklist">
            {#each filteredGames as g (g.id)}
              <label class="check">
                <input
                  type="checkbox"
                  checked={gameSelected.has(g.id)}
                  onchange={() => (gameSelected = toggle(gameSelected, g.id))}
                />
                {g.title}
              </label>
            {/each}
          </div>
        {/if}
      </fieldset>
    {/if}

    {#if schema.includes("authorIsMe")}
      <fieldset class="field" data-axis="authorIsMe">
        <legend class="label">Author</legend>
        <label class="toggle">
          <input type="radio" name="author" value="any" bind:group={authorIsMe} /> Any
        </label>
        <label class="toggle">
          <input type="radio" name="author" value="true" bind:group={authorIsMe} />
          {m.feed_filter_author_me()}
        </label>
        <label class="toggle">
          <input type="radio" name="author" value="false" bind:group={authorIsMe} />
          {m.feed_filter_author_others()}
        </label>
      </fieldset>
    {/if}

    <!-- Plan 02.1-21: in-sheet date axis. Secondary entry; the always-
         visible <DateRangeControl> above the chip strip is the primary one. -->
    {#if schema.includes("date")}
      <fieldset class="field" data-axis="date">
        <legend class="label">{m.audit_filter_date_axis_label()}</legend>
        <label class="input-wrap">
          <span class="input-label">{m.feed_date_range_label_from()}</span>
          <input
            type="date"
            class="input"
            bind:value={fromVal}
            max={toVal || undefined}
          />
        </label>
        <label class="input-wrap">
          <span class="input-label">{m.feed_date_range_label_to()}</span>
          <input
            type="date"
            class="input"
            bind:value={toVal}
            min={fromVal || undefined}
          />
        </label>
      </fieldset>
    {/if}

    {#if schema.includes("action")}
      <fieldset class="field" data-axis="action">
        <legend class="label">{m.audit_filter_action_axis_label()}</legend>
        <div class="checklist">
          {#each ACTION_OPTIONS as a (a)}
            <label class="check">
              <input
                type="checkbox"
                checked={actionSelected.has(a)}
                onchange={() => (actionSelected = toggle(actionSelected, a))}
              />
              {auditActionLabel(a)}
            </label>
          {/each}
        </div>
      </fieldset>
    {/if}
  </div>

  <div class="actions">
    <button type="button" class="cancel" onclick={onClose}>
      {m.common_cancel()}
    </button>
    <button type="button" class="secondary" onclick={clearAll}>
      {m.feed_filters_clear_all()}
    </button>
    <button type="button" class="primary" onclick={applyAll}>
      {m.feed_filters_apply()}
    </button>
  </div>
</dialog>

<style>
  .sheet {
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: var(--space-lg);
    width: min(560px, calc(100vw - 2 * var(--space-md)));
    max-height: 90vh;
    overflow-y: auto;
  }
  .sheet::backdrop {
    background: rgb(0 0 0 / 50%);
  }
  .heading {
    margin: 0 0 var(--space-md) 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
  }
  .grid {
    display: grid;
    gap: var(--space-md);
    grid-template-columns: 1fr;
  }
  @media (min-width: 480px) {
    .grid {
      grid-template-columns: 1fr 1fr;
    }
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    border: none;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
  .label {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    font-weight: var(--font-weight-semibold);
  }
  .input {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
  }
  /* Plan 02.1-21: in-sheet date axis label/input pair. */
  .input-wrap {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }
  .input-label {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .checklist {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    max-height: 220px;
    overflow-y: auto;
    padding: var(--space-xs);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-bg);
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    font-size: var(--font-size-label);
    min-height: 32px;
    cursor: pointer;
  }
  /* Plan 02.1-39 (UAT-NOTES.md §5.6): source row layout. The kind glyph +
   * short kind label sit before the displayName so the visual hierarchy
   * reads "▶ YouTube channel · Cool Channel Name". Mirrors SourceRow's
   * existing kind-tag treatment for cross-surface consistency. */
  .source-kind-tag {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    color: var(--color-text);
  }
  .source-kind-label {
    font-weight: var(--font-weight-semibold);
    color: var(--color-text-muted);
  }
  .source-name {
    color: var(--color-text);
    word-break: break-word;
    min-width: 0;
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    font-size: var(--font-size-label);
    min-height: 44px;
  }
  .actions {
    display: flex;
    gap: var(--space-sm);
    justify-content: flex-end;
    margin-top: var(--space-lg);
    flex-wrap: wrap;
  }
  .cancel,
  .secondary,
  .primary {
    min-height: 44px;
    padding: 0 var(--space-md);
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .cancel,
  .secondary {
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }
  .primary {
    background: var(--color-accent);
    color: var(--color-accent-text);
    border: none;
  }
</style>
