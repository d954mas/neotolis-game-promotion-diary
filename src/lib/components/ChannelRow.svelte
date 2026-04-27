<script lang="ts">
  // ChannelRow — one row in the YouTube-channels list (/accounts/youtube
  // and the per-game attached panel). Handle URL + own/blogger toggle +
  // remove (or detach for per-game).
  //
  // The toggle distinguishes "this is my channel" (own) from "I'm tracking
  // a blogger's channel". UI-SPEC §"Reusable component inventory" lists
  // both onToggleOwn and onRemove as the contract.

  import { m } from "$lib/paraglide/messages.js";

  type Channel = {
    id: string;
    handleUrl: string;
    displayName: string | null;
    isOwn: boolean;
  };

  let {
    channel,
    onToggleOwn,
    onRemove,
  }: {
    channel: Channel;
    onToggleOwn?: (next: boolean) => void;
    onRemove?: () => void;
  } = $props();
</script>

<div class="row">
  <div class="primary">
    <span class="handle">{channel.handleUrl}</span>
    {#if channel.displayName}
      <span class="display">— {channel.displayName}</span>
    {/if}
  </div>
  <div class="actions">
    {#if onToggleOwn}
      <label class="toggle">
        <input
          type="checkbox"
          checked={channel.isOwn}
          onchange={(e) => onToggleOwn?.((e.currentTarget as HTMLInputElement).checked)}
        />
        <span>Own channel</span>
      </label>
    {/if}
    {#if onRemove}
      <button type="button" class="remove" onclick={onRemove}>{m.common_remove()}</button>
    {/if}
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
    align-items: baseline;
    gap: var(--space-sm);
    flex-wrap: wrap;
    min-width: 0;
  }
  .handle {
    font-family: var(--font-family-mono);
    color: var(--color-text);
    word-break: break-all;
  }
  .display {
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
  }
  .actions {
    display: flex;
    gap: var(--space-md);
    align-items: center;
    flex-wrap: wrap;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    cursor: pointer;
  }
  .remove {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: transparent;
    color: var(--color-destructive);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
  }
  @media (min-width: 768px) {
    .row {
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
    }
  }
</style>
