<script lang="ts">
  import type { PageData } from "./$types";
  import NewsShell from "$lib/components/news/NewsShell.svelte";

  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>{data.post.title} — News — Promotion diary</title>
  <meta name="description" content={data.post.summary} />
</svelte:head>

<NewsShell loggedIn={!!data.user}>
  <article class="news-article">
    <a class="back" href="/news">← News</a>
    <time datetime={data.post.date}>{data.post.dateDisplay}</time>
    <h1>{data.post.title}</h1>
    {#if data.post.cover}
      <div class="hero">
        <img
          src={data.post.cover}
          alt={data.post.coverAlt || data.post.title}
          fetchpriority="high"
        />
      </div>
    {/if}
    <!-- Safe {@html} sink: the body is author/AI-written HTML committed to the
         repo (src/content/news/*.html), never user input, and never crosses a
         tenant boundary — it is identical for every visitor. See
         src/lib/server/news.ts. -->
    <div class="prose">{@html data.post.body}</div>
  </article>
</NewsShell>

<style>
  .back {
    display: inline-block;
    color: var(--text-2);
    text-decoration: none;
    font-size: var(--t-13);
  }
  .back:hover {
    color: var(--text);
  }
  .news-article time {
    display: block;
    margin-top: var(--s-6);
    color: var(--text-3);
    font-size: var(--t-13);
    font-variant-numeric: tabular-nums;
  }
  .news-article h1 {
    margin: var(--s-2) 0 0;
    font-size: var(--t-30);
    font-weight: var(--w-sb);
    letter-spacing: -0.02em;
    line-height: 1.2;
    text-wrap: balance;
  }
  .hero {
    margin-top: var(--s-6);
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border-radius: var(--r-md);
    border: 1px solid var(--border-hairline);
  }
  .hero img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  /* Prose — styles the rendered article HTML. Uses :global because the markup
     comes from {@html}, so Svelte's scoping hashes never reach it. Scoped under
     .prose so it can't leak to the rest of the app. */
  .prose {
    margin-top: var(--s-7);
    color: var(--text);
    line-height: 1.7;
    font-size: var(--t-17);
  }
  .prose :global(h2) {
    margin: var(--s-8) 0 var(--s-3);
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    letter-spacing: -0.01em;
    line-height: 1.3;
  }
  .prose :global(p) {
    margin: 0 0 var(--s-4);
  }
  .prose :global(ul),
  .prose :global(ol) {
    margin: 0 0 var(--s-4);
    padding-left: var(--s-5);
  }
  .prose :global(li) {
    margin: var(--s-2) 0;
  }
  .prose :global(li)::marker {
    color: var(--text-3);
  }
  .prose :global(a) {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .prose :global(a:hover) {
    color: var(--accent-strong);
  }
  .prose :global(strong) {
    font-weight: var(--w-sb);
    color: var(--text);
  }
  .prose :global(code) {
    font-family: var(--f-mono);
    font-size: 0.9em;
    background: var(--surface);
    border: 1px solid var(--border-hairline);
    border-radius: var(--r-sm);
    padding: 0.1em 0.35em;
  }
  /* Blockquote as a tinted block — NOT a left-stripe callout (an explicit
     design ban). */
  .prose :global(blockquote) {
    margin: 0 0 var(--s-4);
    padding: var(--s-3) var(--s-4);
    background: var(--surface);
    border-radius: var(--r-md);
    color: var(--text-2);
  }
  .prose :global(blockquote p:last-child) {
    margin-bottom: 0;
  }
  /* Images live in static/ (e.g. /news-media/<slug>/cover.webp) and are
     referenced by absolute URL in the post HTML. Give them width/height
     attributes in the markup to reserve space (no CLS). */
  .prose :global(img) {
    display: block;
    max-width: 100%;
    height: auto;
    margin: var(--s-6) 0;
    border-radius: var(--r-md);
    border: 1px solid var(--border-hairline);
  }
  .prose :global(figure) {
    margin: var(--s-6) 0;
  }
  .prose :global(figure img) {
    margin: 0;
  }
  .prose :global(figcaption) {
    margin-top: var(--s-2);
    color: var(--text-3);
    font-size: var(--t-13);
    text-align: center;
  }
</style>
