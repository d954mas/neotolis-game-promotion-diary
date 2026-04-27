<script lang="ts">
  // /accounts/youtube — own + blogger channel list (Plan 02-10).
  //
  // Empty state with @-handle URL example. Add-channel form posts to
  // /api/youtube-channels with isOwn defaulting to ON for the first row,
  // OFF after (heuristic per UI-SPEC §"/accounts/youtube"). Toggle and
  // (channel-level remove is not yet shipped — see Plan 02-08 deviation;
  // remove flow detaches per-game on the game-detail page).

  import { invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import ChannelRow from "$lib/components/ChannelRow.svelte";
  import InlineError from "$lib/components/InlineError.svelte";
  import type { PageData } from "./$types";

  type ChannelDto = {
    id: string;
    handleUrl: string;
    displayName: string | null;
    isOwn: boolean;
  };

  let { data }: { data: PageData } = $props();
  const channels = $derived(data.channels as ChannelDto[]);

  let showForm = $state(false);
  let newHandle = $state("");
  let newIsOwn = $state(true);
  let creating = $state(false);
  let createError = $state<string | null>(null);

  // Heuristic: default isOwn=true for the first row, false after.
  $effect(() => {
    if (channels.length > 0) newIsOwn = false;
  });

  async function submitNew(e: Event): Promise<void> {
    e.preventDefault();
    if (creating || newHandle.trim().length === 0) return;
    creating = true;
    createError = null;
    try {
      const res = await fetch("/api/youtube-channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          handleUrl: newHandle.trim(),
          isOwn: newIsOwn,
        }),
      });
      if (!res.ok) {
        createError = m.error_server_generic();
        return;
      }
      newHandle = "";
      showForm = false;
      await invalidateAll();
    } catch {
      createError = m.error_network();
    } finally {
      creating = false;
    }
  }

  async function toggleIsOwn(channelId: string, next: boolean): Promise<void> {
    const res = await fetch(`/api/youtube-channels/${channelId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isOwn: next }),
    });
    if (res.ok) await invalidateAll();
  }
</script>

<section class="channels">
  <header class="head">
    <h1>YouTube channels</h1>
    <button type="button" class="cta" onclick={() => (showForm = !showForm)}>
      {m.youtube_channels_cta_add()}
    </button>
  </header>

  {#if showForm}
    <form class="newchannel" onsubmit={submitNew}>
      <label class="field">
        <span class="label">Channel handle URL *</span>
        <input
          class="input"
          type="url"
          bind:value={newHandle}
          required
          placeholder="https://www.youtube.com/@handle"
        />
      </label>
      <label class="toggle">
        <input type="checkbox" bind:checked={newIsOwn} />
        <span>This is my channel (own)</span>
      </label>
      <div class="actions">
        <button type="button" class="cancel" onclick={() => (showForm = false)}>
          {m.common_cancel()}
        </button>
        <button type="submit" class="submit" disabled={creating || newHandle.trim().length === 0}>
          {m.youtube_channels_cta_add()}
        </button>
      </div>
      {#if createError}<InlineError message={createError} />{/if}
    </form>
  {/if}

  {#if channels.length === 0}
    <EmptyState
      heading={m.empty_youtube_channels_heading()}
      body={m.empty_youtube_channels_body({ url: "@RickAstleyYT" })}
      exampleUrl="@RickAstleyYT"
      ctaLabel={m.youtube_channels_cta_add()}
      onCta={() => (showForm = true)}
    />
  {:else}
    <ul class="rows">
      {#each channels as ch (ch.id)}
        <li>
          <ChannelRow channel={ch} onToggleOwn={(next) => toggleIsOwn(ch.id, next)} />
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .channels {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
    flex-wrap: wrap;
  }
  .head h1 {
    margin: 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
  }
  .cta {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-accent);
    color: var(--color-accent-text);
    border: none;
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .newchannel {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    padding: var(--space-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }
  .label {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .input {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
  }
  .actions {
    display: flex;
    gap: var(--space-sm);
    justify-content: flex-end;
  }
  .cancel {
    background: transparent;
    color: var(--color-text-muted);
    border: none;
    text-decoration: underline;
    cursor: pointer;
  }
  .submit {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-accent);
    color: var(--color-accent-text);
    border: none;
    border-radius: 4px;
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .rows {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }
</style>
