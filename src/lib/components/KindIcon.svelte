<script lang="ts">
  // KindIcon — inline SVG dispatch on the event kinds.
  //
  // The kinds match EventDto.kind from src/lib/server/dto.ts and the
  // eventKindEnum schema:
  //   youtube_video, reddit_post, twitter_post, telegram_post, discord_drop,
  //   conference, talk, press, other, post.
  //
  // Icon style contract (UI-SPEC § "Iconography Contract"): 24px viewBox,
  // stroke="currentColor", stroke-width 1.75, round caps/joins, fill="none",
  // colored via --text-3 by default. Geometric forms only — NO brand marks
  // (the Reddit Snoo silhouette is geometric primitives, not a brand logo).
  //
  // Accessibility: aria-hidden="true" (decorative); the kind name is
  // conveyed in adjacent text via the m.event_kind_label_*() Paraglide
  // labels.
  //
  // LB-11 contract: class="kind" on <svg> is consumed by FeedCard's
  // `.overlay-kind :global(svg.kind)` selector to bridge color from the
  // dark pill overlay into the icon (currentColor → white). Do not rename.
  //
  // The per-kind SVG paths live in ONE shared source (kind-icon-svg.ts) so the
  // ECharts HTML-string tooltip (which can't mount this component) renders the
  // SAME icons via kindIconSvg(). This component injects that shared inner
  // markup with {@html kindIconInner(kind)} — no path duplication.

  import { kindIconInner } from "./kind-icon-svg.js";
  import type { EventDto } from "$lib/server/dto.js";

  type EventKind = EventDto["kind"];

  let { kind, size = 20 }: { kind: EventKind; size?: number } = $props();
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -- kindIconInner returns
     static, trusted icon markup (no user input); the single shared SVG source -->
<svg
  class="kind"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true">{@html kindIconInner(kind)}</svg>

<style>
  .kind {
    color: var(--text-3);
    flex-shrink: 0;
  }
</style>
