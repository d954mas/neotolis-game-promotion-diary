<script lang="ts">
  // KeyMaskRow — renders a Steam Web API key as `••••••••${last4}` plus a
  // label, last-rotated timestamp, and Replace + Remove buttons. The mask
  // pattern is the load-bearing visual proof of the write-once contract:
  // the only thing the user sees post-save is the last 4 chars.

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
  /* v2 KeyMaskRow — --surface-2 row + --f-mono masked secret display. */
  .row {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-4);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
  }
  .primary {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    flex-wrap: wrap;
    min-width: 0;
  }
  .label {
    font-family: var(--f-sans);
    font-size: var(--t-14);
    font-weight: var(--w-sb);
    color: var(--text);
  }
  .mask {
    font-family: var(--f-mono);
    font-size: var(--t-13);
    color: var(--text-2);
    letter-spacing: 0.06em;
  }
  .meta {
    font-family: var(--f-sans);
    font-size: var(--t-12);
    color: var(--text-3);
  }
  .actions {
    display: flex;
    gap: var(--s-1);
    flex-wrap: wrap;
    margin-left: auto;
  }
  .replace,
  .remove {
    min-height: var(--hit);
    padding: var(--s-1) var(--s-3);
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .replace:hover {
    background: var(--accent-soft);
    border-color: var(--accent-strong);
  }
  .remove {
    color: var(--danger);
    border-color: var(--danger);
  }
  .remove:hover {
    background: var(--danger);
    color: #fff;
  }
  @media (prefers-reduced-motion: reduce) {
    .replace,
    .remove {
      transition: none;
    }
  }
</style>
