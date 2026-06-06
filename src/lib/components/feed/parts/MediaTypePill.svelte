<script lang="ts">
  // MediaTypePill — THE single shared corner pill (short / carousel / video)
  // marking a thumbnail's content form. ONE treatment for every source
  // (Instagram, YouTube) AND every surface (the feed card thumbnail and the
  // event-detail thumbnail) — no per-card / per-surface fork.
  //
  // Extracted verbatim from BaseFeedCard's inline pill markup + CSS so the
  // feed look is pixel-identical AND the event-detail thumbnail reuses the
  // exact same icon+TEXT pill. The TEXT is the load-bearing disambiguator: a
  // 22px icon-only glyph was unreadable over busy bright covers (a Short looked
  // like a Carousel looked like a Video). A solid dark scrim + backdrop-blur
  // keeps the white label legible on any image. pointer-events: none so it
  // never steals the host's click (open-detail / play facade).
  //
  // The pill shape ({ type, label, inner }) comes from media-type-overlay.ts
  // mediaTypeOverlay(); callers derive it via deriveMediaTypeOverlay(event) and
  // render this component ONLY when non-null and a thumbnail image is present.

  import type { OverlayPill } from "./media-type-overlay.js";

  let { pill }: { pill: OverlayPill } = $props();
</script>

<span
  class="media-type-pill"
  data-media-type={pill.type}
  aria-label={pill.label}
  title={pill.label}
>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true">{@html pill.inner}</svg
  >
  <span class="media-type-pill-label">{pill.label}</span>
</span>

<style>
  /* Media-type pill (short / carousel / video) — THE single shared treatment
   * for every source (Instagram, YouTube) and every surface (feed card +
   * event detail). Top-LEFT of the thumbnail, over the image, clear of the
   * top-right sync/overflow affordances. Icon + TEXT: the text is what
   * disambiguates a Short from a Carousel from a Video over a busy bright
   * cover — a 22px icon-only glyph was unreadable. A solid dark scrim +
   * backdrop-blur keeps the white label legible on any image. pointer-events:
   * none so it never steals the host's click. */
  .media-type-pill {
    position: absolute;
    top: 6px;
    left: 6px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: calc(100% - 12px);
    padding: 3px 8px 3px 6px;
    border-radius: var(--r-pill);
    background: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(2px);
    color: #fff;
    font-size: 11.5px;
    font-weight: var(--w-sb);
    line-height: 1;
    letter-spacing: 0.01em;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
    pointer-events: none;
    z-index: 1;
  }
  .media-type-pill svg {
    width: 13px;
    height: 13px;
    flex-shrink: 0;
    display: block;
  }
  .media-type-pill-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Cheap per-type accent tints — the text already disambiguates, this is just
   * a subtle reinforcement (short/video = warm play accent, carousel = cool). */
  .media-type-pill[data-media-type="short"],
  .media-type-pill[data-media-type="video"] {
    background: color-mix(in oklab, var(--accent) 24%, rgba(0, 0, 0, 0.72));
  }
  .media-type-pill[data-media-type="carousel"] {
    background: color-mix(in oklab, #3a6df0 24%, rgba(0, 0, 0, 0.72));
  }
</style>
