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

/** Truncate an event's occurredAt to its YYYY-MM-DD day (markers are day-level). */
export function eventDay(e: EventDto): string {
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
