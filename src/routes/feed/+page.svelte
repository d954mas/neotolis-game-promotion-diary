<script lang="ts">
  // /feed — primary daily workspace orchestrator (Phase 03.4 Wave 3 Plan 10).
  //
  // Composition map:
  //   - <PageHead>      (Plan 07) title + Add Event CTA + search + Filters toggle
  //     ↳ children slot: <DateRangeRow> (Plan 07)
  //   - <ActiveFiltersStrip> (Plan 07) chips for active filters
  //   - {#if filtersOpen} <AxisRow ×4>
  //     (FindRow removed Plan 03.4-10 follow-up — the in-result search
  //     input was a duplicate of PageHead's `?q=...` field; the prototype
  //     never rendered it. The single source of truth for the search
  //     query is now PageHead → serializeFilterState → ?q= → loader →
  //     listFeedPage's Postgres FTS predicate.)
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
    OFF_TOPIC_TAG,
    type FilterState,
    type DateRangeFilter,
    type ShowFilter,
  } from "$lib/feed/url-state.js";
  import { passes } from "$lib/feed/filter-math.js";
  import { parseEventDate } from "$lib/feed/date-range.js";
  import {
    createFeedToast,
    createFeedNavOverlay,
    createGamesPickerState,
  } from "$lib/feed/feed-state.svelte.js";
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
  import FeedCard from "$lib/components/FeedCard.svelte";
  import BulkActionBar from "$lib/components/feed/BulkActionBar.svelte";
  import GamesPicker from "$lib/components/feed/GamesPicker.svelte";
  import EventDetailModal from "$lib/components/event-detail/EventDetailModal.svelte";
  import AddEventModal from "$lib/components/add-event/AddEventModal.svelte";
  import Toast from "$lib/components/shared/Toast.svelte";
  import FeedDateGroupHeader from "$lib/components/FeedDateGroupHeader.svelte";
  import RecoveryDialog from "$lib/components/RecoveryDialog.svelte";
  import { getCardComponent } from "$lib/sources/registry-ui-client.js";
  import { FEED_KIND_FILTER_KINDS } from "$lib/sources/kind-display.js";
  import { MEDIA_FILTER_CATEGORIES, type MediaTypeCategory } from "$lib/feed/media-type-filter.js";
  import { groupEventsByDate } from "$lib/util/group-events-by-date.js";

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
  const gamesPicker = createGamesPickerState();
  const toast = createFeedToast();

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

  // Navigating-overlay safeguard: gates the visual on BOTH `navigating.to`
  // AND a self-clearing 10s timeout so the overlay can't outlive a real
  // network round-trip. See createFeedNavOverlay for full rationale.
  const navOverlay = createFeedNavOverlay();
  $effect(() => {
    navOverlay.track(navigating.to);
  });

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
  /**
   * setGameTags — GAME-axis multi-select writer (Plan 03.4-10). `next` is
   * a flat list of game IDs + optional OFF_TOPIC_TAG. Empty list clears
   * the axis. Switching to a non-empty gameTags while the user is in
   * `?show=inbox` would yield zero rows by construction (inbox = no games
   * attached); we collapse `show` back to "any" so the user sees the
   * expected GAME-axis result set instead of an empty feed.
   */
  function setGameTags(next: string[]): void {
    const nextShow: ShowFilter =
      next.length > 0 && urlState.show.kind === "inbox" ? { kind: "any" } : urlState.show;
    pushUrl({ ...urlState, gameTags: next, show: nextShow, cursor: undefined });
  }
  function setKind(next: EventKind[]): void {
    pushUrl({ ...urlState, kind: next, cursor: undefined });
  }
  function setMediaType(next: MediaTypeCategory[]): void {
    pushUrl({ ...urlState, mediaType: next, cursor: undefined });
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
      gameTags: [],
      kind: [],
      mediaType: [],
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
    // Use gamesPicker.targetIds — these are set correctly for both the
    // bulk (BulkActionBar → selectedIds copy) and single (FeedCard ⋮
    // menu → [event.id]) paths. selectedIds is the store value which
    // is empty in single-event mode (user didn't enter mass-select),
    // so reading from it would early-return here.
    const ids = [...gamesPicker.targetIds];
    if (ids.length === 0) return;
    const res = await fetch("/api/events/bulk", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids, ...payload }),
    });
    if (res.ok) {
      const body = (await res.json()) as { affected_count: number };
      toast.show("success", m.toast_bulk_edit_success({ count: String(body.affected_count) }));
      if (gamesPicker.mode === "bulk") clearSelection();
      gamesPicker.close();
      await invalidateAll();
    } else {
      toast.show("danger", m.error_server_generic());
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
      toast.show("success", m.toast_bulk_delete_success({ count: String(body.affected_count) }));
      clearSelection();
      await invalidateAll();
    } else {
      toast.show("danger", m.error_server_generic());
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
      toast.show(
        "success",
        m.toast_bulk_delete_forever_success({ count: String(body.affected_count) }),
      );
      clearSelection();
      await invalidateAll();
    } else {
      toast.show("danger", m.error_server_generic());
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
    toast.show("success", m.toast_bulk_restore_success({ count: String(ids.length) }));
    clearSelection();
    await invalidateAll();
  }

  // 12. GamesPicker open helpers — bulk via BulkActionBar, single via the
  // FeedCard ⋯ menu. The mode + targetIds drive the picker's initial-state
  // computation below.
  function openGamesPickerForBulk(): void {
    gamesPicker.openForBulk(selectedIds);
  }
  function openGamesPickerForCard(id: string): void {
    gamesPicker.openForCard(id);
  }

  // 13. GamesPicker initial state derivation (RESEARCH Question 8). For
  // each game, count how many of the target events have it attached:
  //   - 0      → "off"
  //   - all    → "on"
  //   - mixed  → "mixed"
  // Same for the off-topic triage flag.
  let gamesPickerInitial = $derived.by(
    (): {
      gameStates: Record<string, "on" | "off" | "mixed">;
      offTopicState: "on" | "off" | "mixed";
    } => {
      const targets = data.rows.filter((e) => gamesPicker.targetIds.includes(e.id));
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
    },
  );

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
        metadata: payload.metadata,
        externalId: payload.externalId,
        authorHandle: payload.authorHandle,
      }),
    });
    if (res.ok) {
      toast.show("success", m.toast_event_added());
      addEventModalOpen = false;
      await invalidateAll();
    } else {
      toast.show("danger", m.error_server_generic());
    }
  }

  // 15. Per-event handlers wired through to EventDetailModal + FeedCard.
  async function onCardDelete(id: string): Promise<void> {
    await fetch(`/api/events/${id}`, { method: "DELETE" });
    await invalidateAll();
  }

  async function onModalUpdate(
    id: string,
    patch: Partial<{
      title: string;
      notes: string | null;
      url: string | null;
      authorIsMe: boolean;
    }>,
  ): Promise<void> {
    const res = await fetch(`/api/events/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    // On a non-2xx don't pretend success — skip the refresh so the edit stays in
    // the open modal to retry (a silent "saved" on a failed PATCH is worse).
    if (!res.ok) return;
    await invalidateAll();
  }

  async function onModalDelete(id: string): Promise<void> {
    const res = await fetch(`/api/events/${id}`, { method: "DELETE" });
    // On failure keep the modal open + the row in place — closing + refreshing
    // would look like a successful delete when the event is still there.
    if (!res.ok) return;
    closeDetail();
    await invalidateAll();
  }

  async function onModalRestore(id: string): Promise<void> {
    const res = await fetch(`/api/events/${id}/restore`, { method: "PATCH" });
    if (!res.ok) return;
    closeDetail();
    await invalidateAll();
  }

  async function onModalDeleteForever(id: string): Promise<void> {
    const res = await fetch(`/api/events/${id}?force=true`, { method: "DELETE" });
    if (!res.ok) return;
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
    if (gamesPicker.mode === "single") {
      // Single-event apply path. The bulk endpoint accepts a single-id
      // array; we route through it so the diff math (on/off/mixed) is
      // consistent across both paths and the audit log carries the same
      // event.attached_to_game / event.detached_from_game verbs as bulk.
      await doBulkPatch(payload);
    } else {
      await doBulkPatch(payload);
    }
    gamesPicker.close();
  }

  // KIND axis order + labels. Order comes from FEED_KIND_FILTER_KINDS
  // (kind-display.ts) — the single ORDERED source of truth, validated for
  // exact-set equality against FEED_FILTERABLE_EVENT_KINDS by
  // tests/unit/feed-filter-derivation.test.ts. Phase 10 D-08: this REPLACES
  // the hand-maintained KIND_AXIS_ORDER array that lived here and was never
  // updated when instagram_post / telegram_post / tiktok_post shipped, so the
  // social adapter kinds silently dropped out of the LIVE /feed KIND axis (the
  // user-reported regression). A new adapter kind now auto-appears the moment
  // it's marked feedFilterable:true and placed in FEED_KIND_FILTER_KINDS.
  // Empty kinds still render so the user can predict counts; data-empty="1"
  // dims their count badge.
  // Deterministic per-game color from id hash → HSL. GameDto has no
  // color field, so derive client-side. Same id always produces the same
  // hue so the color flows consistently across FeedCard footer chips,
  // ActiveFiltersStrip, and the AxisRow game chips.
  function gameColor(id: string): string {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    const hue = ((h % 360) + 360) % 360;
    return `hsl(${hue} 62% 52%)`;
  }

  // TYPE axis (Short / Video / Other) order + labels. Order comes from
  // MEDIA_FILTER_CATEGORIES (media-type-filter.ts) — the single source of
  // ORDER + MEMBERSHIP; the URL validator derives its allowed values from the
  // SAME const, so a chip that renders always round-trips the URL (no hand-list
  // drift, the lesson this branch already learned four times).
  const TYPE_AXIS_ORDER: readonly MediaTypeCategory[] = MEDIA_FILTER_CATEGORIES;
  const TYPE_AXIS_LABEL: Record<MediaTypeCategory, () => string> = {
    short: m.feed_axis_type_short,
    video: m.feed_axis_type_video,
    other: m.feed_axis_type_other,
  };

  const KIND_AXIS_ORDER: readonly EventKind[] = FEED_KIND_FILTER_KINDS;
  const KIND_AXIS_LABEL: Record<EventKind, () => string> = {
    youtube_video: m.feed_axis_kind_youtube_video,
    press: m.feed_axis_kind_press,
    reddit_post: m.feed_axis_kind_reddit_post,
    twitter_post: m.feed_axis_kind_twitter_post,
    telegram_post: m.feed_axis_kind_telegram_post,
    discord_drop: m.feed_axis_kind_discord_drop,
    instagram_post: m.feed_axis_kind_instagram_post,
    tiktok_post: m.feed_axis_kind_tiktok_post,
    post: m.feed_axis_kind_post,
    conference: m.feed_axis_kind_conference,
    talk: m.feed_axis_kind_talk,
    other: m.feed_axis_kind_other,
  };

  // 17. Active filter chips for ActiveFiltersStrip. One chip per active
  // axis dimension; clicking the × clears that axis. After Plan 03.4-10
  // the GAME axis is multi-select (gameTags is a flat list of game IDs +
  // optional OFF_TOPIC_TAG sentinel) so we emit one chip per entry. SHOW
  // axis is narrowed to any | inbox.
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
    }
    // GAME axis chips — one per active gameTags entry. Off-topic sentinel
    // uses the off-topic label + accent; per-game entries use the game's
    // title + deterministic gameColor.
    for (const tag of urlState.gameTags) {
      if (tag === OFF_TOPIC_TAG) {
        chips.push({
          axis: "game",
          // Off-topic flag is a GAME-axis option in the prototype strip
          // (app.jsx line 210). Keep the same data-variant for visual parity.
          label: m.feed_axis_game_off_topic(),
          onRemove: () => setGameTags(urlState.gameTags.filter((t) => t !== OFF_TOPIC_TAG)),
        });
      } else {
        const game = data.games.find((g) => g.id === tag);
        chips.push({
          axis: "game",
          label: game?.title ?? tag,
          color: gameColor(tag),
          onRemove: () => setGameTags(urlState.gameTags.filter((t) => t !== tag)),
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
    for (const c of urlState.mediaType) {
      chips.push({
        axis: "type",
        label: TYPE_AXIS_LABEL[c]?.() ?? c,
        onRemove: () => setMediaType(urlState.mediaType.filter((x) => x !== c)),
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
      metadata: e.metadata as { triage?: { offTopic?: boolean } } | null,
      // Per-post media kind from the feed enrichment — drives the client-side
      // MEDIA-TYPE axis classification (predicted counts + the header's
      // filtered-count display). Mirrors the server's per-post cache-row arm.
      instagramEnrichment: (e as { instagramEnrichment?: { mediaType?: string | null } | null })
        .instagramEnrichment,
      tiktokEnrichment: (e as { tiktokEnrichment?: { mediaType?: string | null } | null })
        .tiktokEnrichment,
      // twitter_post classifies per-post (media_type 'video' → video; 'image' /
      // 'text' / missing → other). Mirrors the server SQL twitter arm.
      twitterEnrichment: (e as { twitterEnrichment?: { mediaType?: string | null } | null })
        .twitterEnrichment,
      // youtube_video classifies per-post too (media_type 'short' → short, else
      // video). NULL/missing → video (the filter-math youtube arm's default).
      youtubeEnrichment: (e as { youtubeEnrichment?: { mediaType?: string | null } | null })
        .youtubeEnrichment,
    })),
  );

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
    openEventId ? (allRows.find((r) => r.id === openEventId) ?? null) : null,
  );
</script>

<section class="feed" data-navigating={navOverlay.active ? "1" : "0"}>
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
    deletedCount={data.deletedEvents.length}
    onOpenTrash={() => goto("/feed?view=trash", { keepFocus: true, noScroll: true })}
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
      <a class="trash-back" href="/feed">← {m.feed_trash_back_to_feed()}</a>
      <span class="trash-banner-text">{m.feed_trash_banner_text({ days: data.retentionDays })}</span
      >
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
      <!-- SHOW axis — sentinel "All" + "Inbox". After Plan 03.4-10 the
        SHOW axis is narrowed to any | inbox; off-topic + per-game selection
        moved to the orthogonal GAME axis multi-select below. -->
      <AxisRow
        label={m.axis_row_show_label()}
        axisKey="show"
        options={[
          {
            value: "all",
            label: m.feed_axis_show_all(),
            // Server-side facet (Plan 03.4-10 Option B). show.all = total
            // events matching every other axis. Stable across same-axis
            // toggles (toggling Inbox doesn't change All's count).
            predictedCount: data.facets.show.all,
          },
          {
            value: "inbox",
            label: m.feed_axis_show_inbox(),
            predictedCount: data.facets.show.inbox,
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

      <!-- GAME axis (Plan 03.4-10) — flat multi-select. Sentinel "All games"
        first (clears the axis), "Off topic" (toggles OFF_TOPIC_TAG in
        gameTags), then per-game chips (each toggles its game id in
        gameTags). Off-topic + games co-exist in the same list with OR
        semantics in the server SQL. Mirrors prototype app.jsx
        lines 1613-1627 which already used a flat `game: string[]` array. -->
      <AxisRow
        label={m.axis_row_game_label()}
        axisKey="game"
        options={[
          {
            value: "all",
            label: m.feed_axis_game_all(),
            // "All games" sentinel = events matching every other axis with
            // the GAME axis cleared. Stable across same-axis (GAME) chip
            // toggles — toggling Last Light doesn't change the All count.
            predictedCount: data.facets.gameTagsAll,
          },
          {
            value: OFF_TOPIC_TAG,
            label: m.feed_axis_game_off_topic(),
            predictedCount: data.facets.gameTags[OFF_TOPIC_TAG] ?? 0,
          },
          ...data.games.map((g) => ({
            value: g.id,
            label: g.title,
            predictedCount: data.facets.gameTags[g.id] ?? 0,
            accentColor: gameColor(g.id),
          })),
        ]}
        selectedValues={urlState.gameTags.length === 0 ? ["all"] : urlState.gameTags}
        onToggle={(v) => {
          if (v === "all") {
            setGameTags([]);
            return;
          }
          // Multi-select toggle — adds when absent, removes when present.
          // Off-topic + game IDs share the same array; the server SQL
          // ORs them together.
          const next = urlState.gameTags.includes(v)
            ? urlState.gameTags.filter((t) => t !== v)
            : [...urlState.gameTags, v];
          setGameTags(next);
        }}
        onClearAxis={() => setGameTags([])}
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
            // Server-side facet (Plan 03.4-10 Option B). author.anyone =
            // total events matching every other axis with the AUTHOR
            // axis cleared. Stable across same-axis (AUTHOR) toggles.
            predictedCount: data.facets.author.anyone,
          },
          {
            value: "mine",
            label: m.feed_axis_author_mine(),
            predictedCount: data.facets.author.mine,
          },
          {
            value: "others",
            label: m.feed_axis_author_others(),
            predictedCount: data.facets.author.others,
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
            // Server-side facet (Plan 03.4-10 Option B). kindsAll = total
            // events matching every other axis with the KIND axis cleared.
            // Stable across same-axis (KIND) toggles.
            predictedCount: data.facets.kindsAll,
          },
          ...KIND_AXIS_ORDER.map((k) => ({
            value: k,
            label: KIND_AXIS_LABEL[k](),
            predictedCount: data.facets.kinds[k] ?? 0,
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

      <!-- TYPE axis (Short / Video / Other) — sentinel "All" + per-category
        multi-select chips. Options derived from MEDIA_FILTER_CATEGORIES (the
        single source of truth shared with the URL validator + the server
        filter). Cross-source: classifies every feed event by content SHAPE
        (TikTok/IG Reels → Short, YouTube/IG feed video → Video, everything else
        → Other). -->
      <AxisRow
        label={m.axis_row_type_label()}
        axisKey="type"
        options={[
          {
            value: "all",
            label: m.feed_axis_type_all(),
            // "All types" sentinel — total events matching every other axis with
            // the TYPE axis cleared. Stable across same-axis (TYPE) toggles.
            predictedCount: data.facets.mediaType.all,
          },
          ...TYPE_AXIS_ORDER.map((c) => ({
            value: c,
            label: TYPE_AXIS_LABEL[c](),
            predictedCount: data.facets.mediaType[c],
          })),
        ]}
        selectedValues={urlState.mediaType.length === 0 ? ["all"] : urlState.mediaType}
        onToggle={(v) => {
          if (v === "all") {
            setMediaType([]);
            return;
          }
          const cat = v as MediaTypeCategory;
          const next = urlState.mediaType.includes(cat)
            ? urlState.mediaType.filter((x) => x !== cat)
            : [...urlState.mediaType, cat];
          setMediaType(next);
        }}
        onClearAxis={() => setMediaType([])}
      />
    </div>
  {/if}

  {#if allRows.length === 0}
    <!--
      Empty state — matches the prototype's `.feed-empty` block
      (docs/design/v2/ui-kit/index.html .feed-empty lines 326-345).
      Three variants: trash-empty, feed-empty-no-filters, feed-empty-with-filters.
    -->
    <div class="feed-empty" role="status">
      {#if trashView}
        <h2 class="feed-empty-heading">{m.feed_trash_empty_heading()}</h2>
        <p class="feed-empty-body">{m.feed_trash_empty_body({ days: data.retentionDays })}</p>
      {:else if activeAxes.length > 0 || urlState.query.length > 0}
        <h2 class="feed-empty-heading">{m.empty_feed_filtered_heading()}</h2>
        <p class="feed-empty-body">{m.empty_feed_filtered_body()}</p>
      {:else}
        <h2 class="feed-empty-heading">{m.empty_feed_heading()}</h2>
        <p class="feed-empty-body">{m.empty_feed_body()}</p>
        <!-- First-run: give the empty feed an action in context. The page-head
             "Add event" CTA is up in the chrome; a first-timer reading the empty
             body needs the next step right here (log an event, or connect a
             source so auto-import fills the feed). -->
        <div class="feed-empty-actions">
          <button type="button" class="feed-empty-cta" onclick={() => (addEventModalOpen = true)}>
            <span class="feed-empty-cta-plus" aria-hidden="true">+</span>
            {m.feed_cta_add_event()}
          </button>
          <a class="feed-empty-link" href="/sources/new">{m.sources_cta_new_source()}</a>
        </div>
      {/if}
    </div>
  {:else}
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
            {onToggleSelect}
            onOpenDetail={openDetail}
            onOpenGamesPickerForCard={openGamesPickerForCard}
            onDelete={onCardDelete}
            onRestore={onModalRestore}
            onDeleteForever={onModalDeleteForever}
            currentUserName={page.data.user?.name ?? undefined}
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
      onClose={closeDetail}
      onDelete={onModalDelete}
      onRestore={trashView ? onModalRestore : undefined}
      onDeleteForever={trashView ? onModalDeleteForever : undefined}
      onUpdate={onModalUpdate}
      onOpenGamesPickerForCard={openGamesPickerForCard}
    />
  {/if}

  <AddEventModal
    open={addEventModalOpen}
    games={data.games}
    onSave={onSaveAddEvent}
    onClose={() => (addEventModalOpen = false)}
  />

  <GamesPicker
    open={gamesPicker.open}
    games={data.games.map((g) => ({ id: g.id, title: g.title }))}
    initialGameStates={gamesPickerInitial.gameStates}
    initialOffTopicState={gamesPickerInitial.offTopicState}
    mode={gamesPicker.mode}
    selectedCount={gamesPicker.targetIds.length}
    onApply={onGamesPickerApply}
    onClose={gamesPicker.close}
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

  {#if toast.current}
    <Toast kind={toast.current.kind} text={toast.current.text} onclose={toast.dismiss} />
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
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    animation: feed-nav-progress 1s linear infinite;
    z-index: 100;
    pointer-events: none;
  }
  @keyframes feed-nav-progress {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(100%);
    }
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
    gap: var(--s-3);
    padding: var(--s-2) var(--s-4);
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid var(--accent-strong);
    border-radius: var(--r-sm);
    font-size: var(--t-13);
  }
  .trash-back {
    color: var(--accent-strong);
    text-decoration: none;
    font-weight: var(--w-sb);
    white-space: nowrap;
  }
  .trash-back:hover {
    text-decoration: underline;
  }
  .trash-banner-text {
    color: var(--accent);
  }

  /* Filters panel — gates AxisRow rows under the LB-10 toggle so the
   * chrome stays compact when the user doesn't need them. (FindRow was
   * removed Plan 03.4-10 follow-up — duplicate of PageHead's search.) */
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
  /* Empty state — matches prototype `.feed-empty` block
   * (docs/design/v2/ui-kit/index.html lines 326-345). Three variants
   * rendered conditionally from the orchestrator above: trash-empty,
   * feed-empty-no-filters (no events at all), feed-empty-with-filters
   * (filtered set is empty). 22px heading + 14px body, max-width 560px,
   * centered horizontally in the layout column. */
  .feed-empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-3);
    padding: var(--s-8) var(--s-4);
    max-width: 560px;
    margin: 0 auto;
  }
  .feed-empty-heading {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    color: var(--text);
    letter-spacing: -0.01em;
    line-height: var(--lh-tight);
  }
  .feed-empty-body {
    margin: 0;
    color: var(--text-2);
    font-size: var(--t-14);
    line-height: var(--lh-body);
  }
  .feed-empty-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-3);
    margin-top: var(--s-2);
  }
  /* Mirrors the elevated PageHead "Add event" CTA so the empty-state action
   * reads as the same primary affordance. */
  .feed-empty-cta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: var(--hit-lg);
    padding: 0 var(--s-4);
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    font-weight: var(--w-md);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .feed-empty-cta:hover {
    background: var(--surface-3);
    border-color: var(--accent);
  }
  .feed-empty-cta-plus {
    font-size: 18px;
    line-height: 1;
    font-weight: var(--w-sb);
    color: var(--accent);
  }
  .feed-empty-link {
    color: var(--text-2);
    font-size: var(--t-14);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .feed-empty-link:hover {
    color: var(--text);
  }
  @media (prefers-reduced-motion: reduce) {
    .feed-empty-cta {
      transition: none;
    }
  }
</style>
