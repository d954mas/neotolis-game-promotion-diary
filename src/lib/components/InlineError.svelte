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
  /* v2 InlineError — --danger text + --t-13 inline alert. */
  .error {
    display: flex;
    align-items: flex-start;
    gap: var(--s-1);
    padding: var(--s-1) 0;
    color: var(--danger);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    line-height: var(--lh-body);
  }
  .icon {
    color: var(--danger);
    font-weight: var(--w-sb);
    line-height: 1;
    flex-shrink: 0;
    width: 1.25em;
    text-align: center;
  }
  .copy {
    min-width: 0;
  }
</style>
