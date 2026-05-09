<script lang="ts">
  // SourceCoverageBadge — Phase 03.0.1.
  //
  // Compact derived-state chip на SourceRow + /sources/[id] header.
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

<span class="coverage-badge coverage-badge--{state}">
  {label}
</span>

<style>
  .coverage-badge {
    display: inline-block;
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-sm, 0.25rem);
    font-size: var(--font-size-label, 0.8rem);
    font-weight: 500;
    line-height: 1.4;
  }
  .coverage-badge--never_polled {
    background: var(--color-bg, #eee);
    color: var(--color-text-muted, #666);
  }
  .coverage-badge--has_more {
    background: rgba(74, 119, 187, 0.15);
    color: var(--color-accent, #4a77bb);
  }
  .coverage-badge--caught_up {
    background: rgba(74, 187, 119, 0.15);
    color: #2a803c;
  }
  .coverage-badge--quota_exhausted {
    background: rgba(217, 144, 0, 0.15);
    color: #b06d00;
  }
</style>
