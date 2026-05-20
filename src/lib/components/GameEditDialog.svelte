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
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 0;
    width: min(640px, calc(100vw - 2 * var(--s-4)));
    max-height: min(90vh, calc(100vh - 2 * var(--s-6)));
    box-shadow: var(--shadow-elev);
    overflow: hidden;
  }
  .dialog::backdrop {
    background: var(--overlay-dark);
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-4);
    padding: var(--s-4) var(--s-6);
    border-bottom: 1px solid var(--border);
  }
  .heading {
    margin: 0;
    font-size: var(--t-17);
    font-weight: var(--w-sb);
    color: var(--text);
  }
  .close {
    background: transparent;
    color: var(--text-3);
    border: none;
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
    padding: var(--s-1) var(--s-2);
    border-radius: var(--r-sm);
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .close:hover:not(:disabled) {
    color: var(--text);
    background: var(--accent-soft);
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    padding: var(--s-6);
    overflow-y: auto;
    flex: 1 1 auto;
    min-height: 0;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    min-width: 0;
  }
  .field-label {
    font-size: var(--t-13);
    color: var(--text-2);
    font-weight: var(--w-md);
  }
  .input {
    min-height: var(--hit);
    padding: var(--s-2) var(--s-3);
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    width: 100%;
    box-sizing: border-box;
    transition: border-color var(--m-fast) var(--m-ease);
  }
  .input:hover:not(:disabled) {
    border-color: var(--accent-strong);
  }
  .textarea {
    padding: var(--s-2) var(--s-3);
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    line-height: var(--lh-body);
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 120px;
    transition: border-color var(--m-fast) var(--m-ease);
  }
  .textarea:hover:not(:disabled) {
    border-color: var(--accent-strong);
  }
  .char-count {
    align-self: flex-end;
    font-size: var(--t-12);
    color: var(--text-3);
  }
  .actions {
    display: flex;
    gap: var(--s-2);
    justify-content: flex-end;
    border-top: 1px solid var(--border-hairline);
    padding-top: var(--s-4);
    margin-top: var(--s-2);
  }
  .cancel,
  .save {
    min-height: var(--hit);
    padding: var(--s-2) var(--s-4);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .cancel {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
  }
  .cancel:hover:not(:disabled) {
    background: var(--accent-soft);
    border-color: var(--accent-strong);
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
  .cancel:disabled,
  .close:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  @media (prefers-reduced-motion: reduce) {
    .close,
    .input,
    .textarea,
    .cancel,
    .save {
      transition: none;
    }
  }
</style>
