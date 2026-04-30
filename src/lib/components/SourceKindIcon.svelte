<script lang="ts">
  // SourceKindIcon — inline SVG dispatch on the data_sources.kind enum.
  // Five geometric forms (camera/film for youtube_channel, speech bubble
  // for reddit_account, generic bubble for twitter_account, paper-plane
  // for telegram_channel, two-circle chat for discord_server) per
  // Phase 2.1 UI-SPEC §"Inline-SVG icon additions". Geometric, not brand
  // marks — same approach as the Phase 2 KindIcon.svelte.
  //
  // Style contract (UI-SPEC):
  //   - 24px viewBox
  //   - stroke="currentColor"
  //   - stroke-width="2"
  //   - stroke-linecap / linejoin "round"
  //   - fill="none"
  //   - color via var(--color-text-muted)
  //
  // Decorative — `aria-hidden="true"`. Adjacent text (the source-kind label
  // chip + display_name) carries the accessible name (UI-SPEC Accessibility
  // Floor delta).

  type SourceKind =
    | "youtube_channel"
    | "reddit_account"
    | "twitter_account"
    | "telegram_channel"
    | "discord_server";

  let { kind }: { kind: SourceKind } = $props();
</script>

{#if kind === "youtube_channel"}
  <svg
    class="icon"
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="6" width="18" height="12" rx="2" />
    <path d="M10 9.5l5 2.5-5 2.5z" />
  </svg>
{:else if kind === "reddit_account"}
  <svg
    class="icon"
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M4 11a3 3 0 016 0v6H7l-3 3v-9z" />
    <path d="M9 8l3-4 3 4" />
  </svg>
{:else if kind === "twitter_account"}
  <svg
    class="icon"
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path
      d="M21 5c-.6.4-1.4.7-2.2.9.8-.5 1.4-1.2 1.7-2.1-.7.4-1.6.8-2.5 1A4 4 0 0011 8.5c0 .3 0 .6.1.9A11 11 0 013 4.5a4 4 0 001.2 5.4 4 4 0 01-1.8-.5v.1a4 4 0 003.2 4 4 4 0 01-1.8.1 4 4 0 003.7 2.8A8 8 0 013 18a11 11 0 006 1.7c7.2 0 11.1-6 11.1-11.2v-.5c.8-.5 1.4-1.2 1.9-2z"
    />
  </svg>
{:else if kind === "telegram_channel"}
  <svg
    class="icon"
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M21 4L3 11l5 2 2 6 3-4 5 4z" />
    <path d="M8 13l8-5" />
  </svg>
{:else if kind === "discord_server"}
  <svg
    class="icon"
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path
      d="M5 17l-1 3 4-2a12 12 0 008 0l4 2-1-3a14 14 0 001-7c0-2-1-3-3-4a13 13 0 00-10 0c-2 1-3 2-3 4a14 14 0 001 7z"
    />
    <circle cx="9" cy="13" r="1" />
    <circle cx="15" cy="13" r="1" />
  </svg>
{/if}

<style>
  .icon {
    color: var(--color-text-muted);
    flex-shrink: 0;
  }
</style>
