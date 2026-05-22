<script lang="ts">
  // FeedCard — default fallback for /feed event rendering.
  //
  // After Phase 03.4 Plan 08 follow-up: the bulk of the markup +
  // long-press + menu state moved into BaseFeedCard.svelte under
  // ./feed/parts/. This file remains the default cardComponent for
  // event kinds that have NO per-platform adapter override (press /
  // post / talk / conference / other / twitter_post / telegram_post /
  // discord_drop) — and is also still used as the fallback in
  // /feed/+page.svelte when getCardComponent(eventKind) returns
  // undefined.
  //
  // YouTube + Reddit cards live in src/lib/sources/{youtube,reddit}/ui/
  // and register themselves via registry-ui-client.ts so the /feed
  // dispatch picks them up. Each platform variant composes the same
  // BaseFeedCard with its own sourceLabel / thumbnail / stats read
  // path — enforcing the AGENTS.md no-denormalization rule at the
  // adapter boundary.
  //
  // This default fallback reads:
  //   - sourceLabel: source.displayName ?? source.handleUrl ?? "" (no
  //     channelTitle reference — that's a YouTube-only field, gated to
  //     YoutubeFeedCard).
  //   - bylineLabel: null (only Reddit needs a second meta line today).
  //   - thumbnailUrl: deriveThumbnailUrl(event) for legacy/unmapped
  //     kinds that still carry metadata.media.url (twitter_post,
  //     telegram_post). YouTube + Reddit paths are handled by their
  //     per-platform cards, but the helper covers any future kind that
  //     reaches this fallback.
  //
  // Tests target this file directly:
  //   - tests/browser/feed-card-long-press.test.ts (7)
  //   - tests/browser/feed-card-anyselected-sweep.test.ts (10)
  //   - tests/integration/audit-render.test.ts FeedCard markup blocks
  //
  // BaseFeedCard preserves the same markup shape and CSS hook contract,
  // so those tests pass through this delegation unchanged.

  import BaseFeedCard from "./feed/parts/BaseFeedCard.svelte";
  import { deriveThumbnailUrl, type CardEventLite } from "./feed/parts/derive-card-data.js";

  type SourceLite = {
    id: string;
    displayName: string | null;
    handleUrl: string;
    channelTitle?: string | null;
  };
  type GameLite = { id: string; title: string };

  let {
    event,
    source,
    games,
    onChanged,
    selected = false,
    anySelected = false,
    view = "feed",
    onToggleSelect,
    onOpenDetail,
    onOpenGamesPickerForCard,
    onDelete,
    onRestore,
    onDeleteForever,
    currentUserName,
  }: {
    event: CardEventLite;
    source: SourceLite | null;
    /** Legacy single-game prop, accepted for backward compat with
     *  existing call sites. BaseFeedCard reads `games` for multi-attach
     *  chip rendering. */
    game?: GameLite | null;
    games: GameLite[];
    onChanged?: () => void;
    selected?: boolean;
    anySelected?: boolean;
    view?: "feed" | "trash";
    onToggleSelect?: (id: string, force?: boolean) => void;
    onOpenDetail?: (id: string) => void;
    onOpenGamesPickerForCard?: (id: string) => void;
    onDelete?: (id: string) => Promise<void> | void;
    onRestore?: (id: string) => Promise<void> | void;
    onDeleteForever?: (id: string) => Promise<void> | void;
    currentUserName?: string;
  } = $props();

  // Default sourceLabel — handle URL or user-supplied displayName. No
  // channelTitle: the default card doesn't know about YouTube. Per-
  // platform variants (YoutubeFeedCard) read channelTitle via their
  // own source-of-truth path.
  const sourceLabel = $derived.by(
    (): string => source?.displayName ?? source?.handleUrl ?? "",
  );

  const thumbnailUrl = $derived.by(() => deriveThumbnailUrl(event));
</script>

<BaseFeedCard
  {event}
  {sourceLabel}
  {thumbnailUrl}
  {games}
  {onChanged}
  {selected}
  {anySelected}
  {view}
  {onToggleSelect}
  {onOpenDetail}
  {onOpenGamesPickerForCard}
  {onDelete}
  {onRestore}
  {onDeleteForever}
  {currentUserName}
/>
