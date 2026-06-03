// Single source of truth for the per-kind inline SVG markup.
//
// Two consumers read from here so the icon paths are NEVER duplicated:
//   1. KindIcon.svelte — renders the <svg> wrapper and injects the per-kind
//      inner markup via {@html kindIconInner(kind)} (LB-11 class="kind" contract,
//      --text-3 default color).
//   2. wishlist-chart-shared.ts tooltipEventsHtml — the crosshair tooltip is an
//      ECharts HTML-STRING tooltip (the formatter returns a string), so it can't
//      mount the <KindIcon> Svelte component. It calls kindIconSvg(kind, {...})
//      to get the FULL <svg> as a trusted string for no-preview event rows.
//
// Icon style contract (UI-SPEC § "Iconography Contract"): 24px viewBox,
// stroke="currentColor", stroke-width 1.75, round caps/joins, fill="none".
// Some kinds use fill="var(--surface)" cut-outs (the Reddit eyes/smile) — these
// resolve in the DOM tooltip (it's plain HTML, not the ECharts canvas) and in
// the component's rendered SVG. Geometric forms only — NO brand marks.

import type { EventDto } from "$lib/server/dto.js";

/** The kinds KindIcon dispatches on — EventDto.kind plus the `post` fallback. */
type EventKind = EventDto["kind"];

/**
 * The INNER svg markup for each kind — moved verbatim from KindIcon.svelte's
 * `{#if}` branches (the `fill="var(--surface)"` cut-outs are preserved). The
 * `other` entry is the generic-dot fallback both `kindIconInner` and the
 * component fall back to.
 */
export const KIND_ICON_INNER: Record<EventKind, string> = {
  // play-button triangle inside a rounded rect (generic media, not brand)
  youtube_video: `<rect x="2" y="5" width="20" height="14" rx="3" />
    <path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none" />`,
  // Snoo-style silhouette: round head + pointy ears + antenna + eyes + smile.
  // Geometric primitives only; reads as Reddit at small sizes.
  reddit_post: `<circle cx="18.5" cy="5" r="1.4" fill="currentColor" stroke="none" />
    <path d="M14.7 11.2 17.5 6.5" />
    <circle cx="12" cy="13.5" r="6.5" fill="currentColor" stroke="none" />
    <circle cx="7" cy="9.5" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="17" cy="9.5" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="9.5" cy="13" r="1.1" fill="var(--surface)" stroke="none" />
    <circle cx="14.5" cy="13" r="1.1" fill="var(--surface)" stroke="none" />
    <circle cx="9.5" cy="13" r=".45" fill="currentColor" stroke="none" />
    <circle cx="14.5" cy="13" r=".45" fill="currentColor" stroke="none" />
    <path d="M9.5 16c1.5 1.2 3.5 1.2 5 0" stroke="var(--surface)" stroke-width="1.2" fill="none" />`,
  // people / podium
  conference: `<circle cx="12" cy="7" r="3" />
    <path d="M5 21v-2a4 4 0 014-4h6a4 4 0 014 4v2" />`,
  // microphone
  talk: `<rect x="9" y="3" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0014 0" />
    <path d="M12 18v3" />`,
  // speech bubble (no brand mark)
  twitter_post: `<path d="M21 15a2 2 0 01-2 2H8l-5 4V5a2 2 0 012-2h14a2 2 0 012 2z" />`,
  // chat
  telegram_post: `<path
      d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8z"
    />`,
  // chat with two heads
  discord_drop: `<circle cx="9" cy="11" r="2" />
    <circle cx="15" cy="11" r="2" />
    <path d="M5 19a8 8 0 0114 0" />`,
  // newspaper
  press: `<rect x="3" y="5" width="18" height="14" rx="1" />
    <line x1="7" y1="9" x2="17" y2="9" />
    <line x1="7" y1="13" x2="17" y2="13" />
    <line x1="7" y1="17" x2="13" y2="17" />`,
  // generic post: document/paper silhouette
  post: `<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <polyline points="14 3 14 9 20 9" />
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="8" y1="17" x2="13" y2="17" />`,
  // other / generic dot
  other: `<circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />`,
};

/** The inner svg markup for a kind; unknown kinds fall back to the generic dot. */
export function kindIconInner(kind: string): string {
  return KIND_ICON_INNER[kind as EventKind] ?? KIND_ICON_INNER.other;
}

/**
 * A FULL <svg> string for a kind — for HTML-string contexts that can't mount the
 * <KindIcon> Svelte component (the ECharts tooltip formatter). `color` drives
 * `currentColor` via an inline style; defaults to `currentColor` so the caller's
 * surrounding color is inherited when omitted. The markup is static/trusted.
 */
export function kindIconSvg(kind: string, opts: { size: number; color?: string }): string {
  const color = opts.color ?? "currentColor";
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="color:${color};width:${opts.size}px;height:${opts.size}px;" aria-hidden="true">${kindIconInner(kind)}</svg>`;
}
