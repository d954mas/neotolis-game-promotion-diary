<!-- src/lib/components/EventCard.svelte — Phase 03.0.1 D-03 universal shell.
     Consumes CardProps. Per-source mappers (sources/<kind>/ui/card-props.ts)
     produce the shape; this shell renders it. Per-source overrides via
     the D-04 escape hatch are not yet wired in 03.0.1.

     This is a NEW component. The existing src/lib/components/FeedCard.svelte
     is INTENTIONALLY UNCHANGED — its rich Phase 02.1-23 redesign features
     (overlays, associated-games block, Mine treatment, image fallbacks per
     kind, inline triage controls) remain the production /feed rendering
     path. EventCard.svelte exists as a contract demonstration: it consumes
     toCardProps output, exercises the dispatch via getAdapterUI(kind), and
     is wired against unit tests. /feed migration to use registry-ui is
     deferred to Phase 03.1 (when Reddit lands and there are multiple kinds
     to render).

     Per CONTEXT.md D-04 the escape hatch is documented but discouraged —
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
      <!-- Phase 03.0.1 (post-review P1-5) — index key, not metric.label.
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
  .event-card {
    display: grid;
    gap: 0.5rem;
    padding: 1rem;
    border: 1px solid var(--color-border, #ccc);
    border-radius: 0.5rem;
    background: var(--color-surface, #fff);
  }
  .thumbnail {
    width: 100%;
    height: auto;
    border-radius: 0.25rem;
  }
  .title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  .subtitle {
    margin: 0;
    color: var(--color-text-muted, #666);
  }
  .badge {
    display: inline-block;
    padding: 0.125rem 0.5rem;
    background: var(--color-bg, #eee);
    border-radius: 0.25rem;
    font-size: 0.75rem;
  }
  .metrics {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .metrics .label {
    color: var(--color-text-muted, #666);
  }
  .open {
    font-size: 0.875rem;
  }
</style>
