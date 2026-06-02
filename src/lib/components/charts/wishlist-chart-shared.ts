// Shared building blocks for the two wishlist charts on /games/[gameId]:
// WishlistCorrelationChart (cumulative lines) and WishlistGrowthChart (daily
// net-change bars). Both read the SAME loader maps, the SAME per-listing
// palette, the SAME date-range filter, and the SAME event markers — factoring
// these here keeps the two charts reading as one coherent picture and avoids
// two divergent copies of the marker/series math (KISS/DRY: three concrete
// callers — line series, growth bars, markers — earn the helper).
//
// SSR note: resolveKindColor (chart-theme.ts) is client-only (it reads
// getComputedStyle). buildMarkLineData therefore returns ECharts datum shapes
// with already-resolved colors and MUST be called from the client-only option
// builder, never under SSR.

import { resolveKindColor } from "./chart-theme.js";
import {
  isImageLikeUrl,
  readMediaUrlFromMetadata,
} from "$lib/components/feed/parts/derive-card-data.js";
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
  return d.toISOString().slice(0, 10);
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
 * Build the ECharts `markLine.data` array — one vertical line per distinct
 * event-day, colored by kind, with a count badge "N" when >1 event that day.
 * Client-only (resolveKindColor reads the DOM). Reused verbatim by both charts
 * so the markers are pixel-identical across them.
 */
export function buildMarkLineData(dayGroups: DayGroup[]): object[] {
  return dayGroups.map((g) => {
    const color = g.mixedKind ? resolveKindColor("post") : resolveKindColor(g.kind);
    const count = g.events.length;
    return {
      name: g.date,
      xAxis: g.date,
      lineStyle: { color, width: 2 },
      label:
        count > 1
          ? {
              show: true,
              position: "start" as const,
              distance: 4,
              formatter: String(count),
              color: "#fff",
              backgroundColor: color,
              padding: [2, 5],
              borderRadius: 8,
              fontSize: 10,
              fontWeight: "bold" as const,
            }
          : { show: false },
    };
  });
}

/**
 * The SINGLE source of the event→thumbnail URL logic for the charts. Mirrors
 * `deriveThumbnailUrl` (derive-card-data.ts) so a marker shows the SAME preview
 * image the FeedCard does — but takes a structurally-typed input because the
 * chart consumes EventDto-shaped rows that the games loader has run through
 * `adapter.enrichFeedDtos` (so `redditEnrichment.linkUrl` is present at runtime
 * even though the static EventDto type doesn't declare it).
 *
 *   - YouTube (`kind==="youtube_video"` + externalId) → the intrinsic
 *     `img.youtube.com/vi/{externalId}/mqdefault.jpg` (no enrichment needed —
 *     externalId IS the video id, part of the canonical URL).
 *   - Reddit → the enrichment `linkUrl` when it's image-like, else the
 *     `metadata.media.url` snapshot (same chain the RedditFeedCard renders).
 *   - everything else → null (the marker falls back to a kind-colored
 *     placeholder symbol).
 */
type ThumbnailEvent = {
  kind: string;
  externalId: string | null;
  metadata: unknown;
  redditEnrichment?: { linkUrl?: string | null } | null;
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
  if (event.kind === "twitter_post" || event.kind === "telegram_post") {
    return readMediaUrlFromMetadata(event.metadata);
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
 * - `range` set → `{ min: isoDay(from), max: isoDay(to) }` (the user's window
 *   is authoritative; markers outside it are already filtered by buildDayGroups).
 * - else, non-empty list → `{ min: earliest, max: latest+1d }` (pad the max one
 *   day so the last marker isn't flush on the right edge).
 * - else (no points, no events) → null (let ECharts auto-fit).
 *
 * Both charts call this with the SAME inputs so their axes — and therefore their
 * markers — line up.
 */
export function axisDomain(
  allPointDates: string[],
  dayGroups: { date: string }[],
  range: { from: Date; to: Date } | null,
): { min: string; max: string } | null {
  if (range) return { min: isoDay(range.from), max: isoDay(range.to) };
  const dates = [...allPointDates, ...dayGroups.map((g) => g.date)];
  if (dates.length === 0) return null;
  let min = dates[0]!;
  let max = dates[0]!;
  for (const d of dates) {
    if (d < min) min = d;
    if (d > max) max = d;
  }
  // Pad the max by one day so the rightmost marker isn't on the axis edge.
  const maxDate = new Date(`${max}T00:00:00`);
  maxDate.setDate(maxDate.getDate() + 1);
  return { min, max: isoDay(maxDate) };
}

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
