<script lang="ts">
  // ReplaceKeyForm — paste-form for adding or replacing a Steam Web API key.
  // Reused for both flows (D-14): mode='add' POSTs /api/api-keys/steam,
  // mode='replace' PATCHes /api/api-keys/steam/:id.
  //
  // The submit is gated by a non-empty value (Steam keys are 32 hex chars,
  // but we don't validate length here — the server's D-17 test-call against
  // IWishlistService is the source of truth; surface its error via
  // InlineError if it rejects).

  import { m } from "$lib/paraglide/messages.js";
  import InlineError from "./InlineError.svelte";

  let {
    mode,
    keyId,
    initialLabel = "",
    onSubmit,
    onCancel,
  }: {
    mode: "add" | "replace";
    keyId?: string;
    initialLabel?: string;
    onSubmit: (result: unknown) => void;
    onCancel: () => void;
  } = $props();

  // Initial-from-prop is intentional: the form is a controlled local edit
  // surface; `initialLabel` only seeds the input value once.
  // svelte-ignore state_referenced_locally
  let label = $state(initialLabel);
  let value = $state("");
  let pending = $state(false);
  let errorMessage = $state<string | null>(null);

  function mapServerErrorCode(code: string): string {
    switch (code) {
      case "validation_failed":
        return m.keys_steam_error_invalid();
      case "steam_key_label_exists":
        return m.keys_steam_error_label_exists();
      case "steam_api_unavailable":
        return m.error_server_generic();
      default:
        return m.error_server_generic();
    }
  }

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (pending) return;
    errorMessage = null;
    pending = true;
    try {
      const url = mode === "add" ? "/api/api-keys/steam" : `/api/api-keys/steam/${keyId}`;
      const method = mode === "add" ? "POST" : "PATCH";
      const body =
        mode === "add" ? { label: label.trim(), value: value.trim() } : { value: value.trim() };
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let code = "error_server_generic";
        try {
          const b = (await res.json()) as { error?: string };
          if (b.error) code = b.error;
        } catch {
          /* ignore */
        }
        errorMessage = mapServerErrorCode(code);
        return;
      }
      const result = await res.json();
      value = "";
      onSubmit(result);
    } catch {
      errorMessage = m.error_network();
    } finally {
      pending = false;
    }
  }
</script>

<form class="form" onsubmit={submit}>
  {#if mode === "add"}
    <label class="field">
      <span class="label">Label *</span>
      <input class="input" type="text" bind:value={label} required autocomplete="off" />
    </label>
  {/if}
  <label class="field">
    <span class="label">Steam Web API key *</span>
    <input
      class="input mono"
      type="password"
      bind:value
      required
      autocomplete="off"
      spellcheck="false"
    />
  </label>
  <div class="actions">
    <button type="button" class="cancel" onclick={onCancel}>{m.common_cancel()}</button>
    <button
      type="submit"
      class="submit"
      disabled={pending ||
        value.trim().length === 0 ||
        (mode === "add" && label.trim().length === 0)}
    >
      {mode === "add" ? m.keys_steam_cta_save() : m.keys_steam_cta_replace()}
    </button>
  </div>
</form>
{#if errorMessage}
  <div class="msg"><InlineError message={errorMessage} /></div>
{/if}

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    padding: var(--space-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }
  .label {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .input {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
  }
  .mono {
    font-family: var(--font-family-mono);
  }
  .actions {
    display: flex;
    gap: var(--space-sm);
    justify-content: flex-end;
  }
  .cancel {
    background: transparent;
    color: var(--color-text-muted);
    border: none;
    text-decoration: underline;
    font-size: var(--font-size-body);
    cursor: pointer;
  }
  .submit {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-accent);
    color: var(--color-accent-text);
    border: none;
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .msg {
    margin-top: var(--space-sm);
  }
</style>
