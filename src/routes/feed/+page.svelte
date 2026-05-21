<script lang="ts">
  // /feed — primary daily workspace orchestrator (Phase 03.4 Wave 3 Plan 10).
  //
  // Composition map:
  //   - <PageHead>      (Plan 07) title + Add Event CTA + search + Filters toggle
  //     ↳ children slot: <DateRangeRow> (Plan 07)
  //   - <ActiveFiltersStrip> (Plan 07) chips for active filters
  //   - {#if filtersOpen} <AxisRow ×4> + <FindRow> (Plan 07)
  //   - <FeedDateGroupHeader> + <FeedCard> grid (Plan 08 — long-press + sweep)
  //   - <EventDetailModal> (Plan 09) mounted on data.openEventId
  //   - <AddEventModal> (Plan 09) mounted on local addEventModalOpen state
  //   - <GamesPicker> (Plan 08) single instance — bulk via BulkActionBar AND
  //     single via FeedCard ⋯ menu
  //   - <BulkActionBar> (Plan 08) sticky bottom — Restore/Delete-forever variant
  //     when view=trash
  //   - <Toast> success surfaces for bulk + add event
  //   - <RecoveryDialog> legacy modal — kept on live view; trash view replaces
  //     it with the rows themselves
  //
  // URL state contract: every filter mutation rebuilds the URL via
  // serializeFilterState + goto(url, { keepFocus, noScroll, invalidateAll:
  // false }). SvelteKit's loader re-runs on URL change; we never call
  // invalidateAll() for filter changes (the URL change IS the invalidation
  // signal). Bulk operations DO call invalidateAll() after the fetch
  // resolves because they mutate the server state without changing the URL
  // (RESEARCH Pitfall 2).
  //
  // Selection state lives in $feedUiStore (ephemeral per-session). Gmail
  // sweep behavior is owned by <FeedCard> — once anySelected is true, ANY
  // card-surface click toggles selection instead of opening detail. The
  // store is the single source of truth; the orchestrator just reads
  // $feedUiStore.selectedIds.
  //
  // Trash banner: when data.view === "trash", a banner persists at the top
  // of the page + BulkActionBar swaps to Restore/Delete-forever per D-19.
  // The trash view reuses the same filter axes (kind/source/show/from/to)
  // because listFeedPage(scope=trash) accepts them.
  //
  // Modal vs route dual-render (D-05): /events/[id] renders
  // <EventDetailContent> as a thin route (Plan 10 Task 3). The /feed
  // orchestrator mounts the same content via <EventDetailModal> when
  // ?event= is set. Both surfaces close to /feed (with the modal also
  // dropping ?event= from the URL).
  //
  // LB invariants preserved through composition:
  //   - LB-1 (single sticky chrome wrapper) — handled by +layout.svelte
  //   - LB-2 (PageHeader resize publish) — PageHead reimplements
  //   - LB-3 (FeedDateGroupHeader sticky math) — uses PageHead's published
  //     --page-header-height
  //   - LB-7 (body scroll lock on <dialog>) — app.css :has() rule
  //   - LB-9 (groupEventsByDate util reuse) — preserved
  //   - LB-10 (Filters toggle expanded/collapsed) — PageHead.activeFilterCount
  //   - LB-12 (data-testid="feed-card" attribute) — preserved by FeedCard

  import { goto, invalidateAll } from "$app/navigation";
  import { page, navigating } from "$app/state";
  import { m } from "$lib/paraglide/messages.js";

  import {
    parseSearchParams,
    serializeFilterState,
    type FilterState,
    type DateRangeFilter,
  } from "$lib/feed/url-state.js";
  import {
    passes,
    countWithGame,
    countWithKind,
    countWithShow,
    countWithAuthor,
  } from "$lib/feed/filter-math.js";
  import { parseEventDate } from "$lib/feed/date-range.js";
  import {
    feedUiStore,
    toggleSelect,
    clearSelection,
    setFiltersOpen,
  } from "$lib/stores/feed-ui.js";

  import PageHead from "$lib/components/feed/PageHead.svelte";
  import DateRangeRow from "$lib/components/feed/DateRangeRow.svelte";
  import ActiveFiltersStrip, {
    type AxisChip,
  } from "$lib/components/feed/ActiveFiltersStrip.svelte";
  import AxisRow from "$lib/components/feed/AxisRow.svelte";
  import FindRow from "$lib/components/feed/FindRow.svelte";
  import FeedCard from "$lib/components/FeedCard.svelte";
  import BulkActionBar from "$lib/components/feed/BulkActionBar.svelte";
  import GamesPicker from "$lib/components/feed/GamesPicker.svelte";
  import EventDetailModal from "$lib/components/event-detail/EventDetailModal.svelte";
  import AddEventModal from "$lib/components/add-event/AddEventModal.svelte";
  import Toast from "$lib/components/shared/Toast.svelte";
  import FeedDateGroupHeader from "$lib/components/FeedDateGroupHeader.svelte";
  import RecoveryDialog from "$lib/components/RecoveryDialog.svelte";
  import { getCardComponent } from "$lib/sources/registry-ui-client.js";
  import { groupEventsByDate } from "$lib/util/group-events-by-date.js";

  import type { ShowFilter } from "$lib/server/services/events.js";
  import type { EventKind } from "$lib/sources/adapter.js";
  import type { AddEventPayload } from "$lib/components/add-event/AddEventForm.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  // 1. URL state. $derived re-runs whenever page.url changes (SvelteKit
  // updates the URL on goto). parseSearchParams is the single source of
  // truth — the loader uses the same function.
  let urlState = $derived(parseSearchParams(page.url));

  // 2. Server-provided TODAY (D-24). The loader picks one instant per
  // request; the client threads it through every date helper so SSR + CSR
  // agree.
  let today = $derived(parseEventDate(data.today) ?? new Date());

  // 3. Selection + filtersOpen + eventDetail subscribed from the store.
  let storeState = $derived($feedUiStore);
  let selectedIds = $derived(storeState.selectedIds);
  let anySelected = $derived(selectedIds.size > 0);
  let filtersOpen = $derived(storeState.filtersOpen);

  // Body data-selection attribute drives the always-visible card-select
  // checkbox opacity in FeedCard's CSS (`:global(body[data-selection="1"])
  // .card-select { opacity: 1 }`). The attribute publish via $effect runs
  // only in the browser (typeof window guard); SSR renders without it,
  // hydration assigns when JS boots.
  $effect(() => {
    if (typeof document === "undefined") return;
    document.body.dataset.selection = anySelected ? "1" : "0";
  });

  // 4. Local modal state (NOT in URL — modals are session-only).
  let openEventId = $derived(urlState.openEventId); // URL-bound for deep linking
  let addEventModalOpen = $state(false);
  let gamesPickerOpen = $state(false);
  let gamesPickerMode = $state<"single" | "bulk">("bulk");
  let gamesPickerTargetIds = $state<string[]>([]);
  let toast = $state<{ kind: "success" | "info" | "danger"; text: string } | null>(null);

  // 5. RecoveryDialog state (legacy on live view; trash view doesn't use it).
  let recoveryOpen = $state(false);
  const recoveryItems = $derived(
    data.deletedEvents.map((ev) => ({
      id: ev.id,
      name: ev.title,
      deletedAt: ev.deletedAt,
    })),
  );

  // 6. Trash view conditional.
  let trashView = $derived(data.view === "trash");

  // 7. URL mutation helper. invalidateAll: false because the URL change
  // itself triggers SvelteKit to re-run the loader.
  function pushUrl(nextState: FilterState, replace = false): void {
    const sp = serializeFilterState(nextState);
    const qs = sp.toString();
    const url = "/feed" + (qs ? "?" + qs : "");
    void goto(url, {
      keepFocus: true,
      noScroll: true,
      replaceState: replace,
      invalidateAll: false,
    });
  }

  // 8. Per-axis URL mutation handlers — each builds a new FilterState
  // (preserving every other axis) and pushes through pushUrl. Cursor is
  // cleared on every filter change so the fresh first page renders.
  function setShow(next: ShowFilter): void {
    pushUrl({ ...urlState, show: next, cursor: undefined });
  }
  function setKind(next: EventKind[]): void {
    pushUrl({ ...urlState, kind: next, cursor: undefined });
  }
  function setSource(next: string[]): void {
    pushUrl({ ...urlState, source: next, cursor: undefined });
  }
  function setAuthorIsMe(next: boolean | undefined): void {
    pushUrl({ ...urlState, authorIsMe: next, cursor: undefined });
  }
  function setDateRange(next: DateRangeFilter): void {
    pushUrl({ ...urlState, dateRange: next, cursor: undefined });
  }
  function setSortDir(next: "asc" | "desc"): void {
    pushUrl({ ...urlState, sortDir: next, cursor: undefined });
  }
  function setQuery(next: string): void {
    // Search uses replaceState so the back button doesn't have one history
    // entry per keystroke (RESEARCH Pitfall 3 — debounce is a follow-up
    // polish; replaceState alone is sufficient for the back-button UX).
    pushUrl({ ...urlState, query: next, cursor: undefined }, true);
  }
  function clearAllFilters(): void {
    pushUrl({
      ...urlState,
      show: { kind: "any" },
      kind: [],
      source: [],
      authorIsMe: undefined,
      dateRange: { preset: "all" },
      query: "",
      cursor: undefined,
    });
  }

  // 9. EventDetailModal URL handlers.
  function openDetail(id: string): void {
    pushUrl({ ...urlState, openEventId: id });
  }
  function closeDetail(): void {
    pushUrl({ ...urlState, openEventId: null });
  }

  // 10. Selection store mutations — toggleSelect / clearSelection are
  // imported from the store module so the store is the single source of
  // truth (the component just emits the mutation).
  function onToggleSelect(id: string, force?: boolean): void {
    toggleSelect(id, force);
  }

  // 11. Bulk operations. Each fetches against /api/events/bulk then runs
  // invalidateAll() so the loader refetches the feed (RESEARCH Pitfall 2 —
  // without the explicit invalidateAll, the URL hasn't changed and the
  // loader sits with stale rows). Toast surfaces success; clearSelection
  // resets the chip state.
  async function doBulkPatch(payload: {
    gameStates: Record<string, "on" | "off" | "mixed">;
    offTopicState: "on" | "off" | "mixed";
  }): Promise<void> {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const res = await fetch("/api/events/bulk", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids, ...payload }),
    });
    if (res.ok) {
      const body = (await res.json()) as { affected_count: number };
      toast = {
        kind: "success",
        text: m.toast_bulk_edit_success({ count: String(body.affected_count) }),
      };
      clearSelection();
      gamesPickerOpen = false;
      await invalidateAll();
    } else {
      toast = { kind: "danger", text: m.error_server_generic() };
    }
  }

  async function doBulkDelete(): Promise<void> {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const res = await fetch("/api/events/bulk", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (res.ok) {
      const body = (await res.json()) as { affected_count: number };
      toast = {
        kind: "success",
        text: m.toast_bulk_delete_success({ count: String(body.affected_count) }),
      };
      clearSelection();
      await invalidateAll();
    } else {
      toast = { kind: "danger", text: m.error_server_generic() };
    }
  }

  async function doBulkDeleteForever(): Promise<void> {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const res = await fetch("/api/events/bulk?force=true", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (res.ok) {
      const body = (await res.json()) as { affected_count: number };
      toast = {
        kind: "success",
        text: m.toast_bulk_delete_forever_success({ count: String(body.affected_count) }),
      };
      clearSelection();
      await invalidateAll();
    } else {
      toast = { kind: "danger", text: m.error_server_generic() };
    }
  }

  async function doBulkRestore(): Promise<void> {
    // No bulk-restore endpoint in scope yet — loop over per-event restore.
    // RESEARCH Pitfall 2 still applies: invalidateAll fires after the loop.
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    for (const id of ids) {
      await fetch(`/api/events/${id}/restore`, { method: "PATCH" });
    }
    toast = {
      kind: "success",
      text: m.toast_bulk_restore_success({ count: String(ids.length) }),
    };
    clearSelection();
    await invalidateAll();
  }

  // 12. GamesPicker open helpers — bulk via BulkActionBar, single via the
  // FeedCard ⋯ menu. The mode + targetIds drive the picker's initial-state
  // computation below.
  function openGamesPickerForBulk(): void {
    gamesPickerMode = "bulk";
    gamesPickerTargetIds = [...selectedIds];
    gamesPickerOpen = true;
  }
  function openGamesPickerForCard(id: string): void {
    gamesPickerMode = "single";
    gamesPickerTargetIds = [id];
    gamesPickerOpen = true;
  }

  // 13. GamesPicker initial state derivation (RESEARCH Question 8). For
  // each game, count how many of the target events have it attached:
  //   - 0      → "off"
  //   - all    → "on"
  //   - mixed  → "mixed"
  // Same for the off-topic triage flag.
  let gamesPickerInitial = $derived.by((): {
    gameStates: Record<string, "on" | "off" | "mixed">;
    offTopicState: "on" | "off" | "mixed";
  } => {
    const targets = data.rows.filter((e) => gamesPickerTargetIds.includes(e.id));
    if (targets.length === 0) {
      return { gameStates: {}, offTopicState: "off" };
    }
    const gameStates: Record<string, "on" | "off" | "mixed"> = {};
    for (const g of data.games) {
      const c = targets.reduce((n, e) => n + (e.gameIds.includes(g.id) ? 1 : 0), 0);
      gameStates[g.id] = c === 0 ? "off" : c === targets.length ? "on" : "mixed";
    }
    const oc = targets.reduce((n, e) => {
      const md = e.metadata as { triage?: { offTopic?: boolean } } | null | undefined;
      return n + (md?.triage?.offTopic === true ? 1 : 0);
    }, 0);
    const offTopicState: "on" | "off" | "mixed" =
      oc === 0 ? "off" : oc === targets.length ? "on" : "mixed";
    return { gameStates, offTopicState };
  });

  // 14. AddEvent save (D-18) — POST then toast + invalidateAll + close.
  async function onSaveAddEvent(payload: AddEventPayload): Promise<void> {
    const res = await fetch("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gameId: payload.gameIds[0] ?? null,
        kind: payload.kind,
        occurredAt: payload.occurredAt,
        title: payload.title,
        url: payload.url,
        notes: payload.notes,
        authorIsMe: payload.authorIsMe,
      }),
    });
    if (res.ok) {
      toast = { kind: "success", text: m.toast_event_added() };
      addEventModalOpen = false;
      await invalidateAll();
    } else {
      toast = { kind: "danger", text: m.error_server_generic() };
    }
  }

  // 15. Per-event handlers wired through to EventDetailModal + FeedCard.
  async function onCardDelete(id: string): Promise<void> {
    await fetch(`/api/events/${id}`, { method: "DELETE" });
    await invalidateAll();
  }

  async function onModalUpdate(
    id: string,
    patch: Partial<{ title: string; notes: string | null; url: string | null; authorIsMe: boolean }>,
  ): Promise<void> {
    await fetch(`/api/events/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    await invalidateAll();
  }

  async function onModalDelete(id: string): Promise<void> {
    await fetch(`/api/events/${id}`, { method: "DELETE" });
    closeDetail();
    await invalidateAll();
  }

  async function onModalRestore(id: string): Promise<void> {
    await fetch(`/api/events/${id}/restore`, { method: "PATCH" });
    closeDetail();
    await invalidateAll();
  }

  async function onModalDeleteForever(id: string): Promise<void> {
    await fetch(`/api/events/${id}?force=true`, { method: "DELETE" });
    closeDetail();
    await invalidateAll();
  }

  async function restoreFromRecoveryDialog(id: string): Promise<void> {
    const res = await fetch(`/api/events/${id}/restore`, { method: "PATCH" });
    if (res.ok) {
      await invalidateAll();
      if (data.deletedEvents.length <= 1) recoveryOpen = false;
    }
  }

  // 16. Inline GamesPicker apply handler — single vs bulk.
  async function onGamesPickerApply(payload: {
    gameStates: Record<string, "on" | "off" | "mixed">;
    offTopicState: "on" | "off" | "mixed";
  }): Promise<void> {
    if (gamesPickerMode === "single") {
      // Single-event apply path. The bulk endpoint accepts a single-id
      // array; we route through it so the diff math (on/off/mixed) is
      // consistent across both paths and the audit log carries the same
      // event.attached_to_game / event.detached_from_game verbs as bulk.
      await doBulkPatch(payload);
    } else {
      await doBulkPatch(payload);
    }
    gamesPickerOpen = false;
  }

  // KIND axis order + labels. Hard-coded to mirror prototype
  // docs/design/v2/ui-kit/app.jsx lines 1645-1657 — YouTube first (the
  // marquee promotion channel), Press second (highest-leverage low-volume
  // surface), then Reddit/Twitter/Telegram/Discord (social), then Post (the
  // catch-all manual entry), then Conference/Talk (offline), then Other
  // (escape hatch). Hoisted above activeAxes so the strip's kind-label
  // lookup sees it. Empty kinds still render so the user can predict
  // counts; data-empty="1" dims their count badge.
  // Only kinds with a real adapter or manual-entry path are surfaced in
  // the KIND axis. Twitter / Telegram / Discord are declared in the
  // schema enum but have no adapter or paste flow — PROJECT.md flags
  // them as out-of-scope for v1. They stay in the DB enum (forward
  // compatibility) but never appear in the filter UI.
  const KIND_AXIS_ORDER: readonly EventKind[] = [
    "youtube_video",
    "reddit_post",
    "press",
    "post",
    "conference",
    "talk",
    "other",
  ] as const;
  const KIND_AXIS_LABEL: Record<EventKind, () => string> = {
    youtube_video: m.feed_axis_kind_youtube_video,
    press: m.feed_axis_kind_press,
    reddit_post: m.feed_axis_kind_reddit_post,
    twitter_post: m.feed_axis_kind_twitter_post,
    telegram_post: m.feed_axis_kind_telegram_post,
    discord_drop: m.feed_axis_kind_discord_drop,
    post: m.feed_axis_kind_post,
    conference: m.feed_axis_kind_conference,
    talk: m.feed_axis_kind_talk,
    other: m.feed_axis_kind_other,
  };

  // 17. Active filter chips for ActiveFiltersStrip. One chip per active
  // axis dimension; clicking the × clears that axis. Game / Author / Show
  // are single-cardinality, source / kind are multi (one chip per value).
  const activeAxes = $derived.by((): AxisChip[] => {
    const chips: AxisChip[] = [];
    if (urlState.show.kind === "inbox") {
      chips.push({
        axis: "show",
        // Short form for the strip — mirrors prototype ActiveFiltersStrip
        // (docs/design/v2/ui-kit/app.jsx line 204).
        label: m.feed_axis_show_inbox(),
        onRemove: () => setShow({ kind: "any" }),
      });
    } else if (urlState.show.kind === "standalone") {
      chips.push({
        axis: "game",
        // Off-topic flag is a GAME-axis option in the prototype strip
        // (app.jsx line 210). Keep the same data-variant for visual parity.
        label: m.feed_axis_game_off_topic(),
        onRemove: () => setShow({ kind: "any" }),
      });
    } else if (urlState.show.kind === "specific") {
      for (const gid of urlState.show.gameIds) {
        const game = data.games.find((g) => g.id === gid);
        chips.push({
          axis: "game",
          label: game?.title ?? gid,
          onRemove: () => {
            const next = urlState.show.kind === "specific"
              ? urlState.show.gameIds.filter((g) => g !== gid)
              : [];
            if (next.length === 0) setShow({ kind: "any" });
            else setShow({ kind: "specific", gameIds: next });
          },
        });
      }
    }
    for (const k of urlState.kind) {
      chips.push({
        axis: "kind",
        // Short kind label mirrors prototype app.jsx line 232
        // (KIND_INFO[k].label → axis-axis label). Falls back to the raw
        // kind id if the map is somehow missing the entry.
        label: KIND_AXIS_LABEL[k]?.() ?? k,
        kind: k,
        onRemove: () => setKind(urlState.kind.filter((x) => x !== k)),
      });
    }
    for (const sid of urlState.source) {
      const src = data.sources.find((s) => s.id === sid);
      chips.push({
        axis: "source",
        label: src?.displayName ?? src?.handleUrl ?? sid,
        onRemove: () => setSource(urlState.source.filter((x) => x !== sid)),
      });
    }
    if (urlState.authorIsMe === true) {
      chips.push({
        axis: "author",
        // Short form mirrors prototype app.jsx line 225 ("Mine" / "Others").
        label: m.feed_axis_author_mine(),
        onRemove: () => setAuthorIsMe(undefined),
      });
    } else if (urlState.authorIsMe === false) {
      chips.push({
        axis: "author",
        label: m.feed_axis_author_others(),
        onRemove: () => setAuthorIsMe(undefined),
      });
    }
    return chips;
  });

  // 18. Predicted-count helpers feed into AxisRow's per-chip count tail.
  // Convert EventDto to the FilterableEvent shape filter-math expects
  // (occurred_at + author_is_me snake_case). Defensive copy so the math
  // doesn't mutate the loader's data.
  let filterableEvents = $derived(
    data.rows.map((e) => ({
      id: e.id,
      kind: e.kind,
      occurred_at: e.occurredAt,
      title: e.title,
      notes: e.notes,
      author_is_me: e.authorIsMe,
      gameIds: e.gameIds,
      metadata: e.metadata as { triage?: { standalone?: boolean; offTopic?: boolean } } | null,
    })),
  );

  // Count for the KIND "All" sentinel — events matching the rest of the
  // state with no kind restriction. Reuses filter-math.passes by dropping
  // the kind axis from the state.
  function countWithKindAll(
    events: typeof filterableEvents,
    state: typeof urlState,
    todayArg: Date,
  ): number {
    const next = { ...state, kind: [] as EventKind[] };
    return events.filter((e) => passes(e, next, todayArg)).length;
  }

  // 20. Maps for O(1) source / game lookup on each card.
  const sourceById = $derived(new Map(data.sources.map((s) => [s.id, s])));
  const gameById = $derived(new Map(data.games.map((g) => [g.id, g])));

  // 21. groupEventsByDate preserved — LB-9. Cumulative state for infinite
  // scroll is owned per-load (data.rows is the SSR first page; we don't
  // append client-loaded pages into the store, the loader rerun delivers a
  // fresh first page). Infinite scroll via IntersectionObserver fetches the
  // /api/events cursor page and appends to allRows.
  let allRows = $state(data.rows);
  let nextCursor = $state<string | null>(data.nextCursor);
  let loading = $state(false);
  let endReached = $state(data.nextCursor === null);
  let sentinelEl = $state<HTMLDivElement | null>(null);
  let observer: IntersectionObserver | null = null;

  // Reset cumulative state when data changes (filter change → loader
  // rerun → fresh first page).
  $effect(() => {
    allRows = data.rows;
    nextCursor = data.nextCursor;
    endReached = data.nextCursor === null;
    loading = false;
  });

  const groupedRows = $derived(groupEventsByDate(allRows));

  async function loadMore(): Promise<void> {
    if (loading || endReached || !nextCursor) return;
    loading = true;
    try {
      const params = new URLSearchParams(page.url.searchParams);
      params.set("cursor", nextCursor);
      const res = await fetch(`/api/events?${params.toString()}`);
      if (!res.ok) {
        endReached = true;
        return;
      }
      const body = (await res.json()) as {
        rows: typeof data.rows;
        nextCursor: string | null;
      };
      allRows = [...allRows, ...body.rows];
      nextCursor = body.nextCursor;
      if (body.nextCursor === null) endReached = true;
    } catch {
      endReached = true;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (!sentinelEl) return;
    observer?.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) void loadMore();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinelEl);
    return () => observer?.disconnect();
  });

  // 22. EventDetailModal lookup — find the opened event in allRows (which
  // is data.rows initially + any cursor-paginated additions). The loader's
  // ?event= load-bearing fetch guarantees data.rows includes the opened id
  // even when cursor is past it.
  const openedEvent = $derived(
    openEventId ? allRows.find((r) => r.id === openEventId) ?? null : null,
  );
</script>

<section class="feed" data-navigating={navigating.to ? "1" : "0"}>
  <PageHead
    title={trashView ? m.feed_page_head_title_trash() : m.feed_page_head_title_feed()}
    view={trashView ? "trash" : "feed"}
    onAddEvent={() => (addEventModalOpen = true)}
    query={urlState.query}
    onQueryChange={setQuery}
    onToggleFilters={() => setFiltersOpen(!filtersOpen)}
    {filtersOpen}
    activeFilterCount={activeAxes.length}
    totalCount={allRows.length}
    filteredCount={filterableEvents.filter((e) => passes(e, urlState, today)).length}
  >
    <DateRangeRow
      dateRange={urlState.dateRange}
      onDateRangeChange={setDateRange}
      sortDir={urlState.sortDir}
      onSortDirChange={setSortDir}
      {today}
    />
  </PageHead>

  {#if trashView}
    <div class="trash-banner" role="status">
      <span>{m.feed_trash_banner_text()}</span>
      <a class="trash-back" href="/feed">{m.feed_trash_back_to_feed()}</a>
    </div>
  {/if}

  <!-- ActiveFiltersStrip renders ONLY when filters panel is closed. When the
       panel is open, the per-axis chips themselves carry the selected state
       (data-active) so a separate summary strip would duplicate signal.
       Matches prototype docs/design/v2/ui-kit/app.jsx line 1588: `{!filtersOpen ? <ActiveFiltersStrip /> : ...}`. -->
  {#if !filtersOpen}
    <ActiveFiltersStrip axes={activeAxes} onClearAll={clearAllFilters} />
  {/if}

  {#if filtersOpen}
    <div class="filters-panel">
      <!-- SHOW axis — sentinel "All" first, then "Inbox". Sentinel maps to
        show.kind === "any" (URL param dropped); "Inbox" → show.kind === "inbox".
        Mirrors prototype docs/design/v2/ui-kit/app.jsx lines 1603-1611. -->
      <AxisRow
        label={m.axis_row_show_label()}
        axisKey="show"
        options={[
          {
            value: "all",
            label: m.feed_axis_show_all(),
            predictedCount: countWithShow(filterableEvents, "any", urlState, today),
          },
          {
            value: "inbox",
            label: m.feed_axis_show_inbox(),
            predictedCount: countWithShow(filterableEvents, "inbox", urlState, today),
          },
        ]}
        selectedValues={urlState.show.kind === "inbox"
          ? ["inbox"]
          : urlState.show.kind === "any"
            ? ["all"]
            : []}
        onToggle={(v) => {
          if (v === "all") setShow({ kind: "any" });
          else if (v === "inbox") setShow({ kind: "inbox" });
        }}
        onClearAxis={() => setShow({ kind: "any" })}
      />

      <!-- GAME axis — sentinel "All games" first, then "Off topic" (maps to
        show.kind === "standalone"), then per-game chips. Mirrors prototype
        app.jsx lines 1613-1627. In our schema show is single-cardinality
        ({any | inbox | standalone | specific}); the GAME axis chips
        therefore behave as radios (clicking a game = specific; "Off topic"
        = standalone; "All games" = any). -->
      <AxisRow
        label={m.axis_row_game_label()}
        axisKey="game"
        options={[
          {
            value: "all",
            label: m.feed_axis_game_all(),
            predictedCount: countWithShow(filterableEvents, "any", urlState, today),
          },
          {
            value: "off_topic",
            label: m.feed_axis_game_off_topic(),
            predictedCount: countWithShow(filterableEvents, "standalone", urlState, today),
          },
          ...data.games.map((g) => ({
            value: g.id,
            label: g.title,
            predictedCount: countWithGame(filterableEvents, g.id, urlState, today),
          })),
        ]}
        selectedValues={urlState.show.kind === "specific"
          ? urlState.show.gameIds
          : urlState.show.kind === "standalone"
            ? ["off_topic"]
            : urlState.show.kind === "any"
              ? ["all"]
              : []}
        onToggle={(v) => {
          if (v === "all") {
            setShow({ kind: "any" });
            return;
          }
          if (v === "off_topic") {
            setShow(urlState.show.kind === "standalone" ? { kind: "any" } : { kind: "standalone" });
            return;
          }
          // Per-game chip — multi-select within `specific`.
          const current = urlState.show.kind === "specific" ? urlState.show.gameIds : [];
          const next = current.includes(v) ? current.filter((g) => g !== v) : [...current, v];
          if (next.length === 0) setShow({ kind: "any" });
          else setShow({ kind: "specific", gameIds: next });
        }}
        onClearAxis={() => setShow({ kind: "any" })}
      />

      <!-- AUTHOR axis — sentinel "Anyone" + "Mine" + "Others". Mirrors
        prototype app.jsx lines 1629-1638. -->
      <AxisRow
        label={m.axis_row_author_label()}
        axisKey="author"
        options={[
          {
            value: "anyone",
            label: m.feed_axis_author_anyone(),
            predictedCount: countWithAuthor(filterableEvents, "anyone", urlState, today),
          },
          {
            value: "mine",
            label: m.feed_axis_author_mine(),
            predictedCount: countWithAuthor(filterableEvents, "mine", urlState, today),
          },
          {
            value: "others",
            label: m.feed_axis_author_others(),
            predictedCount: countWithAuthor(filterableEvents, "others", urlState, today),
          },
        ]}
        selectedValues={urlState.authorIsMe === true
          ? ["mine"]
          : urlState.authorIsMe === false
            ? ["others"]
            : ["anyone"]}
        onToggle={(v) => {
          if (v === "anyone") setAuthorIsMe(undefined);
          else if (v === "mine") setAuthorIsMe(true);
          else if (v === "others") setAuthorIsMe(false);
        }}
        onClearAxis={() => setAuthorIsMe(undefined)}
      />

      <!-- KIND axis — sentinel "All" + per-kind multi-select chips with
        leading kind-colored icon. Order mirrors prototype app.jsx lines
        1640-1657: YouTube / Press / Reddit / Twitter / Telegram / Discord
        / Post / Conference / Talk / Other. Renders the FULL list so the
        user can predict what each chip would narrow to — empty chips dim
        their count via data-empty. -->
      <AxisRow
        label={m.axis_row_kind_label()}
        axisKey="kind"
        options={[
          {
            value: "all",
            label: m.feed_axis_kind_all(),
            predictedCount: countWithKindAll(filterableEvents, urlState, today),
          },
          ...KIND_AXIS_ORDER.map((k) => ({
            value: k,
            label: KIND_AXIS_LABEL[k](),
            predictedCount: countWithKind(filterableEvents, k, urlState, today),
            iconKind: k,
          })),
        ]}
        selectedValues={urlState.kind.length === 0 ? ["all"] : urlState.kind}
        onToggle={(v) => {
          if (v === "all") {
            setKind([]);
            return;
          }
          const k = v as EventKind;
          const next = urlState.kind.includes(k)
            ? urlState.kind.filter((x) => x !== k)
            : [...urlState.kind, k];
          setKind(next);
        }}
        onClearAxis={() => setKind([])}
      />

      <FindRow
        query={urlState.query}
        onQueryChange={setQuery}
        resultCount={filterableEvents.filter((e) => passes(e, urlState, today)).length}
        hasOtherFilters={activeAxes.length > 0}
      />
    </div>
  {/if}

  {#each groupedRows as group (group.date)}
    <FeedDateGroupHeader occurredAt={group.occurredAt} count={group.rows.length} />
    <div class="feed-grid">
      {#each group.rows as row (row.id)}
        {@const Card = getCardComponent(row.kind) ?? FeedCard}
        <Card
          event={row}
          source={row.sourceId ? (sourceById.get(row.sourceId) ?? null) : null}
          game={row.gameIds.length > 0 ? (gameById.get(row.gameIds[0]!) ?? null) : null}
          games={data.games}
          selected={selectedIds.has(row.id)}
          {anySelected}
          view={trashView ? "trash" : "feed"}
          onToggleSelect={onToggleSelect}
          onOpenDetail={openDetail}
          onOpenGamesPickerForCard={openGamesPickerForCard}
          onDelete={onCardDelete}
          onChanged={() => invalidateAll()}
        />
      {/each}
    </div>
  {/each}
  {#if !endReached}
    <div class="sentinel" bind:this={sentinelEl} aria-hidden="true"></div>
    {#if loading}
      <p class="feed-status" role="status">{m.feed_loading_more()}</p>
    {/if}
  {:else if allRows.length > 0}
    <p class="feed-status feed-end" role="status">{m.feed_no_more_events()}</p>
  {/if}

  {#if !trashView && data.deletedEvents.length > 0}
    <RecoveryDialog
      open={recoveryOpen}
      items={recoveryItems}
      entityType="event"
      retentionDays={data.retentionDays}
      onClose={() => (recoveryOpen = false)}
      onRestore={restoreFromRecoveryDialog}
    />
  {/if}

  {#if openedEvent}
    <EventDetailModal
      event={openedEvent}
      games={data.games}
      sources={data.sources}
      view={trashView ? "trash" : "feed"}
      hasPrev={false}
      hasNext={false}
      onClose={closeDetail}
      onDelete={onModalDelete}
      onRestore={trashView ? onModalRestore : undefined}
      onDeleteForever={trashView ? onModalDeleteForever : undefined}
      onUpdate={onModalUpdate}
    />
  {/if}

  <AddEventModal
    open={addEventModalOpen}
    games={data.games}
    onSave={onSaveAddEvent}
    onClose={() => (addEventModalOpen = false)}
  />

  <GamesPicker
    open={gamesPickerOpen}
    games={data.games.map((g) => ({ id: g.id, title: g.title }))}
    initialGameStates={gamesPickerInitial.gameStates}
    initialOffTopicState={gamesPickerInitial.offTopicState}
    mode={gamesPickerMode}
    selectedCount={gamesPickerTargetIds.length}
    onApply={onGamesPickerApply}
    onClose={() => (gamesPickerOpen = false)}
  />

  <BulkActionBar
    selectedCount={selectedIds.size}
    view={trashView ? "trash" : "feed"}
    onOpenGamesPicker={openGamesPickerForBulk}
    onDelete={doBulkDelete}
    onRestore={doBulkRestore}
    onDeleteForever={doBulkDeleteForever}
    onClearSelection={clearSelection}
  />

  {#if toast}
    <Toast kind={toast.kind} text={toast.text} onclose={() => (toast = null)} />
  {/if}
</section>

<style>
  .feed {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    min-width: 0;
  }

  /* Optimistic loading state — visual feedback while SvelteKit's loader
   * round-trip is in flight. `navigating.to` from $app/state is reactive
   * (non-null when a navigation is pending). The .feed-grid dims and
   * blocks input so the click feels registered immediately. */
  .feed[data-navigating="1"] .feed-grid {
    opacity: 0.55;
    pointer-events: none;
    cursor: progress;
    transition: opacity var(--m-fast, 120ms) var(--m-ease, ease-out);
  }
  .feed[data-navigating="1"]::after {
    content: "";
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: linear-gradient(
      90deg,
      transparent,
      var(--accent),
      transparent
    );
    animation: feed-nav-progress 1s linear infinite;
    z-index: 100;
    pointer-events: none;
  }
  @keyframes feed-nav-progress {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }
  @media (prefers-reduced-motion: reduce) {
    .feed[data-navigating="1"]::after {
      animation: none;
      background: var(--accent);
      opacity: 0.6;
    }
  }

  /* Trash banner — persistent status row above the chip strip when
   * data.view === "trash". Amber accent treatment matches the design v2
   * "warning / attention" surface token. */
  .trash-banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
    padding: var(--s-2) var(--s-4);
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid var(--accent-strong);
    border-radius: var(--r-sm);
    font-size: var(--t-13);
  }
  .trash-back {
    color: var(--accent);
    text-decoration: underline;
    font-weight: var(--w-sb);
  }
  .trash-back:hover {
    color: var(--accent-strong);
  }

  /* Filters panel — gates AxisRow + FindRow under the LB-10 toggle so the
   * chrome stays compact when the user doesn't need them. */
  .filters-panel {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    padding: var(--s-2) 0;
    border-top: 1px solid var(--border-hairline);
    border-bottom: 1px solid var(--border-hairline);
  }

  /* v2 feed grid — mirrors prototype docs/design/v2/ui-kit/index.html
   * .feed-grid (lines 836-842): 3 cols wide / 2 cols tablet / 1 col mobile.
   * One feed-grid per date group; FeedDateGroupHeader sits BETWEEN grids
   * (sticky LB-3 math intact via its own component CSS). */
  .feed-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--s-3);
    margin: 0;
    padding: 0;
    min-width: 0;
  }
  @media (max-width: 1024px) {
    .feed-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 640px) {
    .feed-grid {
      grid-template-columns: 1fr;
    }
  }
  .sentinel {
    width: 100%;
    height: 1px;
    grid-column: 1 / -1;
  }
  .feed-status {
    grid-column: 1 / -1;
    text-align: center;
    color: var(--text-3);
    font-size: var(--t-13);
    padding: var(--s-4) 0;
    margin: 0;
  }
</style>
