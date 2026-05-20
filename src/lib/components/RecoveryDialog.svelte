<script lang="ts">
  // RecoveryDialog — modal dialog for soft-delete recovery.
  //
  // Why a modal instead of a bottom-of-page anchor: an anchor link
  // breaks on infinite-scroll surfaces by construction — clicking it
  // jumps to the bottom of the list, the IntersectionObserver sentinel
  // fires, the loader appends another page, the bottom moves further
  // down, and the user never reaches the recovery panel. A modal
  // decouples the recovery UI from scroll position. Pattern matches
  // the existing <ConfirmDialog> — native <dialog> element, showModal()
  // traps focus, Escape closes for free. No focus-trap library needed.
  //
  // Generic across entity types (event / game / source / store) — the props
  // are shaped { id, name, deletedAt } per item plus an entityType
  // discriminator and an onRestore callback. /feed maps the existing
  // deletedEvents[] (toEventDto-projected, no ciphertext columns) into
  // this shape; /games (entityType="game"), /sources (entityType="source"),
  // and the per-game /games/[gameId] view (entityType="store") each use
  // the same component. The "store" discriminator covers
  // `game_steam_listings` rows.
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
    // Visual treatment is identical across entity types today; the
    // discriminator is exposed via data-entity-type for future per-type
    // styling / a11y hooks.
    entityType: "game" | "source" | "event" | "store";
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

  // entityType is exposed on the dialog as a data attribute so future
  // styling / a11y hooks can target per-type.
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
   * so the dialog is wider and gets a max-height + scrollable body.
   *
   * Native <dialog> is hidden by UA stylesheet via `display: none`
   * UNLESS the [open] attribute is set (which showModal()/show() add
   * automatically). Declaring `display: flex` on `.dialog`
   * unconditionally OVERRIDES the UA hide rule and leaks the dialog
   * into normal flow even when closed. Scope the flex display to
   * `[open]` so the closed state stays hidden. */
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
    width: min(560px, calc(100vw - 2 * var(--s-4)));
    max-height: min(80vh, calc(100vh - 2 * var(--s-6)));
    box-shadow: var(--shadow-elev);
    /* The dialog body needs to scroll independently when the recovery
     * list overflows. Native <dialog> applies overflow:auto by default
     * via UA stylesheet on Chromium but Firefox does not — declare it
     * explicitly. */
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
  .close:hover {
    color: var(--text);
    background: var(--accent-soft);
  }
  .empty {
    margin: 0;
    padding: var(--s-6);
    color: var(--text-3);
    font-size: var(--t-14);
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
    gap: var(--s-2);
    padding: var(--s-3) var(--s-6);
    border-bottom: 1px solid var(--border-hairline);
  }
  .row:last-child {
    border-bottom: none;
  }
  .name {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--text);
    font-size: var(--t-14);
    word-break: break-word;
  }
  .restore {
    min-height: var(--hit);
    padding: var(--s-1) var(--s-4);
    background: transparent;
    color: var(--accent);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    cursor: pointer;
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-md);
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .restore:hover:not(:disabled) {
    background: var(--accent-soft);
    border-color: var(--accent-strong);
  }
  .restore:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  @media (prefers-reduced-motion: reduce) {
    .close,
    .restore {
      transition: none;
    }
  }
</style>
