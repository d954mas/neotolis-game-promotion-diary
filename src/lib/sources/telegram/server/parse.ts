// Telegram t.me/s HTML parser — PURE module (no DB, no fetch, no env).
//
// Parses the static server-rendered HTML of the public `t.me/s/<channel>`
// preview (and the single-post `t.me/<channel>/<id>?embed=1` widget) into a
// stable typed contract the adapter (Plan 04) consumes. Every selector below
// is the t.me/s public-embed contract, VERIFIED LIVE against the captured
// fixtures in tests/fixtures/telegram/ (Plan 01) — this markup has been
// stable for years and is exercised byte-exact by parse.test.ts.
//
// Two boundary checks are the ONLY validation here (AGENTS.md: no defensive
// validation for impossible cases — trust the fixture-verified DOM shape):
//   1. not_found is CONTENT-based: a nonexistent channel returns HTTP 200
//      (Telegram never 404s), so "missing" is signalled by the ABSENCE of any
//      tgme_channel_info / tgme_widget_message markers, never by status code.
//   2. A block with no .tgme_widget_message_views element → viewCount=null
//      (very new post or views disabled) — null is a chart GAP downstream,
//      never coerced to 0.
//
// externalId is the STABLE composite "<channelKey>/<messageId>", where channelKey
// is the rename-proof numeric channel id decoded from each post block's base64
// `data-view` payload (`{"c":<channelId>,...}`) and messageId is the part after
// the slash in `data-post`. The @username SLUG in `data-post` is renameable —
// keying a post on `<slug>/<messageId>` would re-key the SAME physical post on a
// channel rename (duplicate events + split metric history). channelKey survives
// renames, so it is the canonical PK every downstream plan + the
// telegram_posts.post_id column depend on (mirrors Instagram's stable media-id
// override of the renameable shortcode, normalize.ts).
//
// externalId is NULL when the block's data-view cannot be decoded to a numeric
// `c` (no channelKey): we NEVER fall back to a slug-based id (that is the
// rename-bug we are eliminating). A null-externalId post is RECOGNIZED but not
// materialized (the IG recognition-only rule, issue #69) — the caller skips it.
// The renameable @username is kept separately as `slug` for callers that need
// the handle (the canonical t.me URL, title fallback), but it is NEVER the key.

import { parse, type HTMLElement } from "node-html-parser";
import type { TelegramReaction } from "./schema/posts.js";

export type { TelegramReaction } from "./schema/posts.js";

export interface ParsedTelegramPost {
  // The STABLE composite "<channelKey>/<messageId>" — channelKey is the
  // rename-proof numeric channel id, NOT the @username slug (which a rename
  // would change, re-keying the same post). NULL when the block carries no
  // decodable data-view `c` (no channelKey): the caller treats a null-externalId
  // post as recognition-only and does NOT materialize a slug-keyed id for it.
  externalId: string | null;
  // The renameable @username from the data-post value (e.g. "durov"), kept for
  // callers that need the handle (canonical t.me URL, title fallback). NEVER the
  // post key — the key is channelKey-based (see externalId).
  slug: string;
  // The per-channel sequential message id (the part after the slash in
  // data-post). Numeric, globally NON-unique (RESEARCH Q3) — only the
  // <channelKey>/<messageId> composite is a stable PK.
  messageId: string;
  // Intrinsic numeric channel id from the post block's base64 `data-view`
  // payload (`{"c":<channelId>,...}`), as a STRING (to match
  // telegram_posts.channel_key). Rename-proof — the prefix of externalId AND
  // the group key for per-channel analytics. null only when the block carries no
  // decodable data-view (defensive; every live t.me/s block carries one) — in
  // which case externalId is also null (no slug fallback).
  channelKey: string | null;
  publishedAt: Date | null; // <time datetime>
  viewCount: number | null; // normalized; null when the views span is absent
  textSnippet: string; // first line of .tgme_widget_message_text, truncated
  mediaKind: "photo" | "video" | "album" | null;
  thumbnailUrl: string | null; // hotlink (photo background-image or video poster)
  // E1 second metric — reactions live ONLY on the t.me/s LISTING markup; the
  // ?embed=1 single-post page omits the reactions block (parseTelegramPost
  // returns reactionsTotal null / reactionsTop []). reactionsTotal is the sum
  // of every reaction count (standard + custom + paid), null when the post has
  // no reactions block (→ chart GAP, never 0). reactionsTop is the top-5
  // most-popular reactions (desc by count), [] when none.
  reactionsTotal: number | null;
  reactionsTop: TelegramReaction[];
}

