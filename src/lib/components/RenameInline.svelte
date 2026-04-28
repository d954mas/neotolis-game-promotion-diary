<script lang="ts">
  // RenameInline — click-to-edit pattern for the game title on /games/[id].
  // Closes part of the Phase 2 P0 gap (the other half is AddSteamListingForm).
  //
  // Read mode: a button with the title rendered as <h1>. Click → edit mode.
  // Edit mode: text input + Save name / Discard changes buttons (visible
  // text labels per UI-SPEC Accessibility Floor delta — no aria-label needed
  // when the visible label is the accessible name).
  //
  // Esc on the input fires Discard (matches the visible button); Enter fires
  // Save. Save invokes the parent-supplied onSave callback; on success the
  // component returns to read mode. On error the parent surfaces InlineError.
  //
  // Destructive-cancel context: typed-but-unsaved input is thrown away on
  // Discard. UI-SPEC reserves m.common_cancel() for non-destructive close;
  // this component uses the scoped m.game_rename_cta_discard() copy
  // ("Discard changes") so the affordance is honest.

  import { tick } from "svelte";
  import { m } from "$lib/paraglide/messages.js";
  import InlineError from "./InlineError.svelte";

  let {
    initial,
    onSave,
  }: {
    initial: string;
    onSave: (title: string) => Promise<void>;
  } = $props();

  let editing = $state(false);
  let value = $state(initial);
  let pending = $state(false);
  let errorText = $state<string | null>(null);
  let inputEl: HTMLInputElement | null = $state(null);

  async function startEdit(): Promise<void> {
    value = initial;
    errorText = null;
    editing = true;
    await tick();
    inputEl?.focus();
    inputEl?.select();
  }

  function discard(): void {
    if (pending) return;
    value = initial;
    errorText = null;
    editing = false;
  }

  async function save(): Promise<void> {
    if (pending) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      errorText = m.error_server_generic();
      return;
    }
    pending = true;
    errorText = null;
    try {
      await onSave(trimmed);
      editing = false;
    } catch (err) {
      const message =
        err instanceof Error && err.message ? err.message : m.error_server_generic();
      errorText = message;
    } finally {
      pending = false;
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      discard();
    } else if (e.key === "Enter") {
      e.preventDefault();
      void save();
    }
  }
</script>

{#if editing}
  <div class="edit">
    <input
      bind:this={inputEl}
      bind:value
      class="input"
      type="text"
      maxlength="200"
      onkeydown={onKeydown}
      disabled={pending}
    />
    <div class="actions">
      <button type="button" class="save" onclick={save} disabled={pending}>
        {m.game_rename_cta_save()}
      </button>
      <button type="button" class="discard" onclick={discard} disabled={pending}>
        {m.game_rename_cta_discard()}
      </button>
    </div>
    {#if errorText}<InlineError message={errorText} />{/if}
  </div>
{:else}
  <button type="button" class="read" onclick={startEdit}>
    <h1 class="title">{initial}</h1>
  </button>
{/if}

<style>
  .read {
    background: transparent;
    border: 1px solid transparent;
    padding: var(--space-xs) var(--space-sm);
    border-radius: 4px;
    cursor: text;
    text-align: left;
  }
  .read:hover,
  .read:focus-visible {
    background: var(--color-surface);
    border-color: var(--color-border);
  }
  .title {
    margin: 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
    line-height: var(--line-height-heading);
    color: var(--color-text);
  }
  .edit {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    min-width: 0;
  }
  .input {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
    width: 100%;
    box-sizing: border-box;
  }
  .actions {
    display: flex;
    gap: var(--space-sm);
    flex-wrap: wrap;
  }
  .save,
  .discard {
    min-height: 44px;
    padding: 0 var(--space-md);
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .save {
    background: var(--color-accent);
    color: var(--color-accent-text);
    border: 1px solid var(--color-accent);
  }
  .save:disabled,
  .discard:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .discard {
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }
</style>
