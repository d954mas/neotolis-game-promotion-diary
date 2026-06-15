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
          <time datetime={post.date}>{post.dateDisplay}</time>
          <h2><a href="/news/{post.slug}">{post.title}</a></h2>
          {#if post.summary}<p>{post.summary}</p>{/if}
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
    padding: var(--s-6) 0;
    border-top: 1px solid var(--border-hairline);
  }
  .news-item:first-child {
    border-top: none;
    padding-top: var(--s-2);
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
