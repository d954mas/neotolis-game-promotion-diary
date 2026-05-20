<script lang="ts">
  // RenameInline — click-to-edit pattern for the game title on /games/[id].
  //
  // Read mode: a button with the title rendered as <h1>. Click → edit mode.
  // Edit mode: text input + Save name / Discard changes buttons (visible
  // text labels — no aria-label needed when the visible label is the
  // accessible name).
  //
  // Esc on the input fires Discard (matches the visible button); Enter fires
  // Save. Save invokes the parent-supplied onSave callback; on success the
  // component returns to read mode. On error the parent surfaces InlineError.
  //
  // Destructive-cancel context: typed-but-unsaved input is thrown away on
  // Discard. m.common_cancel() is reserved for non-destructive close; this
  // component uses the scoped m.game_rename_cta_discard() copy ("Discard
  // changes") so the affordance is honest.

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
      const message = err instanceof Error && err.message ? err.message : m.error_server_generic();
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
  /* v2 RenameInline — D-01 redraw via inline-edit pattern. Click-to-edit
   * read button with --surface-2 hover; editing mode has --surface-3 input
   * + --accent save + --border cancel. */
  .read {
    background: transparent;
    border: 1px solid transparent;
    padding: var(--s-1) var(--s-2);
    border-radius: var(--r-sm);
    cursor: text;
    text-align: left;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .read:hover,
  .read:focus-visible {
    background: var(--surface-2);
    border-color: var(--border);
  }
  .title {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    line-height: var(--lh-tight);
    color: var(--text);
  }
  .edit {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    min-width: 0;
  }
  .input {
    min-height: var(--hit);
    padding: var(--s-1) var(--s-3);
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-17);
    font-weight: var(--w-sb);
    width: 100%;
    box-sizing: border-box;
    transition: border-color var(--m-fast) var(--m-ease);
  }
  .input:hover {
    border-color: var(--accent-strong);
  }
  .actions {
    display: flex;
    gap: var(--s-2);
    flex-wrap: wrap;
  }
  .save,
  .discard {
    min-height: var(--hit);
    padding: var(--s-1) var(--s-3);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .save {
    background: var(--accent);
    color: var(--accent-text);
    border: 1px solid var(--accent);
  }
  .save:hover:not(:disabled) {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .save:disabled,
  .discard:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .discard {
    background: transparent;
    color: var(--text-2);
    border: 1px solid var(--border);
  }
  .discard:hover:not(:disabled) {
    background: var(--accent-soft);
    border-color: var(--accent-strong);
  }
  @media (prefers-reduced-motion: reduce) {
    .read,
    .input,
    .save,
    .discard {
      transition: none;
    }
  }
</style>
