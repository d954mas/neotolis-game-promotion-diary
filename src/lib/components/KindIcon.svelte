<script lang="ts">
  // KindIcon — inline SVG dispatch on the 7 event kinds (UI-SPEC FLAG:
  // "no icon library means every icon ships as inline SVG"; per-component
  // file at executor's discretion is used here for tree-shake friendliness).
  //
  // The 7 kinds match EventDto.kind from src/lib/server/dto.ts:
  //   conference, talk, twitter_post, telegram_post, discord_drop, press, other
  //
  // Icons are simple geometric forms (no brand marks — Twitter "x" / Telegram
  // paper-plane would tie us to brand assets); the kind label below the icon
  // is what users actually read. Icons live to give the row a visual anchor.

  type EventKind =
    | "conference"
    | "talk"
    | "twitter_post"
    | "telegram_post"
    | "discord_drop"
    | "press"
    | "other";

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
  {#if kind === "conference"}
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
