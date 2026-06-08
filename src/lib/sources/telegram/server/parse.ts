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
// externalId carries the FULL "<channel>/<messageId>" data-post value, NOT the
// bare message id: Telegram message ids are per-channel sequential and are NOT
// globally unique (RESEARCH Q3), so the composite is the stable PK every
// downstream plan + the telegram_posts.post_id column depend on.

import { parse, type HTMLElement } from "node-html-parser";

export interface ParsedTelegramPost {
  externalId: string; // "<channel>/<messageId>" — full data-post value (RESEARCH Q3)
  publishedAt: Date | null; // <time datetime>
  viewCount: number | null; // normalized; null when the views span is absent
  textSnippet: string; // first line of .tgme_widget_message_text, truncated
  mediaKind: "photo" | "video" | "album" | null;
  thumbnailUrl: string | null; // hotlink (photo background-image or video poster)
}

export interface ParsedTelegramListing {
  channelTitle: string | null; // .tgme_channel_info_header_title (display name)
  status: "ok" | "not_found"; // content-based, HTTP-200-safe
  posts: ParsedTelegramPost[];
  nextBeforeCursor: string | null; // ?before cursor; null = end-of-history
}

export function parseTelegramListing(html: string): ParsedTelegramListing {
  const root = parse(html);
  const header = root.querySelector(".tgme_channel_info_header_title");
  const blocks = root.querySelectorAll("div.tgme_widget_message[data-post]");

  // not_found: HTTP 200 but no widget markers at all (RESEARCH §Availability).
  if (header === null && blocks.length === 0) {
    return { channelTitle: null, status: "not_found", posts: [], nextBeforeCursor: null };
  }

  const posts = blocks.map(parseBlock).filter((p): p is ParsedTelegramPost => p !== null);
  const nextBeforeCursor = extractBeforeCursor(root);
  return {
    channelTitle: header?.text?.trim() ?? null,
    status: "ok",
    posts,
    nextBeforeCursor,
  };
}

/** Parse the single message widget served by `t.me/<channel>/<id>?embed=1`
 *  (the warm-lane per-post path — this embed DOES carry the view span,
 *  RESEARCH Pitfall 2). Returns null when the page has no message block. */
export function parseTelegramPost(html: string): ParsedTelegramPost | null {
  const root = parse(html);
  const block = root.querySelector("div.tgme_widget_message[data-post]");
  if (block === null) return null;
  return parseBlock(block);
}

function parseBlock(el: HTMLElement): ParsedTelegramPost | null {
  const externalId = el.getAttribute("data-post"); // "durov/503" — keep FULL (RESEARCH Q3)
  if (!externalId) return null;

  const timeEl = el.querySelector("a.tgme_widget_message_date time[datetime]");
  const datetime = timeEl?.getAttribute("datetime");
  const publishedAt = datetime ? new Date(datetime) : null;

  const viewsEl = el.querySelector(".tgme_widget_message_views");
  const viewCount = viewsEl ? normalizeViewCount(viewsEl.text.trim()) : null;

  const textEl = el.querySelector(".tgme_widget_message_text");
  const textSnippet = (textEl?.text ?? "").trim().split("\n", 1)[0]!.slice(0, 280);

  const photos = el.querySelectorAll(".tgme_widget_message_photo_wrap");
  const hasVideo = el.querySelector(".tgme_widget_message_video_wrap, .js-message_video") !== null;
  const isAlbum = el.querySelector(".tgme_widget_message_grouped_wrap") !== null;
  const mediaKind = isAlbum ? "album" : photos.length > 0 ? "photo" : hasVideo ? "video" : null;

  const thumbnailUrl = extractFirstMediaUrl(el);

  // Empty-shell defense (D-01): a block with no views, no text, no media is a
  // service row the /s/ view never actually emits — skip it if it slips through.
  if (viewCount === null && textSnippet === "" && mediaKind === null) return null;

  return { externalId, publishedAt, viewCount, textSnippet, mediaKind, thumbnailUrl };
}

export function normalizeViewCount(s: string): number | null {
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
