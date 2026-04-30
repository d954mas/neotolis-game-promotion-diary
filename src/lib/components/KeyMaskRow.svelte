<script lang="ts">
  // KeyMaskRow — renders a Steam Web API key as `••••••••${last4}` plus a
  // label, last-rotated timestamp, and Replace + Remove buttons. The mask
  // pattern is the load-bearing visual proof of D-14 / D-39: the only thing
  // the user sees post-save is the last 4 chars.

  import { m } from "$lib/paraglide/messages.js";

  type KeyDto = {
    id: string;
    label: string;
    last4: string;
    createdAt: Date | string;
    rotatedAt: Date | string | null;
  };

  let {
    keyDto,
    onReplace,
    onRemove,
  }: {
    keyDto: KeyDto;
    onReplace: () => void;
    onRemove: () => void;
  } = $props();

  const rotatedHuman = $derived(
    keyDto.rotatedAt
      ? typeof keyDto.rotatedAt === "string"
        ? new Date(keyDto.rotatedAt).toLocaleDateString()
        : keyDto.rotatedAt.toLocaleDateString()
      : null,
  );
  const createdHuman = $derived(
    typeof keyDto.createdAt === "string"
      ? new Date(keyDto.createdAt).toLocaleDateString()
      : keyDto.createdAt.toLocaleDateString(),
  );
</script>

<div class="row">
  <div class="primary">
    <span class="label">{keyDto.label}</span>
    <code class="mask">••••••••{keyDto.last4}</code>
  </div>
  <div class="meta">
    {#if rotatedHuman}
      <span>Rotated {rotatedHuman}</span>
    {:else}
      <span>Added {createdHuman}</span>
    {/if}
  </div>
  <div class="actions">
    <button type="button" class="replace" onclick={onReplace}>
      {m.keys_steam_cta_replace()}
    </button>
    <button type="button" class="remove" onclick={onRemove}>
      {m.common_remove()}
    </button>
  </div>
</div>

<style>
  .row {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    padding: var(--space-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
  }
  .primary {
    display: flex;
    align-items: center;
    gap: var(--space-md);
    flex-wrap: wrap;
    min-width: 0;
  }
  .label {
    font-weight: var(--font-weight-semibold);
    color: var(--color-text);
  }
  .mask {
    font-family: var(--font-family-mono);
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .meta {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .actions {
    display: flex;
    gap: var(--space-sm);
    flex-wrap: wrap;
  }
  .replace,
  .remove {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
    cursor: pointer;
  }
  .remove {
    color: var(--color-destructive);
    border-color: var(--color-destructive);
  }
</style>
