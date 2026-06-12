// Shared building blocks for the two wishlist charts on /games/[gameId]:
// WishlistCorrelationChart (cumulative lines) and WishlistGrowthChart (daily
// net-change bars). Both read the SAME loader maps, the SAME per-listing
// palette, the SAME date-range filter, and the SAME event markers — factoring
// these here keeps the two charts reading as one coherent picture and avoids
// two divergent copies of the marker/series math (KISS/DRY: three concrete
// callers — line series, growth bars, markers — earn the helper).
//
// 04-13: both charts now render their markers via the SHARED HTML overlay
// (ChartMarkerOverlay), so the old canvas buildMarkLineData (growth chart) is
// gone — the overlay's DOM chips + dashed guide line replaced it. buildDayGroups
// + eventThumbnail (which the overlay consumes) stay.

import {
  isImageLikeUrl,
  readMediaUrlFromMetadata,
} from "$lib/components/feed/parts/derive-card-data.js";
import { kindIconSvg } from "$lib/components/kind-icon-svg.js";
import type { EventDto } from "$lib/server/dto.js";

/** A single Steam listing as the charts need it (id + display name / appId). */
export type ListingLite = { id: string; name?: string | null; appId?: number };

/**
 * Per-line palette — distinct from the `--k-*` kind colors (those belong to the
 * event markers). Both charts index this by the listing's position in the
 * `listings` array so a given listing is the SAME color on both charts. Cycles
 * when there are more listings than entries.
 */
export const LINE_PALETTE = [
  "#5b8def",
  "#e0a458",
  "#5fb98e",
  "#c25b9e",
  "#7d6ad6",
  "#d2705a",
] as const;

export function paletteColor(index: number): string {
  return LINE_PALETTE[index % LINE_PALETTE.length]!;
}

/**
 * The SINGLE stable listing→color resolver. Keyed by the listing's index in the
 * FULL `listings` array (never a filtered/visible subarray) so a listing's
 * swatch, its line, and its growth bar are ALWAYS the same color, and hiding one
 * listing never reshuffles another's color. Both wishlist charts AND the
 * ChartLegend call this — one source of truth for the per-listing palette.
 * Unknown id (defensive) → palette index 0.
 */
export function listingColor(listings: ListingLite[], listingId: string): string {
  const i = listings.findIndex((l) => l.id === listingId);
  return paletteColor(i < 0 ? 0 : i);
}

/** YYYY-MM-DD in LOCAL time (matches the daily point keys + the range Dates). */
export function isoDay(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/**
 * A date-only "YYYY-MM-DD" → LOCAL-midnight epoch ms — the SINGLE conversion
 * every date-only value passes through before it hits the ECharts `type:"time"`
 * axis (line/bar x, axis domain, the overlay's convertToPixel arg).
 *
 * Why: ECharts parses a bare date string as UTC midnight → renders a day early
 * in a negative-offset zone (axis label, day-lookup, delta matching all drift).
 * Local midnight makes `isoDay(new Date(dayToLocalMs(day)))` an identity, so the
 * axis, the lookup keys, and the markers stay in agreement.
 */
export function dayToLocalMs(day: string): number {
  const [y, mo, d] = day.split("-").map(Number);
  return new Date(y ?? 1970, (mo ?? 1) - 1, d ?? 1).getTime();
}

/** range === null ⇒ all time. Otherwise [from, to] inclusive on YYYY-MM-DD. */
export function inRange(dateStr: string, range: { from: Date; to: Date } | null): boolean {
  if (!range) return true;
  return dateStr >= isoDay(range.from) && dateStr <= isoDay(range.to);
}

/** Truncate an event's occurredAt to its YYYY-MM-DD day (markers are day-level).
 *  Accepts any event-like value with an `occurredAt` so both the full EventDto
 *  (chart series) and the page's FeedCard-shaped event subset can resolve the
 *  SAME day key (the page filters its events by this to populate the modal). */
export function eventDay(e: { occurredAt: Date | string }): string {
  const d = typeof e.occurredAt === "string" ? new Date(e.occurredAt) : e.occurredAt;
  // LOCAL day (isoDay), NOT toISOString (UTC): the wishlist points, the axis, and
  // the crosshair day-lookup are all local, so a near-midnight event must key local.
  return isoDay(d);
}

/**
 * A DISTINCT event-day, collapsing all events that day into one marker (D-04).
 * `mixedKind` → the marker uses the neutral `--k-post` color; otherwise the
 * single kind's color.
 */
export type DayGroup = { date: string; events: EventDto[]; mixedKind: boolean; kind: string };

/**
 * Group events by day, filtered to the visible range, sorted date-ASC. Shared
 * by both charts so a growth bar and a line marker land on the same x position.
 */
export function buildDayGroups(
  events: EventDto[],
  range: { from: Date; to: Date } | null,
): DayGroup[] {
  const byDay = new Map<string, EventDto[]>();
  for (const e of events) {
    const day = eventDay(e);
    if (!inRange(day, range)) continue;
    const arr = byDay.get(day);
    if (arr) arr.push(e);
    else byDay.set(day, [e]);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, evs]) => {
      const mixedKind = new Set(evs.map((e) => e.kind)).size > 1;
      return { date, events: evs, mixedKind, kind: evs[0]!.kind };
    });
}

