<script lang="ts">
  // GameEditDialog — modal dialog for editing game.title + game.description
  // on /games/[gameId].
  //
  // PageHeader.title is the only title; the Edit button opens THIS modal
  // with title input + description textarea + Save / Cancel.
  //
  // Pattern matches RecoveryDialog / ConfirmDialog: native <dialog>
  // element + showModal() (focus trap + Escape-to-close for free) +
  // backdrop-click closes via target===dialogEl discriminator + the
  // .dialog[open] display:flex scoping so the closed state stays hidden.
  //
  // Save flow: on submit, call onSave({title, description}). The parent
  // owns the fetch (PATCH /api/games/:id) so this component stays a
  // pure UI primitive — same separation as RecoveryDialog's onRestore
  // callback. Pending state during save; InlineError on rejection.
  //
  // Privacy invariant: this dialog handles game.title + game.description,
  // both of which are non-secret fields. The toGameDto projection layer
  // is the runtime barrier; this component never sees ciphertext columns
  // by construction.

  import { tick } from "svelte";
  import { m } from "$lib/paraglide/messages.js";
  import InlineError from "./InlineError.svelte";

  let {
    open,
    initialTitle,
    initialDescription,
    onClose,
    onSave,
  }: {
    open: boolean;
    initialTitle: string;
    initialDescription: string | null;
    onClose: () => void;
    onSave: (data: { title: string; description: string | null }) => Promise<void>;
  } = $props();

  let dialogEl: HTMLDialogElement | null = $state(null);
  let titleInputEl: HTMLInputElement | null = $state(null);
  let titleValue = $state(initialTitle);
  let descriptionValue = $state(initialDescription ?? "");
  let pending = $state(false);
  let errorText = $state<string | null>(null);

  // Reset form whenever the dialog opens — picks up the latest game
  // data after invalidateAll() refreshes the loader. Without this,
  // editing twice in a row would show the stale snapshot from the
  // previous open. Focus the title input so keyboard users can start
  // typing immediately (matches RenameInline's startEdit() ergonomics).
  $effect(() => {
    if (!dialogEl) return;
    if (open && !dialogEl.open) {
      titleValue = initialTitle;
      descriptionValue = initialDescription ?? "";
      errorText = null;
      dialogEl.showModal();
      void tick().then(() => {
        titleInputEl?.focus();
        titleInputEl?.select();
      });
    } else if (!open && dialogEl.open) {
      dialogEl.close();
    }
  });

  // Native <dialog> emits 'cancel' on Escape — wire it to onClose so
  // the parent can update its `open` prop. preventDefault keeps the
  // browser from also firing its own close action (which would fire
  // before our state cleanup).
  function onDialogCancel(e: Event): void {
    e.preventDefault();
    if (pending) return;
    onClose();
  }

  // Backdrop click — same target===dialogEl discriminator as
  // RecoveryDialog. Inner clicks (input, button) report the inner
  // element as e.target.
  function onDialogClick(e: MouseEvent): void {
    if (pending) return;
    if (e.target === dialogEl) onClose();
  }

  async function handleSave(e: Event): Promise<void> {
    e.preventDefault();
    if (pending) return;
    const trimmedTitle = titleValue.trim();
    if (trimmedTitle.length === 0) {
      errorText = m.error_server_generic();
      return;
    }
    // Empty / whitespace description normalizes to null at the service
    // layer too, but we send null explicitly so the wire payload is
    // unambiguous (the route schema accepts both empty string and null
    // — the service collapses them to NULL — but null is the canonical
    // form in the DTO so the client sends what it expects to read back).
    const trimmedDescription = descriptionValue.trim();
    const payload = {
      title: trimmedTitle,
      description: trimmedDescription.length === 0 ? null : descriptionValue,
    };
    pending = true;
    errorText = null;
    try {
      await onSave(payload);
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : m.error_server_generic();
      errorText = message;
    } finally {
      pending = false;
    }
  }

  function handleCancel(): void {
    if (pending) return;
    onClose();
  }
