<script lang="ts">
  // InlineInfo — same shape as <InlineError> but uses the info color
  // (UI-SPEC §"Color"). Reserved by UI-SPEC for non-error deferrals like
  // "Reddit support arrives in Phase 3" — rendering this in red would
  // miscommunicate "you did something wrong".
  let { message }: { message: string } = $props();
</script>

<div class="info" role="status">
  <span class="icon" aria-hidden="true">i</span>
  <span class="copy">{message}</span>
</div>

<style>
  .info {
    display: flex;
    align-items: flex-start;
    gap: var(--space-sm);
    padding: var(--space-sm) var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border-left: 3px solid var(--color-info);
    font-size: var(--font-size-body);
    line-height: var(--line-height-body);
  }
  .icon {
    color: var(--color-info);
    font-weight: var(--font-weight-semibold);
    font-style: italic;
    line-height: 1;
    flex-shrink: 0;
    width: 1.25em;
    text-align: center;
  }
  .copy {
    min-width: 0;
  }
</style>
