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
// the component's rendered SVG. Geometric forms by DEFAULT; the platforms whose
// identity has no recognizable geometric primitive carry a minimal BRAND glyph
// instead (the X wordmark, the Telegram plane, the TikTok note, the Discord/Clyde
// face) — see the per-kind comments below for which is which.

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
  // X logo (formerly Twitter). Brand glyph — unlike IG (camera) / TikTok (note),
  // no geometric primitive reads as "X", so the old speech-bubble placeholder read
  // as nothing. Filled (stroke none). Mirrors SourceKindIcon.svelte twitter_account.
  twitter_post: `<path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" fill="currentColor" stroke="none" />`,
  // Telegram paper plane (send). Mirrors SourceKindIcon.svelte telegram_channel so
  // /feed (event kind) and /sources (source kind) read identically.
  telegram_post: `<path d="M21 4L3 11l5 2 2 6 3-4 5 4z" />
    <path d="M8 13l8-5" />`,
  // Discord logo (Clyde face). Brand glyph — the old two-heads shape read as
  // generic "community", not Discord. Filled (stroke none). Mirrors
  // SourceKindIcon.svelte discord_server.
  discord_drop: `<path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189z" fill="currentColor" stroke="none" />`,
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
  // camera-frame: rounded square + lens circle + top-corner dot. Geometric
  // primitives only (NO brand glyph) per the Iconography Contract.
  instagram_post: `<rect x="3" y="3" width="18" height="18" rx="5" />
    <circle cx="12" cy="12" r="4" />
    <circle cx="17" cy="7" r="1.1" fill="currentColor" stroke="none" />`,
  // TikTok logo (note glyph). Brand glyph — the geometric note read as a generic
  // music note, not TikTok. Filled (stroke none). Mirrors SourceKindIcon.svelte.
  tiktok_post: `<path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" fill="currentColor" stroke="none" />`,
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