/**
 * The SINGLE source of the event→thumbnail URL logic for the charts. Mirrors
 * `deriveThumbnailUrl` (derive-card-data.ts) so a marker shows the SAME preview
 * image the FeedCard does — by reading each kind's ENRICHMENT OBJECT (the
 * `<kind>Enrichment` decoration the games loader hangs on the dto via
 * `adapter.enrichFeedDtos`), not per-kind `event.metadata` branches. The input
 * is structurally typed because the chart consumes EventDto-shaped rows that
 * the loader already enriched (so `redditEnrichment.linkUrl` /
 * `telegramEnrichment.thumbnailUrl` are present at runtime even though the
 * static EventDto type doesn't declare them).
 *
 *   - YouTube (`kind==="youtube_video"` + externalId) → the intrinsic
 *     `img.youtube.com/vi/{externalId}/mqdefault.jpg` (no enrichment needed —
 *     externalId IS the video id, part of the canonical URL).
 *   - Reddit → the enrichment `linkUrl` when it's image-like, else the
 *     `metadata.media.url` snapshot (same chain the RedditFeedCard renders).
 *   - Twitter → `metadata.media.url` (no enrichment object; the same chain
 *     derive-card-data.ts serves on the card). The D-09 refactor dropped this
 *     branch — restoring it keeps the chart marker in sync with the card.
 *   - Instagram → `instagramEnrichment.thumbnailUrl` (set by
 *     sources/instagram/server/feed-enrichment.ts).
 *   - Telegram → `telegramEnrichment.thumbnailUrl` (set by
 *     sources/telegram/server/feed-enrichment.ts). Phase 10 D-09: this was the
 *     bug — the old branch read empty `event.metadata` and the type didn't even
 *     carry telegramEnrichment, so every Telegram marker rendered blank.
 *   - TikTok → the same-origin proxy `/api/tiktok/thumbnail/{externalId}` (NOT
 *     the raw `tiktokEnrichment.thumbnailUrl`). 10-SPIKE.md Q3 RESOLVED at Plan 05
 *     UAT: the TikTok CDN cover is hotlink-BLOCKED in a real browser
 *     (net::ERR_BLOCKED_BY_ORB), so the chart marker — like the card — must route
 *     through the proxy or every TikTok marker renders blank. Versioned by the
 *     latest poll timestamp (?v=) when present, exactly like the card's
 *     deriveThumbnailUrl, so a re-poll busts the marker's cached cover too.
 *   - everything else → null (the marker falls back to a kind-colored
 *     placeholder symbol).
 */
type ThumbnailEvent = {
  kind: string;
  externalId: string | null;
  metadata: unknown;
  redditEnrichment?: { linkUrl?: string | null } | null;
  instagramEnrichment?: { thumbnailUrl?: string | null } | null;
  telegramEnrichment?: { thumbnailUrl?: string | null } | null;
  tiktokEnrichment?: {
    thumbnailUrl?: string | null;
    stats?: { polledAt?: Date | string } | null;
  } | null;
};

