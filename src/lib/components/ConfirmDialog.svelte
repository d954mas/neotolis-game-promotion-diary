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
  // Native <dialog>'s showModal() traps focus and gives us escape-to-close
  // behaviour without a focus-trap library. The cancel button is the
  // default focus target.

  import { m } from "$lib/paraglide/messages.js";

  let {
    open,
    message,
    confirmLabel,
    isIrreversible = false,
    onConfirm,
    onCancel,
  }: {
    open: boolean;
    message: string;
    confirmLabel: string;
    isIrreversible?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  } = $props();

  let dialogEl: HTMLDialogElement | null = $state(null);
  let acknowledged = $state(false);

  // Open / close the native dialog when the `open` prop changes.
  $effect(() => {
    if (!dialogEl) return;
    if (open && !dialogEl.open) {
      acknowledged = false;
      dialogEl.showModal();
    } else if (!open && dialogEl.open) {
      dialogEl.close();
    }
  });

  function handleCancel(): void {
    onCancel();
  }

  function handleConfirm(): void {
    if (isIrreversible && !acknowledged) return;
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
  <div class="actions">
    <button type="button" class="cancel" onclick={handleCancel}>
      {m.common_cancel()}
    </button>
    <button
      type="button"
      class="confirm"
      onclick={handleConfirm}
      disabled={isIrreversible && !acknowledged}
    >
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
