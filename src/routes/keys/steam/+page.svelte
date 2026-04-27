<script lang="ts">
  // /keys/steam — write-once secret store, multi-key UI (Plan 02-10, D-13).
  //
  // 0 rows → <EmptyState> + <ReplaceKeyForm mode="add"> ("Add your first key")
  // N ≥ 1 rows → <KeyMaskRow> list + <ReplaceKeyForm mode="add"> ("Add another")
  //
  // Each row exposes Replace and Remove. Replace opens an inline
  // <ReplaceKeyForm mode="replace"> for that row's id (PATCH the row).
  // Remove opens <ConfirmDialog isIrreversible> with the speed-bump pattern.
  // All ciphertext discipline (D-14 / D-39) lives behind the API surface;
  // this page never sees plaintext or ciphertext, only the masked DTO.

  import { invalidateAll } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import KeyMaskRow from "$lib/components/KeyMaskRow.svelte";
  import ReplaceKeyForm from "$lib/components/ReplaceKeyForm.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import type { PageData } from "./$types";

  type KeyDto = {
    id: string;
    label: string;
    last4: string;
    createdAt: string;
    rotatedAt: string | null;
  };

  let { data }: { data: PageData } = $props();
  const keys = $derived(data.keys as KeyDto[]);

  let replacingId = $state<string | null>(null);
  let confirmRemoveId = $state<string | null>(null);

  async function onAddSuccess(): Promise<void> {
    await invalidateAll();
  }

  async function onReplaceSuccess(): Promise<void> {
    replacingId = null;
    await invalidateAll();
  }

  async function confirmRemove(): Promise<void> {
    if (!confirmRemoveId) return;
    const id = confirmRemoveId;
    confirmRemoveId = null;
    const res = await fetch(`/api/api-keys/steam/${id}`, { method: "DELETE" });
    if (res.ok || res.status === 204) await invalidateAll();
  }
</script>

<section class="keys">
  <header class="head">
    <h1>Steam Web API keys</h1>
  </header>

  {#if keys.length === 0}
    <EmptyState
      heading={m.empty_keys_steam_heading()}
      body={m.empty_keys_steam_body({ url: "https://steamcommunity.com/dev/apikey" })}
      exampleUrl="https://steamcommunity.com/dev/apikey"
    />
    <h3>Add your first key</h3>
    <ReplaceKeyForm
      mode="add"
      onSubmit={onAddSuccess}
      onCancel={() => {
        /* nothing to cancel into for the empty case */
      }}
    />
  {:else}
    <ul class="keys-list">
      {#each keys as keyDto (keyDto.id)}
        <li class="key-item">
          <KeyMaskRow
            {keyDto}
            onReplace={() => (replacingId = keyDto.id)}
            onRemove={() => (confirmRemoveId = keyDto.id)}
          />
          {#if replacingId === keyDto.id}
            <ReplaceKeyForm
              mode="replace"
              keyId={keyDto.id}
              initialLabel={keyDto.label}
              onSubmit={onReplaceSuccess}
              onCancel={() => (replacingId = null)}
            />
          {/if}
        </li>
      {/each}
    </ul>

    <h3>{m.keys_steam_cta_add_another()}</h3>
    <ReplaceKeyForm
      mode="add"
      onSubmit={onAddSuccess}
      onCancel={() => {
        /* form stays open in this layout; cancel is a no-op */
      }}
    />
  {/if}

  <ConfirmDialog
    open={confirmRemoveId !== null}
    message={m.confirm_key_remove()}
    confirmLabel={m.common_remove()}
    isIrreversible={true}
    onConfirm={confirmRemove}
    onCancel={() => (confirmRemoveId = null)}
  />
</section>

<style>
  .keys {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    min-width: 0;
  }
  .head h1 {
    margin: 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
  }
  h3 {
    margin: var(--space-md) 0 var(--space-sm) 0;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text);
  }
  .keys-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }
  .key-item {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }
</style>
