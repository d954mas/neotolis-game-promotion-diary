// Media-type corner-overlay pills — shared cross-source card helper.
//
// A feed card's thumbnail is its primary visual, but at a glance a photo, a
// short-form clip, a carousel and a plain video look identical. This module
// supplies a small corner PILL per content form — icon + TEXT label — so the
// user can tell them apart even over a busy, bright cover image. The TEXT is
// the load-bearing disambiguator: a 22px icon-only glyph was unreadable over
// detailed photos (a Short looked like a Carousel looked like a Video). A bare
// photo gets NO pill (a photo needs no marker).
//
// Lives in feed/parts/ (next to derive-card-data.ts) because it is a
// cross-source concern: Instagram marks short/carousel/video, YouTube marks
// video. Per AGENTS.md "modules don't leak", a shared UI helper used by more
// than one source adapter belongs in the shared card layer, not inside any
// one adapter's ui/ directory.
//
// Icon style mirrors $lib/components/kind-icon-svg.ts (the Iconography
// Contract): 24px viewBox, fill="none", stroke="currentColor", round
// caps/joins. Geometric forms only — NO brand marks. BaseFeedCard renders the
// glyph + label in ONE pill treatment (white on a dark scrim) used by every
// source — no per-card fork.

/** The media_type values that earn a corner pill (photo → none). */
export type OverlayMediaType = "short" | "carousel" | "video";

export interface OverlayPill {
  /** The media kind, mirrored onto a data-attribute for per-type accent tints. */
  type: OverlayMediaType;
  /** Visible text + a11y label — rendered in the pill AND its aria-label. */
  label: string;
  /** Inner <svg> markup (paths only); the component wraps it in the <svg>. */
  inner: string;
}

const GLYPHS: Record<OverlayMediaType, Omit<OverlayPill, "type">> = {
  // Short — a clapperboard-style play marker: rounded film frame + play
  // triangle. Reads as "short-form video" without any platform brand mark
  // ("Short" is the unified IG-Reels / YT-Shorts / TikTok term).
  short: {
    label: "Short",
    inner: `<rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="M3 8h18" />
      <path d="M8.5 3.5 11 8" />
      <path d="M13.5 3.5 16 8" />
      <path d="M10.5 12v4l3.5-2z" fill="currentColor" stroke="none" />`,
  },
  // Carousel — stacked / overlapping squares (the multi-photo album marker).
  carousel: {
    label: "Carousel",
    inner: `<rect x="8" y="3" width="13" height="13" rx="2.5" />
      <path d="M16 19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2" />`,
  },
  // Video — a plain play triangle (long-form feed video, not a short).
  video: {
    label: "Video",
    inner: `<path d="M8 5v14l11-7z" fill="currentColor" stroke="none" />`,
  },
};

/**
 * The overlay pill ({ type, label, inner }) for a media_type, or null when no
 * pill applies (photo / image, an unknown value, or null). Pure — the card
 * maps its per-source media-type field through this and passes the pill to
 * BaseFeedCard, which renders the icon+text markup only when non-null.
 */
export function mediaTypeOverlay(mediaType: string | null | undefined): OverlayPill | null {
  if (mediaType === "short" || mediaType === "carousel" || mediaType === "video") {
    return { type: mediaType, ...GLYPHS[mediaType] };
  }
  return null;
}

/** The minimal event shape deriveMediaTypeOverlay reads: the discriminating
 *  `kind` plus the IG enrichment's media_type (attached by
 *  sources/instagram/server/feed-enrichment.ts — present on both the feed-card
 *  CardEventLite and the cast event-detail DTO). Kept structural so feed cards
 *  AND the event-detail surface can pass their own event type unchanged. */
export interface MediaTypeOverlayEvent {
  kind: string;
  instagramEnrichment?: { mediaType?: string | null } | null;
  telegramEnrichment?: { mediaKind?: string | null } | null;
  tiktokEnrichment?: { mediaType?: string | null } | null;
}

/**
 * THE single kind→pill derivation, shared by the feed cards and the event
 * detail so the per-kind decision lives in one place (DRY):
 *   - youtube_video  → always the "Video" pill (a feed thumbnail can't tell a
 *     Short from a full video yet; Shorts detection is deferred).
 *   - instagram_post → the post's media_type (short / video / carousel → pill;
 *     image / missing → null).
 *   - telegram_post  → the post's media_kind, translated to the shared pill
 *     vocabulary (video → "Video", album → "Carousel"; photo / text-only →
 *     null). The telegram_posts table speaks photo/video/album (D-06); the pill
 *     vocabulary speaks short/carousel/video, so the translation lives here in
 *     the single kind→pill home, not in the card.
 *   - tiktok_post    → the post's media_type (CONTEXT D-03 / RESEARCH Q2 use the
 *     {video, carousel} vocabulary, NOT "short"): video → "Video", carousel
 *     (photo-mode slideshow) → "Carousel"; anything else / missing → null.
 *   - any other kind → null (no pill).
 * Pure; the caller renders <MediaTypePill> only when this is non-null (and a
 * thumbnail image is actually shown).
 */
export function deriveMediaTypeOverlay(event: MediaTypeOverlayEvent): OverlayPill | null {
  if (event.kind === "youtube_video") return mediaTypeOverlay("video");
  if (event.kind === "instagram_post") {
    return mediaTypeOverlay(event.instagramEnrichment?.mediaType ?? "");
  }
  if (event.kind === "telegram_post") {
    const mediaKind = event.telegramEnrichment?.mediaKind ?? "";
    if (mediaKind === "album") return mediaTypeOverlay("carousel");
    if (mediaKind === "video") return mediaTypeOverlay("video");
    return null; // photo / text-only → no pill (a photo needs no marker)
  }
  if (event.kind === "tiktok_post") {
    const mediaType = event.tiktokEnrichment?.mediaType ?? "";
    // The tiktok_posts table speaks {video, carousel} (D-03); the pill vocabulary
    // already carries both terms, so no translation is needed (carousel → the
    // shared "Carousel" pill, video → "Video").
    if (mediaType === "carousel") return mediaTypeOverlay("carousel");
    if (mediaType === "video") return mediaTypeOverlay("video");
    return null;
  }
  return null;
}
