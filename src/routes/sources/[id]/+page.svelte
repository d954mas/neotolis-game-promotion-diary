<script lang="ts">
  // /sources/[id] page — Phase 03.0.1 Plan 10. Detail page for a single
  // data_source. Phase 03.0.1 ships the minimal surface needed to host the
  // RefreshContentButton (D-NEW user payoff); future phases extend with
  // SourceDetailHeader / DetailMetricsChart / QuotaTab via the per-kind
  // adapter UI registry (see sources/youtube/ui/ — Plan 09 dual-tree).
  //
  // FUTURE: the Phase 03.1+ migration target is to import getAdapterUI(kind)
  // from $lib/sources/registry-ui.js and dispatch the page header + metrics
  // chart via the per-kind UI surface. v0.1 keeps the page minimal — the
  // button is the load-bearing affordance.

  import RefreshContentButton from "$lib/components/RefreshContentButton.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const source = $derived(data.source);
  const heading = $derived(source.displayName ?? source.handleUrl);
</script>

<svelte:head>
  <title>{heading}</title>
</svelte:head>

<section class="source-detail">
  <h1 class="source-detail__title">{heading}</h1>
  <p class="source-detail__kind">{source.kind}</p>
  <p class="source-detail__handle">
    <a href={source.handleUrl} target="_blank" rel="noopener noreferrer">{source.handleUrl}</a>
  </p>

  <div class="source-detail__actions">
    <RefreshContentButton sourceId={source.id} sourceKind={source.kind} />
  </div>
</section>

<style>
  .source-detail {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    padding: var(--space-md);
    max-width: 720px;
  }
  .source-detail__title {
    margin: 0;
    font-size: var(--font-size-h1);
  }
  .source-detail__kind {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
  }
  .source-detail__handle {
    margin: 0;
    font-size: var(--font-size-body);
  }
  .source-detail__actions {
    margin-top: var(--space-md);
  }
</style>
