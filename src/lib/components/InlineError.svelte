<script lang="ts">
  // InlineError — destructive-color inline error banner (UI-SPEC §"Reusable
  // component inventory"). Used below paste-box and inside every form when
  // the server returns a 4xx. Distinct from <InlineInfo> so users can tell
  // "you did something wrong" from "we deferred something".
  let { message }: { message: string } = $props();
</script>

<div class="error" role="alert">
  <span class="icon" aria-hidden="true">!</span>
  <span class="copy">{message}</span>
</div>

<style>
  .error {
    display: flex;
    align-items: flex-start;
    gap: var(--space-sm);
    padding: var(--space-sm) var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border-left: 3px solid var(--color-destructive);
    font-size: var(--font-size-body);
    line-height: var(--line-height-body);
  }
  .icon {
    color: var(--color-destructive);
    font-weight: var(--font-weight-semibold);
    line-height: 1;
    flex-shrink: 0;
    width: 1.25em;
    text-align: center;
  }
  .copy {
    min-width: 0;
  }
</style>