export function eventThumbnail(event: ThumbnailEvent): string | null {
  if (event.kind === "youtube_video") {
    if (!event.externalId) return null;
    return `https://img.youtube.com/vi/${event.externalId}/mqdefault.jpg`;
  }
  if (event.kind === "reddit_post") {
    const link = event.redditEnrichment?.linkUrl ?? null;
    if (link && isImageLikeUrl(link)) return link;
    return readMediaUrlFromMetadata(event.metadata);
  }
  if (event.kind === "twitter_post") {
    // Twitter has no enrichment object — its thumbnail lives on metadata.media.url
    // (the same chain derive-card-data.ts serves on the feed card). The D-09
    // refactor dropped this branch; restoring it keeps the chart marker in sync
    // with the card. (telegram stays enrichment-only per D-09 — its metadata is
    // intentionally NOT read here.)
    return readMediaUrlFromMetadata(event.metadata);
  }
  if (event.kind === "instagram_post") {
    return event.instagramEnrichment?.thumbnailUrl ?? null;
  }
  if (event.kind === "telegram_post") {
    return event.telegramEnrichment?.thumbnailUrl ?? null;
  }
  if (event.kind === "tiktok_post") {
    // 10-SPIKE.md Q3 RESOLVED (Plan 05 UAT): the TikTok CDN cover is hotlink-
    // BLOCKED in a real browser (net::ERR_BLOCKED_BY_ORB), so route the marker
    // through the same-origin proxy keyed by the aweme id — the SAME path the
    // FeedCard's deriveThumbnailUrl uses — or every TikTok marker renders blank.
    if (event.tiktokEnrichment?.thumbnailUrl == null || !event.externalId) return null;
    const base = `/api/tiktok/thumbnail/${encodeURIComponent(event.externalId)}`;
    const polledAt = event.tiktokEnrichment.stats?.polledAt;
    return polledAt ? `${base}?v=${new Date(polledAt).getTime()}` : base;
  }
  return null;
}

/**
 * X-axis domain for the `type:"time"` charts = the UNION of every wishlist
 * point date (across ALL listings, NOT the visibility-filtered subset) and
 * every event day, clamped to the selected range.
 *
 * Why: ECharts auto-fits a `type:"time"` axis to the SERIES data (the wishlist
 * points). When a game's wishlist CSV covers only a few recent days but its
 * events span weeks earlier, every event marker lands LEFT of the auto domain
 * and renders off-screen. Forcing min/max to the union of points ∪ events keeps
 * the markers on-canvas. Derived from ALL listings' points so toggling a
 * listing off never collapses the axis.
 *
 * - `range` set → `{ min: from, max: to }` (the user's window is authoritative;
 *   markers outside it are already filtered by buildDayGroups).
 * - else, non-empty list → `{ min: earliest, max: latest+1d }` (pad the max one
 *   day so the last marker isn't flush on the right edge).
 * - else (no points, no events) → null (let ECharts auto-fit).
 *
 * Returns LOCAL-midnight ms (dayToLocalMs) — the same basis as the series data
 * and markers, so both charts' axes (and their markers) line up.
 */
export function axisDomain(
  allPointDates: string[],
  dayGroups: { date: string }[],
  range: { from: Date; to: Date } | null,
): { min: number; max: number } | null {
  if (range) return { min: dayToLocalMs(isoDay(range.from)), max: dayToLocalMs(isoDay(range.to)) };
  const dates = [...allPointDates, ...dayGroups.map((g) => g.date)];
  if (dates.length === 0) return null;
  let min = dates[0]!;
  let max = dates[0]!;
  for (const d of dates) {
    if (d < min) min = d;
    if (d > max) max = d;
  }
  // Pad the max by one day (LOCAL) so the rightmost marker isn't on the axis edge.
  const maxDate = new Date(dayToLocalMs(max));
  maxDate.setDate(maxDate.getDate() + 1);
  return { min: dayToLocalMs(min), max: maxDate.getTime() };
}

/**
 * A compact day label for the marker overlay's rich tooltip + the per-event
 * "which day" hint ("May 27"). Locale is fixed "en" to match the rest of the
 * app's date convention (format-feed-date.ts) and to keep CI assertions stable
 * on any host machine. Takes an event-like `occurredAt` so it reuses the SAME
 * input the marker math already threads.
 */
export function markerDayLabel(e: { occurredAt: Date | string }): string {
  const d = typeof e.occurredAt === "string" ? new Date(e.occurredAt) : e.occurredAt;
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en", { month: "short", day: "numeric" });
}

/**
 * Kind → concrete hex color, mirroring the `--k-*` tokens in app.css. The
 * crosshair axis tooltip's no-preview event rows render the kind icon on a
 * kind-colored TILE (this hex is the tile background); that HTML is built here (a
 * pure string builder, no Svelte/DOM context) so a CONCRETE hex is required — a
 * `var(--k-*)` would not resolve in this string-building path the way it does
 * inside a component's <style>. Kept in lock-step with app.css's `--k-*` palette
 * (one map, the single source for the tooltip's tile colors). Mixed-kind /
 * unknown → the neutral post grey.
 */
