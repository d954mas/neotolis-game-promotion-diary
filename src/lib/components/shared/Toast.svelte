<script lang="ts">
  // Toast — Wave 0 Plan 03 shared primitive (Foundation C).
  //
  // Inline-mountable toast notification used by AddEventModal save success
  // (D-18: "Save → close + toast 'Event added' + refresh feed"), bulk-action
  // success on /feed, and any future caller that needs a transient status
  // surface. The component is intentionally minimal: caller owns mount/
  // unmount lifecycle (via {#if showToast}), the component owns the
  // auto-dismiss timer + Escape-to-close + ARIA live-region semantics.
  //
  // There is NO global toast manager / toast queue — see SUMMARY rationale.
  // If a real-world need for stacked concurrent toasts surfaces, the
  // upgrade path is a separate ToastQueue store + a slot-style mount
  // wrapper; the per-toast component contract stays the same.

  import { m } from "$lib/paraglide/messages.js";

  let {
    kind = "info",
    text,
    autocloseMs = 4000,
    onclose,
  }: {
    kind?: "success" | "info" | "danger";
    text: string;
    autocloseMs?: number;
    onclose?: () => void;
  } = $props();

  let timer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    if (autocloseMs > 0) {
      timer = setTimeout(() => {
        close();
      }, autocloseMs);
    }
    // Window-level Escape listener — the toast itself is a non-interactive
    // status region (role="status"), so attaching keydown to its container
    // would (a) require a tabindex to be reachable, (b) trip svelte's
    // a11y_no_noninteractive_element_interactions lint. Global Escape is
    // the standard dismiss pattern for transient overlays.
    function onkeydown(e: KeyboardEvent): void {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onkeydown);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("keydown", onkeydown);
    };
  });

  function close(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    onclose?.();
  }
</script>

<div class="toast" data-kind={kind} role="status" aria-live="polite">
  <span class="toast-text">{text}</span>
  <button type="button" class="toast-close" aria-label={m.toast_close_aria()} onclick={close}>
    ×
  </button>
</div>

<style>
  .toast {
    position: fixed;
    bottom: var(--s-5);
    left: 50%;
    transform: translateX(-50%);
    z-index: 100;
    display: inline-flex;
    align-items: center;
    gap: var(--s-3);
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: var(--s-3) var(--s-4);
    box-shadow: var(--shadow-elev);
    font-size: var(--t-13);
    max-width: calc(100vw - var(--s-6));
    animation: toast-in var(--m-base) var(--m-ease);
  }
  .toast[data-kind="success"] {
    border-color: var(--success);
  }
  .toast[data-kind="info"] {
    border-color: var(--info);
  }
  .toast[data-kind="danger"] {
    border-color: var(--danger);
    color: var(--danger);
  }
  .toast-close {
    background: transparent;
    border: none;
    color: var(--text-3);
    cursor: pointer;
    font-size: var(--t-17);
    line-height: 1;
    padding: 0 var(--s-1);
  }
  .toast-close:hover {
    color: var(--text);
  }
  @keyframes toast-in {
    from {
      transform: translate(-50%, var(--s-5));
      opacity: 0;
    }
    to {
      transform: translate(-50%, 0);
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .toast {
      animation: none;
    }
  }
</style>
