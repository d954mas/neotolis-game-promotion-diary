<!-- Universal event card shell.
     Consumes CardProps. Per-source mappers (sources/<kind>/ui/card-props.ts)
     produce the shape; this shell renders it.

     This is a NEW component. The existing src/lib/components/FeedCard.svelte
     is INTENTIONALLY UNCHANGED — its rich redesign features
     (overlays, associated-games block, Mine treatment, image fallbacks per
     kind, inline triage controls) remain the production /feed rendering
     path. EventCard.svelte exists as a contract demonstration: it consumes
     toCardProps output, exercises the dispatch via getAdapterUI(kind), and
     is wired against unit tests.

     The escape hatch is documented but discouraged —
     when a future source plugin needs a layout this shell can't accommodate,
     it ships its own EventCard.svelte under sources/<kind>/ui/ and the
     /feed dispatch picks the per-source override. -->
<script lang="ts">
  import type { CardProps } from "$lib/sources/card-props.js";

  let { props }: { props: CardProps } = $props();
</script>

<article class="event-card">
  {#if props.thumbnail}
    <img class="thumbnail" src={props.thumbnail} alt={props.title} loading="lazy" />
  {/if}
  <h3 class="title">{props.title}</h3>
  {#if props.subtitle}
    <p class="subtitle">{props.subtitle}</p>
  {/if}
  {#if props.badge}
    <span class="badge">{props.badge}</span>
  {/if}
  {#if props.metrics.length > 0}
    <ul class="metrics">
      <!-- Index key, not metric.label.
           CardProps contract (card-props.ts) does NOT guarantee unique
           label; future Reddit / Twitter adapters may emit two metrics
           with the same label (e.g., "Views" + a per-tier "Views").
           Index key avoids Svelte 5 each_key_duplicate runtime crash. -->
      {#each props.metrics as metric, i (i)}
        <li>
          <span class="label">{metric.label}:</span>
          <span class="value">{metric.value}</span>
        </li>
      {/each}
    </ul>
  {/if}
  <a class="open" href={props.href}>Open</a>
</article>

<style>
  /* v2 list-row treatment — sibling to FeedCard for non-grid contexts. */
  .event-card {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-4);
    background: var(--surface-2);
    border-bottom: 1px solid var(--border-hairline);
    border-radius: var(--r-md);
    min-width: 0;
    transition: background var(--m-fast) var(--m-ease);
  }
  .event-card:hover {
    background: var(--surface-3);
  }
  .thumbnail {
    width: 100%;
    height: auto;
    border-radius: var(--r-sm);
  }
  .title {
    margin: 0;
    font-size: var(--t-14);
    font-weight: var(--w-sb);
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .subtitle {
    margin: 0;
    font-size: var(--t-13);
    color: var(--text-3);
  }
  .badge {
    display: inline-block;
    padding: 2px var(--s-2);
    background: var(--surface);
    border-radius: var(--r-sm);
    font-size: var(--t-12);
    color: var(--text-2);
  }
  .metrics {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    gap: var(--s-3);
    flex-wrap: wrap;
    font-family: var(--f-mono);
    font-size: var(--t-12);
    font-variant-numeric: tabular-nums;
  }
  .metrics .label {
    color: var(--text-3);
  }
  .metrics .value {
    color: var(--text);
  }
  .open {
    font-size: var(--t-13);
    color: var(--accent);
    text-decoration: none;
  }
  .open:hover {
    color: var(--accent-strong);
    text-decoration: underline;
  }
  @media (prefers-reduced-motion: reduce) {
    .event-card {
      transition: none;
    }
  }
</style>
