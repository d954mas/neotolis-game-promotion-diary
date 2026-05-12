<script lang="ts">
  // GameCover — game header artwork on /games/[id].
  //
  // If any attached Steam listing has a coverUrl already populated by
  // fetchSteamAppDetails (header_image), render the FIRST listing's
  // coverUrl as the cover. Otherwise show a gradient placeholder with the
  // game's title initials.
  //
  // Privacy: `referrerpolicy="no-referrer"` so we don't leak the user's
  // game-detail URL back to Steam's CDN. Same defensive default already
  // used on FeedCard's YouTube thumbnail.

  type ListingLite = {
    coverUrl: string | null;
  };

  let {
    title,
    listings,
  }: {
    title: string;
    listings: ListingLite[];
  } = $props();

  // First listing with a coverUrl wins. Iteration order = listing creation
  // order (services/game-steam-listings.ts orderBy desc(createdAt)) so the
  // most recently added listing's cover surfaces first — that matches the
  // user's mental model when they add a new appId to refresh the artwork.
  const coverSrc = $derived.by((): string | null => {
    for (const l of listings) {
      if (l.coverUrl) return l.coverUrl;
    }
    return null;
  });

  // Up to two initials from the title — first character of the first two
  // whitespace-split tokens, uppercased. Renders inside the gradient
  // placeholder when no Steam cover is available.
  const initials = $derived.by((): string => {
    return title
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => (w[0] ?? "").toUpperCase())
      .join("");
  });
</script>

{#if coverSrc}
  <img
    class="cover image"
    src={coverSrc}
    alt={`Cover for ${title}`}
    referrerpolicy="no-referrer"
    crossorigin="anonymous"
    loading="lazy"
  />
{:else}
  <div class="cover placeholder" aria-hidden="true">
    <span class="initials">{initials}</span>
  </div>
{/if}

<style>
  .cover {
    /* Steam capsule aspect ratio (460x215). Matches the source image when
     * available so the gradient placeholder doesn't visually shift the
     * page when a user later adds a Steam listing. */
    aspect-ratio: 460 / 215;
    width: 100%;
    border-radius: 4px;
    overflow: hidden;
  }
  .image {
    object-fit: cover;
    background: var(--color-bg);
    display: block;
  }
  .placeholder {
    background: linear-gradient(135deg, var(--color-accent), #6366f1);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .initials {
    color: var(--color-accent-text, #fff);
    font-size: clamp(2rem, 6vw, 3rem);
    font-weight: var(--font-weight-semibold);
    letter-spacing: 0.1em;
  }
</style>
