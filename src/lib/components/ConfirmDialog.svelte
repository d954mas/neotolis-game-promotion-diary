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
  // Plan 02.2-04 (D-S3): an additional Type-DELETE variant. When `requireText`
  // is set (e.g. "DELETE"), the dialog renders a text input under the body
  // and the confirm button stays disabled until the input value matches the
  // required string verbatim. Layered with `isIrreversible` (the checkbox
  // speedbump) when both are set; either gate disables the confirm button.
  // When `requireText` is null/undefined, the dialog behaves exactly as it
  // did pre-Phase-2.2 — no behavior change for existing call sites.
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
  .dialog {
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: var(--space-lg);
    max-width: min(440px, calc(100vw - 2 * var(--space-md)));
    box-shadow: 0 8px 24px rgb(0 0 0 / 25%);
  }
  .dialog::backdrop {
    background: rgb(0 0 0 / 50%);
  }
  .message {
    margin: 0 0 var(--space-md) 0;
    font-size: var(--font-size-body);
    line-height: var(--line-height-body);
  }
  .speedbump {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-sm);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    margin-bottom: var(--space-md);
    font-size: var(--font-size-label);
  }
  .type-delete {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    margin-bottom: var(--space-md);
    font-size: var(--font-size-label);
  }
  .type-delete-label {
    color: var(--color-text-muted);
  }
  .type-delete-input {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .type-delete-input:focus {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
  .actions {
    display: flex;
    gap: var(--space-sm);
    justify-content: flex-end;
  }
  .cancel,
  .confirm {
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
  .confirm {
    background: var(--color-destructive);
    color: #fff;
    border: 1px solid var(--color-destructive);
  }
  .confirm:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