export interface ParsedTelegramListing {
  // The channel's OWN scraped metadata from the listing header — the
  // source-of-truth for the telegram_channels subject entity (UPSERTed by the
  // listing-poll + backfill handlers). null on a not_found listing (no header to
  // parse) or when the header carries no decodable channel id. The display title
  // lives at channelHeader.title (no separate top-level shortcut — the only
  // consumers are the snapshot UPSERT, which reads the full header).
  channelHeader: ParsedTelegramChannelHeader | null;
  status: "ok" | "not_found"; // content-based, HTTP-200-safe
  posts: ParsedTelegramPost[];
  nextBeforeCursor: string | null; // ?before cursor; null = end-of-history
}

/** The channel's OWN scraped upstream metadata, parsed from the t.me/s listing
 *  header (the source-of-truth for telegram_channels). Every field is nullable —
 *  a header may be absent (single-post embed page, or a malformed/partial fetch)
 *  or carry only some fields. The write-path UPSERTs this and COALESCE-preserves
 *  prior good values on a partial parse, so a transient miss never blanks a
 *  working channel row. */
export interface ParsedTelegramChannelHeader {
  // Numeric channel id (string) — from a post block's data-view payload when the
  // listing carries posts (the header markup itself does not expose the id), the
  // rename-proof PK of telegram_channels. null when no post block decodes a `c`.
  channelKey: string | null;
  slug: string | null; // current @username (without the leading '@')
  title: string | null;
  avatarUrl: string | null;
  description: string | null;
  subscriberCount: number | null; // normalized (K/M-expanded), null when absent
}

export function parseTelegramListing(html: string): ParsedTelegramListing {
  const root = parse(html);
  const header = root.querySelector(".tgme_channel_info_header_title");
  const blocks = root.querySelectorAll("div.tgme_widget_message[data-post]");

  // not_found: HTTP 200 but no widget markers at all (RESEARCH §Availability).
  if (header === null && blocks.length === 0) {
    return {
      channelHeader: null,
      status: "not_found",
      posts: [],
      nextBeforeCursor: null,
    };
  }

  const posts = blocks.map(parseBlock).filter((p): p is ParsedTelegramPost => p !== null);
  const nextBeforeCursor = extractBeforeCursor(root);
  const channelHeader = parseChannelHeaderFromRoot(root, posts);
  return {
    channelHeader,
    status: "ok",
    posts,
    nextBeforeCursor,
  };
}

/** Parse the single message widget served by `t.me/<channel>/<id>?embed=1`
 *  (the warm-lane per-post path — this embed DOES carry the view span,
 *  RESEARCH Pitfall 2). Returns null when the page has no message block.
 *
 *  REACTIONS are deliberately NULLED on this path (E1): the t.me/s LISTING is
 *  the single source of truth for the reaction tally, polled on the free
 *  page-1 cadence. The warm-lane embed exists only to keep an off-listing
 *  post's VIEW count fresh; letting it also write reactions would fork the
 *  reactions metric across two cadences (and the embed's tally can lag the
 *  listing's). So the embed path drops reactions even when the markup is
 *  present — only the listing path (parseBlock via parseTelegramListing)
 *  carries them downstream. */
export function parseTelegramPost(html: string): ParsedTelegramPost | null {
  const root = parse(html);
  const block = root.querySelector("div.tgme_widget_message[data-post]");
  if (block === null) return null;
  const parsed = parseBlock(block);
  if (parsed === null) return null;
  return { ...parsed, reactionsTotal: null, reactionsTop: [] };
}

