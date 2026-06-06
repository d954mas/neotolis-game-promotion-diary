// Media-type corner-overlay glyphs — shared cross-source card helper.
//
// A feed card's thumbnail is its primary visual, but at a glance a photo, a
// short-form clip, a carousel and a plain video look identical. This module
// supplies a small corner glyph per content form so the user can tell them
// apart. A bare photo gets NO overlay (a photo needs no marker).
//
// Lives in feed/parts/ (next to derive-card-data.ts) because it is a
// cross-source concern: Instagram marks reel/carousel/video, YouTube marks
// video. Per AGENTS.md "modules don't leak", a shared UI helper used by more
// than one source adapter belongs in the shared card layer, not inside any
// one adapter's ui/ directory.
//
// Icon style mirrors $lib/components/kind-icon-svg.ts (the Iconography
// Contract): 24px viewBox, fill="none", stroke="currentColor", round
// caps/joins. Geometric forms only — NO brand marks. The card paints these
// white over a subtle scrim so they stay legible on bright images.

/** The media_type values that earn a corner overlay (photo → none). */
export type OverlayMediaType = "reel" | "carousel" | "video";

interface OverlayGlyph {
  /** a11y label — read verbatim into the overlay's aria-label / test id. */
  label: string;
  /** Inner <svg> markup (paths only); the component wraps it in the <svg>. */
  inner: string;
}

const GLYPHS: Record<OverlayMediaType, OverlayGlyph> = {
  // Reel — a clapperboard-style play marker: rounded film frame + play
  // triangle. Reads as "short-form video" without the IG brand mark.
  reel: {
    label: "Reel",
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
  // Video — a plain play triangle (long-form feed video, not a reel).
  video: {
    label: "Video",
    inner: `<path d="M8 5v14l11-7z" fill="currentColor" stroke="none" />`,
  },
};

/**
 * The overlay glyph for a media_type, or null when no overlay applies
 * (photo / image, an unknown value, or null). Pure — the card maps its
 * per-source media-type field through this and renders the glyph only
 * when non-null.
 */
export function mediaTypeOverlay(mediaType: string | null | undefined): OverlayGlyph | null {
  if (mediaType === "reel" || mediaType === "carousel" || mediaType === "video") {
    return GLYPHS[mediaType];
  }
  return null;
}
