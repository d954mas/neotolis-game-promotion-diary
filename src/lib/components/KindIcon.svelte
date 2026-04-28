<script lang="ts">
  // KindIcon — inline SVG dispatch on the 9 event kinds (Phase 2.1 extends
  // the Phase 2 7-kind dispatch with `youtube_video` and `reddit_post` per
  // UI-SPEC §"Inline-SVG icon additions" + §"Component inventory" KindIcon
  // MODIFY entry).
  //
  // The 9 kinds match EventDto.kind from src/lib/server/dto.ts (Plan 02.1-05
  // toEventDto extension) and the eventKindEnum schema:
  //   youtube_video, reddit_post, twitter_post, telegram_post, discord_drop,
  //   conference, talk, press, other.
  //
  // Icon style contract (UI-SPEC — UNCHANGED from Phase 2): 24px viewBox,
  // stroke="currentColor", stroke-width 2, round caps/joins, fill="none",
  // colored via --color-text-muted. Geometric forms only — NO brand marks
  // (a YouTube "play" rectangle is the closest visual; we render it as a
  // generic play-button triangle inside a rounded rect, indistinguishable
  // from a generic media icon).
  //
  // Accessibility (UI-SPEC §"Accessibility Floor delta"): aria-hidden="true"
  // (decorative); the kind name is conveyed in adjacent text via the
  // m.event_kind_label_*() Paraglide labels.

  type EventKind =
    | "youtube_video"
    | "reddit_post"
    | "twitter_post"
    | "telegram_post"
    | "discord_drop"
    | "conference"
    | "talk"
    | "press"
    | "other"
    | "post";

  let { kind, size = 20 }: { kind: EventKind; size?: number } = $props();
</script>

<svg
  class="kind"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if kind === "youtube_video"}
    <!-- play-button triangle inside a rounded rect (generic media, not brand) -->
    <rect x="2" y="5" width="20" height="14" rx="3" />
    <path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none" />
  {:else if kind === "reddit_post"}
    <!-- speech bubble + upvote arrow (generic forum form, not brand) -->
    <path d="M21 13a8 8 0 01-8 8 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7A8 8 0 1121 13z" />
    <path d="M9 13l3-3 3 3" />
  {:else if kind === "conference"}
    <!-- people / podium -->
    <circle cx="12" cy="7" r="3" />
    <path d="M5 21v-2a4 4 0 014-4h6a4 4 0 014 4v2" />
  {:else if kind === "talk"}
    <!-- microphone -->
    <rect x="9" y="3" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0014 0" />
    <path d="M12 18v3" />
  {:else if kind === "twitter_post"}
    <!-- speech bubble (no brand mark) -->
    <path d="M21 15a2 2 0 01-2 2H8l-5 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
  {:else if kind === "telegram_post"}
    <!-- chat -->
    <path
      d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8z"
    />
  {:else if kind === "discord_drop"}
    <!-- chat with two heads -->
    <circle cx="9" cy="11" r="2" />
    <circle cx="15" cy="11" r="2" />
    <path d="M5 19a8 8 0 0114 0" />
  {:else if kind === "press"}
    <!-- newspaper -->
    <rect x="3" y="5" width="18" height="14" rx="1" />
    <line x1="7" y1="9" x2="17" y2="9" />
    <line x1="7" y1="13" x2="17" y2="13" />
    <line x1="7" y1="17" x2="13" y2="17" />
  {:else if kind === "post"}
    <!-- generic post: document/paper silhouette -->
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <polyline points="14 3 14 9 20 9" />
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="8" y1="17" x2="13" y2="17" />
  {:else}
    <!-- other / generic dot -->
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
  {/if}
</svg>

<style>
  .kind {
    color: var(--color-text-muted);
    flex-shrink: 0;
  }
</style>