function parseBlock(el: HTMLElement): ParsedTelegramPost | null {
  // data-post is "<slug>/<messageId>" (e.g. "durov/503"). The slug is the
  // RENAMEABLE @username; split it out but NEVER key on it.
  const dataPost = el.getAttribute("data-post");
  if (!dataPost) return null;
  const slash = dataPost.indexOf("/");
  if (slash <= 0 || slash === dataPost.length - 1) return null;
  // Lowercase per the "slugs are lowercase everywhere" invariant (url.ts:44-49):
  // url.ts lowercases the URL-parsed handle, so the slug we store on external_url
  // must match — else resolveCachedExternalId's external_url lookup misses for an
  // uppercase @Username channel.
  const slug = dataPost.slice(0, slash).toLowerCase();
  const messageId = dataPost.slice(slash + 1);

  // channelKey is the rename-proof prefix of the stable post id. When it cannot
  // be decoded, externalId is NULL — we do NOT fall back to a slug-based id (the
  // rename bug). A null-externalId post is recognized but not materialized.
  const channelKey = decodeChannelKey(el.getAttribute("data-view"));
  const externalId = channelKey !== null ? `${channelKey}/${messageId}` : null;

  const timeEl = el.querySelector("a.tgme_widget_message_date time[datetime]");
  const datetime = timeEl?.getAttribute("datetime");
  const publishedAt = datetime ? new Date(datetime) : null;

  const viewsEl = el.querySelector(".tgme_widget_message_views");
  const viewCount = viewsEl ? parseAbbreviatedCount(viewsEl.text.trim()) : null;

  const textEl = el.querySelector(".tgme_widget_message_text");
  const textSnippet = (textEl?.text ?? "").trim().split("\n", 1)[0]!.slice(0, 280);

  const photos = el.querySelectorAll(".tgme_widget_message_photo_wrap");
  const hasVideo = el.querySelector(".tgme_widget_message_video_wrap, .js-message_video") !== null;
  const isAlbum = el.querySelector(".tgme_widget_message_grouped_wrap") !== null;
  const mediaKind = isAlbum ? "album" : photos.length > 0 ? "photo" : hasVideo ? "video" : null;

  const thumbnailUrl = extractFirstMediaUrl(el);

  const { reactionsTotal, reactionsTop } = parseReactions(el);

  // Empty-shell defense (D-01): a block with no views, no text, no media is a
  // service row the /s/ view never actually emits — skip it if it slips through.
  if (viewCount === null && textSnippet === "" && mediaKind === null) return null;

  return {
    externalId,
    slug,
    messageId,
    channelKey,
    publishedAt,
    viewCount,
    textSnippet,
    mediaKind,
    thumbnailUrl,
    reactionsTotal,
    reactionsTop,
  };
}

/** Decode a post block's base64 `data-view` attribute to the intrinsic numeric
 *  channel id (`c`), returned as a STRING (to match telegram_posts.channel_key).
 *  The payload shape is `{"c":<channelId>,"p":<messageId>,"t":<ts>,"h":"…"}`;
 *  `c` is a (often negative) integer that is stable across @username renames —
 *  the rename-proof group key. Returns null on a missing/undecodable attr or a
 *  payload without a numeric `c` (defensive — every live t.me/s block carries
 *  one). */
function decodeChannelKey(dataView: string | undefined): string | null {
  if (!dataView) return null;
  try {
    const json = Buffer.from(dataView, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "c" in parsed &&
      typeof (parsed as { c: unknown }).c === "number"
    ) {
      return String((parsed as { c: number }).c);
    }
  } catch {
    return null;
  }
  return null;
}

/** Parse the channel's own metadata from the t.me/s listing header — the
 *  source-of-truth fields for telegram_channels (title / @username slug / avatar
 *  / description / subscriber count). The numeric channelKey is NOT in the
 *  header markup, so it is lifted from the first post block that decodes a
 *  data-view `c` (the same id every block carries). Returns all-null fields when
 *  the header is absent (single-post embed, or a partial/malformed fetch) — the
 *  write-path COALESCE-preserves prior good values on a partial parse. */
