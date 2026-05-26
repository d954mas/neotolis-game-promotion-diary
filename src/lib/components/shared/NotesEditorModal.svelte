<script lang="ts">
  // NotesEditorModal — shared big-notes editor used by:
  //   - EventDetailContent (event notes editor),
  //   - AddEventForm (new-event notes editor),
  //   - /games/[gameId]/+page.svelte (game notes editor).
  //
  // All three call sites had the same dialog + textarea + Save/Cancel
  // footer + Cmd/Ctrl+Enter shortcut + Esc-to-cancel + click-backdrop-
  // to-cancel pattern, copy-pasted across files. Extracted per the
  // self-review audit's DRY-extract NotesEditorModal finding.
  //
  // Contract preserved exactly from the inlined versions:
  //   - <dialog open> sibling (mounts as top-layer so it sits above any
  //     parent modal — same trick as EventDetailModal),
  //   - oncancel + backdrop click + Esc all call onCancel,
  //   - Cmd/Ctrl+Enter inside textarea calls onSave,
  //   - autofocus on the textarea,
  //   - draft state is OWNED by this component (so a caller's
  //     `initialValue` reset doesn't clobber an in-progress edit),
  //   - body slot is a single textarea with the prototype's
  //     .notes-editor-textarea styling.
  //
  // Caller responsibilities:
  //   - own the `open` prop and toggle it on user intent (click pencil
  //     to open, Save success to close),
  //   - own the PATCH/POST in onSave; if the request can throw,
  //     re-throw to keep the modal open so the user can retry.
  //
  // CSS contract: the prototype's `.notes-editor-modal` / `-head` /
  // `-title` / `-close` / `-body` / `-textarea` / `-foot` class names
  // are kept here verbatim. Callers' tests that read by class name keep
  // passing without per-site cosmetic CSS overrides.

  let {
    open,
    initialValue,
    title = "Notes",
    placeholder = "",
    maxLength = 50_000,
    onSave,
    onCancel,
  }: {
    open: boolean;
    initialValue: string;
    title?: string;
    placeholder?: string;
    maxLength?: number;
    onSave: (value: string) => Promise<void> | void;
    onCancel: () => void;
  } = $props();

  // Draft state — initialised from initialValue every time the modal
  // OPENS (open transitions false → true). Editing only mutates draft;
  // the caller's `initialValue` reference is read-only here. Mirrors
  // the previous inline shape where each call site held its own draft
  // and copied event.notes / game.notes into it on the open handler.
  let draft = $state("");
  // Track the previous open value so we only reseed draft on the
  // false → true transition (not on every prop change while open).
  let prevOpen = false;
  $effect(() => {
    if (open && !prevOpen) {
      draft = initialValue ?? "";
    }
    prevOpen = open;
  });

  let saving = $state(false);

  async function commit(): Promise<void> {
    if (saving) return;
    saving = true;
    try {
      await onSave(draft);
    } finally {
      saving = false;
    }
  }

  function cancel(): void {
    onCancel();
  }
</script>

{#if open}
  <dialog
    class="notes-editor-modal"
    open
    oncancel={(e) => {
      e.preventDefault();
      cancel();
    }}
    onclick={(e) => {
      if (e.target === e.currentTarget) cancel();
    }}
  >
    <header class="notes-editor-head">
      <h2 class="notes-editor-title">{title}</h2>
      <button
        type="button"
        class="notes-editor-close"
        onclick={cancel}
        aria-label="Close"
        title="Close"
      >×</button>
    </header>
    <div class="notes-editor-body">
      <!-- svelte-ignore a11y_autofocus -->
      <textarea
        class="notes-editor-textarea"
        bind:value={draft}
        onkeydown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void commit();
          }
        }}
        maxlength={maxLength}
        autofocus
        {placeholder}
      ></textarea>
    </div>
    <footer class="notes-editor-foot">
      <button type="button" class="btn ghost" onclick={cancel}>Cancel</button>
      <button
        type="button"
        class="btn primary"
        onclick={() => void commit()}
        disabled={saving}
      >{saving ? "Saving…" : "Save"}</button>
    </footer>
  </dialog>
{/if}

<style>
  /* Prototype 1:1 — class names mirror docs/design/v2/ui-kit/index.html
   * .notes-editor-modal / .notes-editor-head / .notes-editor-title /
   * .notes-editor-close / .notes-editor-body / .notes-editor-textarea /
   * .notes-editor-foot. Replaces the same rules previously duplicated
   * inside EventDetailContent.svelte, AddEventForm.svelte and
   * /games/[gameId]/+page.svelte. */
  .notes-editor-modal {
    width: min(900px, calc(100vw - 32px));
    max-height: min(86vh, 820px);
    padding: 0;
    margin: auto;
    border: 1px solid var(--border-2);
    border-radius: var(--r-lg);
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-elev);
    display: flex;
    flex-direction: column;
    position: fixed;
    inset: 0;
    z-index: 1000;
  }
  .notes-editor-modal::backdrop {
    background: var(--overlay-dark);
    backdrop-filter: blur(2px);
  }
  .notes-editor-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-hairline);
  }
  .notes-editor-title {
    flex: 1;
    margin: 0;
    font-size: var(--t-15);
    font-weight: var(--w-sb);
  }
  .notes-editor-close {
    background: transparent;
    border: 0;
    color: var(--text-3);
    font-size: 20px;
    width: 32px;
    height: 32px;
    border-radius: var(--r-sm);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .notes-editor-close:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .notes-editor-body {
    flex: 1;
    min-height: 0;
    padding: 16px;
    display: flex;
  }
  .notes-editor-textarea {
    flex: 1;
    min-height: 60vh;
    width: 100%;
    padding: 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    color: var(--text);
    font: inherit;
    font-family: var(--f-sans);
    font-size: var(--t-14);
    line-height: 1.55;
    resize: none;
    outline: none;
  }
  .notes-editor-textarea:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .notes-editor-foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border-hairline);
  }
  /* Button styles were scoped to the host components before extraction.
   * The shared modal needs its own definitions so the buttons render
   * correctly regardless of which parent mounts it. */
  .notes-editor-foot .btn {
    display: inline-flex;
    align-items: center;
    min-height: var(--hit);
    padding: 0 var(--s-3);
    border-radius: var(--r-sm);
    font-size: var(--t-13);
    font-weight: var(--w-md);
    font-family: var(--f-sans);
    cursor: pointer;
    border: 1px solid transparent;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .notes-editor-foot .btn.ghost {
    background: var(--surface-2);
    border-color: var(--border);
    color: var(--text);
  }
  .notes-editor-foot .btn.ghost:hover {
    background: var(--surface-3);
    border-color: var(--border-2);
  }
  .notes-editor-foot .btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-text);
    font-weight: var(--w-sb);
  }
  .notes-editor-foot .btn.primary:hover:not(:disabled) {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .notes-editor-foot .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
