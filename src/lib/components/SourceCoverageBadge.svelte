<script lang="ts">
  // SourceCoverageBadge — compact derived-state chip on SourceRow +
  // /sources/[id] header.
  // Reads (lastPolledAt, backfillComplete, quotaExhausted) and renders one
  // of four states. No backend round-trip — just label classification.

  import { m } from "$lib/paraglide/messages.js";

  let {
    lastPolledAt,
    backfillComplete,
    quotaExhausted,
  }: {
    lastPolledAt: Date | string | null;
    backfillComplete: boolean;
    quotaExhausted: boolean;
  } = $props();

  type State = "never_polled" | "caught_up" | "quota_exhausted" | "has_more";

  const state = $derived<State>(
    lastPolledAt === null
      ? "never_polled"
      : backfillComplete
        ? "caught_up"
        : quotaExhausted
          ? "quota_exhausted"
          : "has_more",
  );

  const label = $derived(
    state === "never_polled"
      ? m.source_coverage_never_polled()
      : state === "caught_up"
        ? m.source_coverage_caught_up()
        : state === "quota_exhausted"
          ? m.source_coverage_quota_exhausted()
          : m.source_coverage_has_more(),
  );
</script>

<!-- «has_more» state is hidden. The Refresh button itself is the
     affordance for «more can be pulled» — surfacing the same idea as a
     chip is redundant. Other states (never_polled, caught_up,
     quota_exhausted) carry distinct, non-obvious info and stay visible. -->
{#if state !== "has_more"}
  <span class="coverage-badge coverage-badge--{state}">
    {label}
  </span>
{/if}

<style>
  /* v2 SourceCoverageBadge — D-01 redraw via PollingBadge analogy.
   * --r-pill + per-state color drawn from v2 semantic palette. */
  .coverage-badge {
    display: inline-block;
    padding: var(--s-0) var(--s-2);
    border-radius: var(--r-pill);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    font-weight: var(--w-md);
    line-height: 1.4;
  }
  .coverage-badge--never_polled {
    background: var(--surface-2);
    color: var(--text-3);
  }
  .coverage-badge--has_more {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .coverage-badge--caught_up {
    background: var(--surface-2);
    color: var(--success);
  }
  .coverage-badge--quota_exhausted {
    background: var(--surface-2);
    color: var(--warn);
  }
</style>
