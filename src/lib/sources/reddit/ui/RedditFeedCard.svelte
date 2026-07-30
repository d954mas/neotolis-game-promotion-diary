<script lang="ts">
  // RedditFeedCard — per-platform variant for kind=reddit_post (D-06: an ADAPTIVE
  // self / link / image / gallery card forked from TwitterFeedCard).
  //
  // Composed from $lib/components/feed/parts/BaseFeedCard.svelte so the markup shell
  // + click handling + menu + footer is identical to the default FeedCard. This file
  // enforces the Reddit read paths per AGENTS.md no-denorm AND the adaptive layout:
  //
  //   - sourceLabel: the subreddit slug (r/<sub>) — intrinsic to the Reddit URL and
  //     rename-proof (Reddit forbids subreddit rename), the ONLY safe denormalization
  //     — or the account handle/displayName from data_sources via the `source` prop
  //     (FK lookup at /feed loader time). Falls back to the URL-intrinsic slug from
  //     event metadata, never a renameable display value.
  //   - thumbnail: redditEnrichment.thumbnailUrl — the raw i.redd.it cover HOTLINKED
  //     directly (12-SPIKE Pitfall 5 — NO same-origin proxy; image/gallery variant
  //     un-sampled by the spike, owed at the Plan 12-06 UAT via the browser hotlink
  //     test). FREQUENTLY NULL (ScrapeCreators omits `thumbnail`; only SINGLE-image
  //     posts derive one — a GALLERY has media_type gallery but NO cover URL).
  //     BaseFeedCard carries referrerpolicy=no-referrer + loading=lazy and swaps to
  //     the .card-thumb.empty KindIcon placeholder on <img> onerror (an expired CDN
  //     cover OR a blocked hotlink — the latched fallback).
  //   - stats: redditEnrichment.stats.{likeCount,commentCount} — the post's own polling
  //     data (owned by reddit_post_snapshots), not denormalized. Metrics-by-presence
  //     (D-09): render a metric ONLY when non-null. Reddit exposes exactly TWO metrics
  //     — NO views chip, NO shares chip (Reddit surfaces neither, 12-SPIKE Q4).
  //
  //   - ADAPTIVE D-06 layout, keyed on the post FORM (redditEnrichment.mediaType), NOT
  //     on cover presence: an IMAGE / GALLERY post RESERVES the media slot (forceThumbSlot)
  //     so it shows the hotlinked cover when present, else the KindIcon placeholder +
  //     the "Carousel" pill — a gallery (no cover URL) and an image whose hotlink 403s
  //     both keep their media identity instead of silently collapsing to a text card. A
  //     SELF (text) / LINK post reserves NO slot and is text-forward (title/notes focal).
  //
  // Registered via ./index.ts as `cardComponent` so /feed/+page.svelte's
  // `getCardComponent("reddit_post")` returns this component.

  import { m } from "$lib/paraglide/messages.js";
  import BaseFeedCard from "$lib/components/feed/parts/BaseFeedCard.svelte";
  import StatChips from "$lib/components/feed/parts/StatChips.svelte";
  import { deriveMediaTypeOverlay } from "$lib/components/feed/parts/media-type-overlay.js";
  import {
    formatStat,
    redditSubredditLabel,
    type CardEventLite,
    type CardSourceLite,
  } from "$lib/components/feed/parts/derive-card-data.js";

  type GameLite = { id: string; title: string };

  let {
    event,
    source,
    games,
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
    source?: CardSourceLite | null;
    game?: GameLite | null;
    games: GameLite[];
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

  // WHERE the post lives is ALWAYS the top .src line (12-06 UAT decision): the
  // subreddit is a reddit post's primary identity regardless of which source
  // imported it, so the r/<sub> ↔ u/<author> pair never swaps places between an
  // account-sourced and a subreddit-sourced card. Resolution order:
  //   1. the post's own cache row (enrichment subredditSlug — walk-written), with
  //      the u_<name> pseudo-subreddit rendered u/<name> the way Reddit does;
  //   2. the URL-intrinsic metadata slug (redditSubredditLabel — rename-proof, the
  //      one sanctioned denormalization);
  //   3. subreddit unknown (bare /comments/<id> or redd.it paste) — the registered
  //      source's live name with the kind sigil re-applied. The stored displayName
  //      is the BARE slug/handle ("gamedev") — never double-prefix one that
  //      already carries a sigil.
  const sourceLabel = $derived.by((): string => {
    const slug = event.redditEnrichment?.subredditSlug ?? null;
    if (slug !== null && slug !== "") {
      return slug.startsWith("u_") ? `u/${slug.slice(2)}` : `r/${slug}`;
    }
    const fromUrl = redditSubredditLabel(event.metadata);
    if (fromUrl !== "") return fromUrl;
    const raw = source?.channelTitle ?? source?.displayName ?? null;
    if (raw === null || raw === "") return "";
    if (/^[ru]\//i.test(raw)) return raw;
    if (source?.kind === "reddit_account") return `u/${raw}`;
    if (source?.kind === "reddit_subreddit") return `r/${raw}`;
    return raw;
  });

  // WHO wrote it + (for LINK posts) where it points — always UNDER the community
  // line (the fixed "where → who → destination" order, 12-06 UAT). The author part:
  // a subreddit feed / foreign paste carries OTHER people's posts, and without it
  // the card showed only r/<sub> — the author was invisible. Rendered from the
  // event's own author_handle snapshot (the source-less-paste pattern
  // resolveSourceLabel already blesses; the deletion purge scrubs it to null),
  // skipped only when it would repeat the top line (a PROFILE post's src is
  // already u/<name>). The domain part (D-06 adaptive link card — "title +
  // domain"): the outbound destination host is IMMUTABLE post content, rendered as
  // muted TEXT only (domain, never the full URL — no href surface).
  const bylineLabel = $derived.by((): string | null => {
    const parts: string[] = [];
    const author = event.authorHandle ?? null;
    if (author !== null && author !== "") {
      const label = `u/${author}`;
      if (label.toLowerCase() !== sourceLabel.toLowerCase()) parts.push(label);
    }
    const linkDomain = event.redditEnrichment?.linkDomain ?? null;
    if (event.redditEnrichment?.mediaType === "link" && linkDomain !== null && linkDomain !== "") {
      parts.push(linkDomain);
    }
    return parts.length > 0 ? parts.join(" · ") : null;
  });

  // Deleted-on-Reddit notice. The enrichment has always carried this and the event
  // DETAIL rendered it, but the card type dropped the field — so a deleted post looked
  // completely normal in the feed and the only way to find out was to open it.
  const deletedAt = $derived(event.redditEnrichment?.deletionDetectedAt ?? null);

  // D-06 adaptive: media-ness is the post FORM, not cover presence. An image / gallery
  // post reserves the media slot (forceThumbSlot below) even when it has NO usable cover
  // (a gallery never derives one; an image's hotlink can fail) so its media identity +
  // pill survive. A self / link post reserves no slot → text-forward.
  const rawThumb = $derived(event.redditEnrichment?.thumbnailUrl ?? null);
  const mediaType = $derived(event.redditEnrichment?.mediaType ?? null);
  const isMediaPost = $derived(mediaType === "image" || mediaType === "gallery");

  // Hotlink expiry OR a blocked i.redd.it fetch → the onerror latch → null thumbnail →
  // BaseFeedCard renders the .card-thumb.empty KindIcon placeholder (the slot stays via
  // forceThumbSlot). `thumbErrored` latches on the <img> onerror so a transient
  // placeholder doesn't flicker back.
  let thumbErrored = $state(false);
  const thumbnailUrl = $derived.by(() => (thumbErrored ? null : rawThumb));

  const stats = $derived(event.redditEnrichment?.stats ?? null);

  // Media-type pill (gallery → "Carousel"). A self / link / single-image post maps to
  // null → no pill. The kind→pill decision lives in ONE shared place
  // (deriveMediaTypeOverlay) used by the feed cards AND the event detail. BaseFeedCard
  // renders the icon+text pill over a present <img> only.
  const overlay = $derived.by(() => deriveMediaTypeOverlay(event));
</script>

{#snippet deletedSnippet()}
  <p class="reddit-deleted" role="status">{m.feed_card_reddit_deleted()}</p>
{/snippet}

<BaseFeedCard
  {event}
  {sourceLabel}
  {bylineLabel}
  {thumbnailUrl}
  {games}
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
  statsSlot={statsSnippet}
  extraSlot={deletedAt ? deletedSnippet : undefined}
  thumbnailOverlay={overlay}
  forceThumbSlot={isMediaPost}
  onThumbnailError={() => (thumbErrored = true)}
/>

{#snippet statsSnippet()}
  {#if stats && (stats.likeCount !== null || stats.commentCount !== null)}
    <!-- Reddit exposes exactly TWO metrics: likes (= score / net ups) + comments,
         each presence-gated. NO views chip, NO shares chip (Reddit surfaces neither,
         12-SPIKE Q4 / D-09). -->
    <div class="card-stats stats-line">
      <StatChips
        chips={[
          { metric: "likes", value: stats.likeCount === null ? null : formatStat(stats.likeCount) },
          {
            metric: "comments",
            value: stats.commentCount === null ? null : formatStat(stats.commentCount),
          },
        ]}
      />
    </div>
  {/if}
{/snippet}

<style>
  .reddit-deleted {
    margin: var(--space-1) 0 0;
    padding: var(--space-1) var(--space-2);
    border: 1px dashed var(--danger-border, var(--border-1));
    border-radius: var(--radius-1);
    color: var(--danger-text, var(--text-2));
    font-size: var(--font-size-0);
  }
</style>