export function parseTelegramChannelHeader(html: string): ParsedTelegramChannelHeader {
  return parseChannelHeaderFromRoot(parse(html), null);
}

/** Shared header extraction over an already-parsed root. `posts` (when known —
 *  parseTelegramListing passes its parsed posts) supplies the channelKey from a
 *  post block's data-view without re-querying; pass null to fall back to a fresh
 *  DOM scan of the data-view blocks (the stand-alone parseTelegramChannelHeader
 *  path). */
function parseChannelHeaderFromRoot(
  root: HTMLElement,
  posts: ParsedTelegramPost[] | null,
): ParsedTelegramChannelHeader {
  const titleEl = root.querySelector(".tgme_channel_info_header_title");
  const title = titleEl?.text?.trim() || null;

  // @username lives in the header's username anchor (e.g. "@durov"); strip the
  // leading '@' for the stored slug.
  const usernameEl = root.querySelector(".tgme_channel_info_header_username a");
  const usernameRaw = usernameEl?.text?.trim() ?? "";
  // Lowercase per the "slugs are lowercase everywhere" invariant (url.ts:44-49):
  // data_sources.metadata.channel is lowercased at parse, so the stored
  // telegram_channels.slug must match — else the channel-name JOIN
  // (enrichTelegramSourcesWithChannelTitle) silently misses for an uppercase
  // @Username and the source/feed cards degrade to the @handle forever.
  const slug = usernameRaw.replace(/^@/, "").toLowerCase() || null;

  // og:image is the channel avatar on the listing page (a stable hotlink).
  const ogImage = root.querySelector('meta[property="og:image"]')?.getAttribute("content")?.trim();
  const avatarUrl = ogImage || null;

  const descEl = root.querySelector(".tgme_channel_info_description");
  const description = descEl?.text?.trim() || null;

  const subscriberCount = extractSubscriberCount(root);

  // channelKey: the header markup has no id, so lift it from a post block's
  // data-view. Prefer the already-parsed posts (no re-query); else scan the DOM.
  let channelKey: string | null = null;
  if (posts !== null) {
    channelKey = posts.find((p) => p.channelKey !== null)?.channelKey ?? null;
  } else {
    for (const block of root.querySelectorAll("div.tgme_widget_message[data-post]")) {
      const key = decodeChannelKey(block.getAttribute("data-view"));
      if (key !== null) {
        channelKey = key;
        break;
      }
    }
  }

  return { channelKey, slug, title, avatarUrl, description, subscriberCount };
}

/** Pull the "N subscribers" counter from the header's counters block. The
 *  markup is a list of `.tgme_channel_info_counter` entries (subscribers /
 *  photos / videos / links) — pick the one whose `.counter_type` is
 *  "subscribers" and normalize its `.counter_value` (same K/M abbreviation as
 *  view counts → reuse parseAbbreviatedCount). null when no subscribers counter
 *  is present (a private/empty channel header). */
function extractSubscriberCount(root: HTMLElement): number | null {
  for (const counter of root.querySelectorAll(".tgme_channel_info_counter")) {
    const type = counter.querySelector(".counter_type")?.text?.trim().toLowerCase();
    if (type === "subscribers") {
      const value = counter.querySelector(".counter_value")?.text?.trim();
      return value ? parseAbbreviatedCount(value) : null;
    }
  }
  return null;
}

const TOP_REACTIONS_CAP = 5;

/** Parse the LISTING-only reactions block (E1). The ?embed=1 single-post page
 *  has no reactions container → returns total=null, top=[]. Three kinds:
 *    - standard: `<i class="emoji"><b>😁</b></i>4` → emoji char from <b>,
 *      kind="standard".
 *    - custom/premium: `<tg-emoji emoji-id="…"></tg-emoji>5.87K` → no unicode
 *      char (sticker by id), kind="custom", emoji=null.
 *    - paid (Telegram Stars): `<span class="tgme_reaction tgme_reaction_paid">
 *      <i class="icon icon-telegram-stars"></i>8.19K</span>` → kind="paid",
 *      emoji=null.
 *  Counts are the trailing text node (the same K/M abbreviation as views →
 *  reuse parseAbbreviatedCount). A reactions block with zero parseable counts
 *  (defensive) yields total=null, top=[]. */
