<script lang="ts">
  // Shared chrome for the public /news pages (list + article). The app's
  // AppHeader + Nav only render for signed-in users (see +layout.svelte), so an
  // anonymous visitor arriving on /news has no way back to the landing — this
  // shell adds a slim brand bar for them. Signed-in users already have the app
  // chrome above, so the bar is suppressed. The reading column + footer are
  // shared by both. Follows the app theme (NOT theme-locked like the marketing
  // landing) — /news is a reading surface a signed-in user opens in their own
  // light/dark preference.
  import type { Snippet } from "svelte";

  let { loggedIn, children }: { loggedIn: boolean; children: Snippet } = $props();

  const GITHUB = "https://github.com/d954mas/neotolis-game-promotion-diary";
</script>

{#if !loggedIn}
  <div class="anon-bar">
    <a class="brand" href="/" aria-label="Promotion diary — home">
      <span class="brand-mark" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 9 9">
          <rect x="0" y="0" width="3" height="3" fill="currentColor" opacity="0.85" />
          <rect x="3" y="0" width="3" height="3" fill="currentColor" opacity="0.55" />
          <rect x="0" y="3" width="3" height="3" fill="currentColor" opacity="0.65" />
          <rect x="6" y="3" width="3" height="3" fill="currentColor" opacity="0.95" />
          <rect x="3" y="6" width="3" height="3" fill="currentColor" opacity="0.40" />
        </svg>
      </span>
      <span class="wordmark">Promotion diary</span>
    </a>
    <a class="cta" href="/about">Sign in</a>
  </div>
{/if}

<div class="news-shell">
  {@render children()}

  <footer class="news-foot">
    <a href="/">Home</a>
    <a href="/about">About</a>
    <a href={GITHUB} target="_blank" rel="noopener">GitHub</a>
  </footer>
</div>

<style>
  .anon-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
    max-width: var(--max-w, 1280px);
    margin: 0 auto;
    padding: var(--s-3) var(--s-4);
    border-bottom: 1px solid var(--border-hairline);
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--text);
    text-decoration: none;
  }
  .brand-mark {
    width: 20px;
    height: 20px;
    color: var(--accent);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .wordmark {
    font-size: var(--t-15);
    font-weight: var(--w-sb);
    letter-spacing: -0.01em;
  }
  .cta {
    font-size: var(--t-13);
    color: var(--text-2);
    text-decoration: none;
  }
  .cta:hover {
    color: var(--text);
  }

  /* Reading column. Capped narrow for comfortable line length on prose. */
  .news-shell {
    width: 100%;
    max-width: 680px;
    margin: 0 auto;
    padding: var(--s-7) var(--s-4) var(--s-8);
  }
  @media (min-width: 768px) {
    .news-shell {
      padding: var(--s-8) var(--s-4) var(--s-8);
    }
  }

  .news-foot {
    display: flex;
    gap: var(--s-5);
    margin-top: var(--s-8);
    padding-top: var(--s-5);
    border-top: 1px solid var(--border-hairline);
    font-size: var(--t-13);
  }
  .news-foot a {
    color: var(--text-3);
    text-decoration: none;
  }
  .news-foot a:hover {
    color: var(--text);
  }
</style>