const KIND_HEX: Record<string, string> = {
  youtube_video: "#e0625c",
  reddit_post: "#e08555",
  twitter_post: "#6fa0d1",
  telegram_post: "#5baac8",
  discord_drop: "#7a82d6",
  instagram_post: "#d167a6",
  conference: "#7fb46a",
  talk: "#d8b259",
  press: "#b488d4",
  post: "#8a8a95",
  other: "#8a8a95",
};

function kindHex(kind: string): string {
  return KIND_HEX[kind] ?? "#8a8a95";
}

/** Minimal HTML-escape for user-supplied strings interpolated into tooltip HTML. */
function escapeTooltipHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The shape of the crosshair-tooltip events builder: a day key + the day groups
 * + a localized "+K more" label → an HTML fragment. Both charts consume this one
 * builder (tooltipEventsHtml) so a day's events read identically in either
 * tooltip — the named type documents that shared contract.
 */
export type TooltipEvents = (
  day: string,
  dayGroups: DayGroup[],
  moreLabel: (count: number) => string,
) => string;

/** Max event rows shown inline in the tooltip before folding into a "+K" line. */
const TOOLTIP_EVENT_ROWS = 4;
/** The fixed thumbnail/dot square size (px) for a tooltip event row. */
const TOOLTIP_THUMB_PX = 28;

/**
 * Build the EVENTS fragment for the crosshair axis tooltip of a hovered day.
 *
 * The two wishlist charts share ONE axis tooltip whose formatter renders the
 * date + each visible listing's value; this appends "what happened that day" —
 * each event of `day` as a row: a ~28px `<img>` thumbnail (`eventThumbnail`) or,
 * when no preview, the KIND ICON on a kind-colored tile (`kindIconSvg`, white
 * icon — the same large-icon look as the no-preview marker chips at the top of
 * the chart, NOT a plain dot), followed by the HTML-escaped title.
 * Capped at TOOLTIP_EVENT_ROWS rows, the rest folded into a "+K" line. Returns
 * "" when the day has no events (the tooltip then shows only the numbers).
 *
 * One shared builder used by BOTH charts (DRY) so a day's events read identically
 * in either tooltip. The `moreLabel` callback supplies the localized "+K more"
 * string (Paraglide lives in the .svelte caller, not this plain .ts module).
 */
export const tooltipEventsHtml: TooltipEvents = (
  day: string,
  dayGroups: DayGroup[],
  moreLabel: (count: number) => string,
): string => {
  const group = dayGroups.find((g) => g.date === day);
  if (!group || group.events.length === 0) return "";

  // Sort NEWEST→OLDEST (descending occurredAt) so the tooltip's event list
  // matches the feed and the modal (everything else reads new→old). The day's
  // events arrive in buildDayGroups' input order; sort a COPY before capping.
  const ordered = [...group.events].sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );
  const rows = ordered.slice(0, TOOLTIP_EVENT_ROWS);
  const more = ordered.length - rows.length;
  const px = TOOLTIP_THUMB_PX;

  const rowHtml = rows
    .map((e) => {
      const title = escapeTooltipHtml(e.title);
      const thumb = eventThumbnail(e);
      const media = thumb
        ? `<img src="${escapeTooltipHtml(thumb)}" alt="" width="${px}" height="${px}" style="width:${px}px;height:${px}px;border-radius:4px;object-fit:cover;display:block;flex-shrink:0;" loading="lazy" />`
        : `<span style="width:${px}px;height:${px}px;border-radius:6px;background:${kindHex(e.kind)};display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;">${kindIconSvg(e.kind, { size: 18, color: "#fff" })}</span>`;
      return `<div style="display:flex;align-items:center;gap:8px;margin-top:4px;max-width:240px;"><span>${media}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${title}</span></div>`;
    })
    .join("");

  const moreHtml =
    more > 0
      ? `<div style="margin-top:4px;opacity:0.7;font-size:11px;">${escapeTooltipHtml(moreLabel(more))}</div>`
      : "";

  return `<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(128,128,128,0.25);">${rowHtml}${moreHtml}</div>`;
};

/** The display label for a listing (name → "Steam {appId}" fallback handled by caller). */
export function listingLabel(
  l: ListingLite,
  fallbackAppId: (appId: number) => string,
  fallbackGeneric: () => string,
): string {
  if (l.name && l.name.trim()) return l.name;
  if (typeof l.appId === "number") return fallbackAppId(l.appId);
  return fallbackGeneric();
}
