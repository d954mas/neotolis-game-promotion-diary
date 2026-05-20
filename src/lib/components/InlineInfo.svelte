<script lang="ts">
  // InlineInfo — same shape as <InlineError> but uses the info color.
  // Reserved for non-error deferrals like "feature coming later" —
  // rendering this in red would miscommunicate "you did something wrong".
  let { message }: { message: string } = $props();
</script>

<div class="info" role="status">
  <span class="icon" aria-hidden="true">i</span>
  <span class="copy">{message}</span>
</div>

<style>
  /* v2 InlineInfo — --info text + --t-13 inline notice for non-error deferrals. */
  .info {
    display: flex;
    align-items: flex-start;
    gap: var(--s-1);
    padding: var(--s-1) 0;
    color: var(--info);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    line-height: var(--lh-body);
  }
  .icon {
    color: var(--info);
    font-weight: var(--w-sb);
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
