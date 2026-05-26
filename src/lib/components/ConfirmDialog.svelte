<script lang="ts">
  // ConfirmDialog — native <dialog> element wrapper for destructive
  // confirmations (UI-SPEC §"Destructive confirmations").
  //
  // Two-button: cancel (default surface + border) and confirm (destructive
  // color). For irreversible actions, the confirm button is initially
  // disabled until the user ticks an "I understand this is permanent"
  // checkbox — the speed-bump pattern from PROJECT.md's "calm > flashy"
  // stance applied to security-impactful actions (key remove, key replace).
  //
  // Type-DELETE variant: when `requireText` is set (e.g. "DELETE"), the
  // dialog renders a text input under the body and the confirm button
  // stays disabled until the input value matches the required string
  // verbatim. Layered with `isIrreversible` (the checkbox speedbump) when
  // both are set; either gate disables the confirm button. When
  // `requireText` is null/undefined, the dialog behaves like a plain
  // confirmation — no behavior change for existing call sites.
  //
  // Native <dialog>'s showModal() traps focus and gives us escape-to-close
  // behaviour without a focus-trap library. The cancel button is the
  // default focus target.

  import { m } from "$lib/paraglide/messages.js";

  let {
    open,
    message,
    confirmLabel,
    isIrreversible = false,
    requireText = null,
    onConfirm,
    onCancel,
  }: {
    open: boolean;
    message: string;
    confirmLabel: string;
    isIrreversible?: boolean;
    requireText?: string | null;
    onConfirm: () => void;
    onCancel: () => void;
  } = $props();

  let dialogEl: HTMLDialogElement | null = $state(null);
  let acknowledged = $state(false);
  let typedText = $state("");

  // Open / close the native dialog when the `open` prop changes.
  $effect(() => {
    if (!dialogEl) return;
    if (open && !dialogEl.open) {
      acknowledged = false;
      typedText = "";
      dialogEl.showModal();
    } else if (!open && dialogEl.open) {
      dialogEl.close();
    }
  });

  // Confirm-disabled gate: BOTH gates must pass when set. isIrreversible
  // requires the acknowledge checkbox; requireText requires the input
  // value to match exactly. When neither is set, the button is always
  // enabled (the parent's open-true is itself the user's intent).
  const confirmDisabled = $derived(
    (isIrreversible && !acknowledged) || (requireText !== null && typedText !== requireText),
  );

  function handleCancel(): void {
    onCancel();
  }

  function handleConfirm(): void {
    if (confirmDisabled) return;
    onConfirm();
  }

  // Native <dialog> emits 'cancel' on Escape — wire it to onCancel so the
  // parent can update its `open` prop.
  function onDialogCancel(e: Event): void {
    e.preventDefault();
    handleCancel();
  }
</script>

<dialog bind:this={dialogEl} class="dialog" oncancel={onDialogCancel}>
  <p class="message">{message}</p>
  {#if isIrreversible}
    <label class="speedbump">
      <input type="checkbox" bind:checked={acknowledged} />
      <span>{m.confirm_speedbump_acknowledge()}</span>
    </label>
  {/if}
  {#if requireText !== null}
    <label class="type-delete">
      <span class="type-delete-label">{m.confirm_dialog_type_delete_label()}</span>
      <input
        type="text"
        class="type-delete-input"
        placeholder={m.confirm_dialog_type_delete_placeholder()}
        bind:value={typedText}
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
      />
    </label>
  {/if}
  <div class="actions">
    <button type="button" class="cancel" onclick={handleCancel}>
      {m.common_cancel()}
    </button>
    <button type="button" class="confirm" onclick={handleConfirm} disabled={confirmDisabled}>
      {confirmLabel}
    </button>
  </div>
</dialog>

<style>
  /* v2 dialog recipe — --r-md panel + --shadow-elev + --surface-2 body. Sibling
   * dialogs (GameEditDialog, AddStoreDialog, RecoveryDialog) share the same
   * surface tokens so the four modal patterns feel like one family. */
  .dialog {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: var(--s-6);
    max-width: min(440px, calc(100vw - 2 * var(--s-4)));
    box-shadow: var(--shadow-elev);
  }
  .dialog::backdrop {
    background: var(--overlay-dark);
  }
  .message {
    margin: 0 0 var(--s-4) 0;
    font-size: var(--t-14);
    line-height: var(--lh-body);
    color: var(--text-2);
  }
  .speedbump {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-2);
    background: var(--surface-3);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    margin-bottom: var(--s-4);
    font-size: var(--t-13);
    color: var(--text-2);
  }
  .type-delete {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    margin-bottom: var(--s-4);
    font-size: var(--t-13);
  }
  .type-delete-label {
    color: var(--text-3);
  }
  .type-delete-input {
    min-height: var(--hit);
    padding: var(--s-2) var(--s-3);
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-size: var(--t-14);
    font-family: var(--f-mono);
  }
  /* :focus-visible inherits the global var(--focus-ring) box-shadow from app.css */
  .actions {
    display: flex;
    gap: var(--s-2);
    justify-content: flex-end;
    margin-top: var(--s-6);
  }
  .cancel,
  .confirm {
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
  .cancel:hover {
    background: var(--accent-soft);
    border-color: var(--accent-strong);
  }
  /* Destructive confirm — --danger token. ConfirmDialog is always destructive
   * (the speedbump + type-DELETE gates exist for irreversible actions). */
  .confirm {
    background: var(--danger);
    color: #fff;
    border: 1px solid var(--danger);
  }
  .confirm:hover:not(:disabled) {
    filter: brightness(1.05);
  }
  .confirm:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  @media (prefers-reduced-motion: reduce) {
    .cancel,
    .confirm {
      transition: none;
    }
  }
</style>