</script>

<dialog bind:this={dialogEl} class="dialog" oncancel={onDialogCancel} onclick={onDialogClick}>
  <header class="header">
    <h2 class="heading">{m.games_edit_dialog_heading()}</h2>
    <button
      type="button"
      class="close"
      aria-label={m.common_close()}
      onclick={handleCancel}
      disabled={pending}
    >
      ×
    </button>
  </header>

  <form class="body" onsubmit={handleSave}>
    <label class="field">
      <span class="field-label">{m.games_edit_title_label()}</span>
      <input
        bind:this={titleInputEl}
        bind:value={titleValue}
        class="input"
        type="text"
        maxlength="200"
        disabled={pending}
        required
      />
    </label>
    <label class="field">
      <span class="field-label">{m.games_edit_description_label()}</span>
      <textarea
        bind:value={descriptionValue}
        class="textarea"
        maxlength="2000"
        rows="6"
        placeholder={m.games_edit_description_placeholder()}
        disabled={pending}
      ></textarea>
      <span class="char-count">{descriptionValue.length} / 2000</span>
    </label>
    {#if errorText}<InlineError message={errorText} />{/if}
    <footer class="actions">
      <button type="button" class="cancel" onclick={handleCancel} disabled={pending}>
        {m.games_edit_cancel_cta()}
      </button>
      <button type="submit" class="save" disabled={pending}>
        {m.games_edit_save_cta()}
      </button>
    </footer>
  </form>
</dialog>

<style>
  /* Mirrors RecoveryDialog / ConfirmDialog visual treatment so the
   * three modal patterns feel like one family.
   *
   * .dialog[open] { display: flex } scoping is the load-bearing rule
   * that keeps a closed dialog hidden. UA stylesheet default is
   * `display: none` UNLESS [open] is set; an unscoped `display: flex`
   * on `.dialog` would override the UA hide rule and leak the dialog
   * into normal flow even when closed. */
  .dialog[open] {
    display: flex;
    flex-direction: column;
  }
  .dialog {
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 0;
    width: min(640px, calc(100vw - 2 * var(--space-md)));
    max-height: min(90vh, calc(100vh - 2 * var(--space-lg)));
    box-shadow: 0 8px 24px rgb(0 0 0 / 25%);
    overflow: hidden;
  }
  .dialog::backdrop {
    background: rgb(0 0 0 / 50%);
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
    padding: var(--space-md) var(--space-lg);
    border-bottom: 1px solid var(--color-border);
  }
  .heading {
    margin: 0;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
  }
  .close {
    background: transparent;
    color: var(--color-text-muted);
    border: none;
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
    padding: var(--space-xs) var(--space-sm);
    border-radius: 4px;
  }
  .close:hover:not(:disabled) {
    color: var(--color-text);
    background: var(--color-bg);
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    padding: var(--space-lg);
    overflow-y: auto;
    flex: 1 1 auto;
    min-height: 0;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    min-width: 0;
  }
  .field-label {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    font-weight: var(--font-weight-semibold);
  }
  .input {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    width: 100%;
    box-sizing: border-box;
  }
  .textarea {
    padding: var(--space-sm) var(--space-md);
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
    line-height: var(--line-height-body);
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 120px;
    font-family: inherit;
  }
  .char-count {
    align-self: flex-end;
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .actions {
    display: flex;
    gap: var(--space-sm);
    justify-content: flex-end;
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-md);
    margin-top: var(--space-sm);
  }
  .cancel,
  .save {
    min-height: 44px;
    padding: 0 var(--space-md);
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .cancel {
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }
  .cancel:hover:not(:disabled) {
    background: var(--color-bg);
  }
  .save {
    background: var(--color-accent);
    color: var(--color-accent-text, #fff);
    border: 1px solid var(--color-accent);
  }
  .save:hover:not(:disabled) {
    filter: brightness(1.05);
  }
  .save:disabled,
  .cancel:disabled,
  .close:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
