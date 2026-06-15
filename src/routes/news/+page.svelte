<script lang="ts">
  import type { PageData } from "./$types";
  import NewsShell from "$lib/components/news/NewsShell.svelte";

  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>News — Promotion diary</title>
  <meta
    name="description"
    content="Product updates and announcements for the Neotolis game promotion diary."
  />
</svelte:head>

<NewsShell loggedIn={!!data.user}>
  <header class="news-head">
    <h1>News</h1>
    <p class="lede">Product updates and what's new in the promo diary.</p>
  </header>

  {#if data.posts.length === 0}
    <p class="empty">No news yet — check back soon.</p>
  {:else}
    <ul class="news-list">
      {#each data.posts as post (post.slug)}
        <li class="news-item">
          {#if post.cover}
            <a class="item-thumb" href="/news/{post.slug}" tabindex="-1" aria-hidden="true">
              <img src={post.cover} alt="" loading="lazy" />
            </a>
          {/if}
          <div class="item-body">
            <time datetime={post.date}>{post.dateDisplay}</time>
            <h2><a href="/news/{post.slug}">{post.title}</a></h2>
            {#if post.summary}<p>{post.summary}</p>{/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</NewsShell>

<style>
  .news-head h1 {
    margin: 0;
    font-size: var(--t-30);
    font-weight: var(--w-sb);
    letter-spacing: -0.02em;
  }
  .lede {
    margin: var(--s-2) 0 0;
    color: var(--text-2);
    font-size: var(--t-17);
  }

  .news-list {
    list-style: none;
    margin: var(--s-8) 0 0;
    padding: 0;
  }
  .news-item {
    display: flex;
    gap: var(--s-4);
    padding: var(--s-6) 0;
    border-top: 1px solid var(--border-hairline);
  }
  .news-item:first-child {
    border-top: none;
    padding-top: var(--s-2);
  }
  .item-thumb {
    flex: 0 0 200px;
    aspect-ratio: 16 / 10;
    overflow: hidden;
    border-radius: var(--r-md);
    border: 1px solid var(--border-hairline);
    display: block;
  }
  .item-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition: transform var(--m-base) var(--m-ease);
  }
  .item-thumb:hover img {
    transform: scale(1.03);
  }
  .item-body {
    flex: 1;
    min-width: 0;
  }
  @media (max-width: 560px) {
    .news-item {
      flex-direction: column;
      gap: var(--s-3);
    }
    .item-thumb {
      flex: none;
      width: 100%;
      aspect-ratio: 16 / 9;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .item-thumb img {
      transition: none;
    }
    .item-thumb:hover img {
      transform: none;
    }
  }
  .news-item time {
    display: block;
    color: var(--text-3);
    font-size: var(--t-13);
    font-variant-numeric: tabular-nums;
  }
  .news-item h2 {
    margin: var(--s-2) 0 0;
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    letter-spacing: -0.01em;
    line-height: 1.25;
  }
  .news-item h2 a {
    color: var(--text);
    text-decoration: none;
  }
  .news-item h2 a:hover {
    color: var(--accent);
  }
  .news-item p {
    margin: var(--s-2) 0 0;
    color: var(--text-2);
    line-height: 1.55;
  }

  .empty {
    margin-top: var(--s-8);
    color: var(--text-3);
  }
</style>