function parseReactions(el: HTMLElement): {
  reactionsTotal: number | null;
  reactionsTop: TelegramReaction[];
} {
  const container = el.querySelector(".tgme_widget_message_reactions");
  if (container === null) return { reactionsTotal: null, reactionsTop: [] };

  const reactions: TelegramReaction[] = [];
  for (const span of container.querySelectorAll(".tgme_reaction")) {
    // The count is the trailing text of the span AFTER its leading emoji/icon
    // child. node-html-parser's `.text` concatenates a standard emoji's <b> char
    // into the span text ("😁4"), so strip a present emoji char before
    // normalizing; custom/paid spans carry only the count text.
    const isPaid = span.classList.contains("tgme_reaction_paid");
    const emojiBold = span.querySelector("i.emoji > b");
    const emoji = emojiBold?.text?.trim() || null;
    const kind: TelegramReaction["kind"] = isPaid ? "paid" : emoji !== null ? "standard" : "custom";

    const rawText = span.text;
    const countText = emoji !== null ? rawText.replace(emoji, "") : rawText;
    const count = parseAbbreviatedCount(countText.trim());
    if (count === null) continue;
    reactions.push({ emoji, kind, count });
  }

  if (reactions.length === 0) return { reactionsTotal: null, reactionsTop: [] };

  const reactionsTotal = reactions.reduce((sum, r) => sum + r.count, 0);
  const reactionsTop = [...reactions].sort((a, b) => b.count - a.count).slice(0, TOP_REACTIONS_CAP);
  return { reactionsTotal, reactionsTop };
}

/** Parse a Telegram K/M-abbreviated count into an integer. Used for view counts,
 *  subscriber counts, AND reaction counts — every numeric the t.me/s markup
 *  renders with the same "12.3K" / "1.2M" / plain-integer abbreviation. null on
 *  empty / unparseable input (a chart GAP downstream, never coerced to 0). */
export function parseAbbreviatedCount(s: string): number | null {
  const m = /^([\d.]+)\s*([KM]?)$/i.exec(s.trim());
  if (!m) return null;
  const n = Number.parseFloat(m[1]!);
  if (Number.isNaN(n)) return null;
  const suffix = m[2]!.toUpperCase();
  const mult = suffix === "M" ? 1e6 : suffix === "K" ? 1e3 : 1;
  return Math.round(n * mult);
}

// The next-page cursor lives on the inner `a.tme_messages_more.js-messages_more`
// anchor (its `data-before` attr), NOT on the `js-messages_more_wrap` DIV that
// wraps it — the RESEARCH pseudo-code keyed on the wrapper, which carries no
// data-before in the live markup. Verified against listing-healthy (503) and
// listing-before-page (481). Absent anchor → null = end-of-history.
function extractBeforeCursor(root: HTMLElement): string | null {
  const moreEl = root.querySelector("a.js-messages_more[data-before]");
  return moreEl?.getAttribute("data-before") ?? null;
}

function extractFirstMediaUrl(el: HTMLElement): string | null {
  const photo = el.querySelector(".tgme_widget_message_photo_wrap");
  const photoUrl = backgroundImageUrl(photo?.getAttribute("style"));
  if (photoUrl !== null) return photoUrl;

  const videoThumb = el.querySelector(".tgme_widget_message_video_thumb");
  return backgroundImageUrl(videoThumb?.getAttribute("style"));
}

function backgroundImageUrl(style: string | undefined): string | null {
  if (!style) return null;
  const m = /background-image:\s*url\('([^']+)'\)/.exec(style);
  return m ? m[1]! : null;
}
