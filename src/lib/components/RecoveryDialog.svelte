<script lang="ts">
  // RecoveryDialog — modal dialog for soft-delete recovery, replaces the
  // bottom-of-page DeletedEventsPanel anchor target on /feed.
  //
  // Plan 02.1-39 round-6 polish #11 (UAT-NOTES.md §5.8 follow-up #11,
  // 2026-04-30). User during round-6 UAT, after polish #10 (chip-strip
  // Clear preserves date) landed:
  //
  //   "Да но оно странно работает, оно меня кидает просто вниз страницы.
  //    А если у меня тут бесконечная лента, то новые эвенты подгрузит и
  //    меня снова кинет вниз? как будто нужно чтобы там оно раскрывалось
  //    или в отдельном окне"
  //   ("Yes but it works oddly, it just throws me to the bottom of the
  //    page. And if I have an infinite feed, it'll load more events and
  //    throw me down again? Like it should expand or [open] in a
  //    separate window.")
  //
  // §5.8 Path A (the "Recently deleted (N)" anchor link in PageHeader)
  // breaks on infinite-scroll surfaces by construction: clicking the
  // anchor jumps to the bottom of the list, the IntersectionObserver
  // sentinel fires, the loader appends another page, the bottom moves
  // further down — the user never reaches the recovery panel.
  //
  // The fix is decoupling the recovery UI from scroll position: open
  // the recovery list inside a modal. Pattern matches the existing
  // <ConfirmDialog> — native <dialog> element, showModal() traps focus,
  // Escape closes for free. No focus-trap library needed.
  //
  // Generic across entity types (event / game / source) — the props are
  // shaped { id, name, deletedAt } per item plus an entityType discriminator
  // and an onRestore callback. /feed (only consumer in 2.1) maps the
  // existing deletedEvents[] (toEventDto-projected, no ciphertext columns)
  // into this shape; future Phase-3+ pages (/games, /sources soft-delete
  // sections — currently inline <details> blocks) can drop in without
  // rebuilding the dialog.
  //
  // Privacy invariant (CLAUDE.md):
  //   - The component receives only DTO-projected items from SSR.
  //   - The fetch goes through the parent's onRestore callback, which
  //     hits a tenantScope-middleware-gated endpoint.
  //   - Renders nothing when items.length === 0 (the parent should also
  //     conditionally render — this is defense-in-depth).

  import { m } from "$lib/paraglide/messages.js";
  import RetentionBadge from "./RetentionBadge.svelte";

  type RecoveryItem = {
    id: string;
    name: string;
    deletedAt: Date | string | null;
  };

  let {
    open,
    items,
    entityType,
    retentionDays,
    onClose,
    onRestore,
  }: {
    open: boolean;
    items: RecoveryItem[];
    entityType: "game" | "source" | "event";
    retentionDays: number;
    onClose: () => void;
    onRestore: (id: string) => Promise<void>;
  } = $props();

  let dialogEl: HTMLDialogElement | null = $state(null);
  let pendingId = $state<string | null>(null);

  // Open / close the native dialog when the `open` prop changes — same
  // pattern as ConfirmDialog. showModal() traps focus and gives us
  // escape-to-close + backdrop dim for free.
  $effect(() => {
    if (!dialogEl) return;
    if (open && !dialogEl.open) {
      dialogEl.showModal();
    } else if (!open && dialogEl.open) {
      dialogEl.close();
    }
  });

  // Native <dialog> emits 'cancel' on Escape — wire it to onClose so the
  // parent can update its `open` prop.
  function onDialogCancel(e: Event): void {
    e.preventDefault();
    onClose();
  }

  // Backdrop click — the click event on a <dialog> reports the dialog
  // element itself as e.target when the click landed on the ::backdrop
  // pseudo-element. Click on any inner element (button, list row) reports
  // that inner element as e.target. So target === dialogEl is the
  // load-bearing backdrop discriminator.
  function onDialogClick(e: MouseEvent): void {
    if (e.target === dialogEl) onClose();
  }

  async function restore(id: string): Promise<void> {
    if (pendingId !== null) return;
    pendingId = id;
    try {
      await onRestore(id);
    } finally {
      pendingId = null;
    }
  }

  // entityType is part of the prop contract for forward-compat — /games
  // and /sources will adopt this dialog in Phase 6 polish (see UAT-NOTES.md
  // §5.8 paths B/C deferred to /trash). We expose it on the dialog as a
  // data attribute so future styling / a11y hooks can target per-type.
</script>

<dialog
  bind:this={dialogEl}
  class="dialog"
  data-entity-type={entityType}
  oncancel={onDialogCancel}
  onclick={onDialogClick}
>
  <header class="header">
    <h2 class="heading">{m.recovery_dialog_heading({ count: items.length })}</h2>
    <button type="button" class="close" aria-label={m.common_close()} onclick={onClose}> × </button>
  </header>

  {#if items.length === 0}
    <p class="empty">{m.recovery_dialog_empty()}</p>
  {:else}
    <ul class="rows">
      {#each items as item (item.id)}
        <li class="row">
          <span class="name">{item.name}</span>
          {#if item.deletedAt !== null}
            <RetentionBadge deletedAt={item.deletedAt} {retentionDays} />
          {/if}
          <button
            type="button"
            class="restore"
            disabled={pendingId === item.id}
            onclick={() => restore(item.id)}
          >
            {m.common_restore()}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</dialog>

<style>
  /* Mirrors ConfirmDialog's surface tokens (--color-surface / --color-border
   * / 6px radius / 25% shadow) for visual consistency across the two
   * dialog patterns. The recovery list is variable-length (1-N items)
   * so the dialog is wider and gets a max-height + scrollable body. */
  /* Round-6 polish #11 follow-up: native <dialog> is hidden by UA
   * stylesheet via `display: none` UNLESS the [open] attribute is set
   * (which showModal()/show() add automatically). Declaring `display:
   * flex` on `.dialog` unconditionally OVERRIDES the UA hide rule and
   * leaks the dialog into normal flow even when closed. Scope the
   * flex display to `[open]` so the closed state stays hidden. */
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
    width: min(560px, calc(100vw - 2 * var(--space-md)));
    max-height: min(80vh, calc(100vh - 2 * var(--space-lg)));
    box-shadow: 0 8px 24px rgb(0 0 0 / 25%);
    /* The dialog body needs to scroll independently when the recovery
     * list overflows. Native <dialog> applies overflow:auto by default
     * via UA stylesheet on Chromium but Firefox does not — declare it
     * explicitly. */
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
  .close:hover {
    color: var(--color-text);
    background: var(--color-bg);
  }
  .empty {
    margin: 0;
    padding: var(--space-lg);
    color: var(--color-text-muted);
    font-size: var(--font-size-body);
    text-align: center;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    /* Subtract the header row so the body scrolls within the dialog's
     * max-height envelope rather than pushing the dialog taller. */
    flex: 1 1 auto;
    min-height: 0;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-md) var(--space-lg);
    border-bottom: 1px solid var(--color-border);
  }
  .row:last-child {
    border-bottom: none;
  }
  .name {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--color-text);
    word-break: break-word;
  }
  .restore {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-accent);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-label);
  }
  .restore:hover {
    filter: brightness(1.05);
  }
  .restore:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
