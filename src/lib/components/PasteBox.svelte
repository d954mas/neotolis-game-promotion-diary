<script lang="ts">
  // PasteBox — single global URL input (D-18, UI-SPEC §"<PasteBox> interaction
  // contract"). The most-used widget on the game detail page.
  //
  // Validation order (D-19 INGEST-04):
  //   a. Client-side URL parse: not a URL → InlineError immediate, no POST.
  //   b. Host = reddit.com / redd.it → InlineInfo "Reddit support arrives in
  //      Phase 3", NO POST. (Distinct color from error — we didn't reject;
  //      we deferred.)
  //   c. Otherwise POST /api/items/youtube. On 4xx → InlineError with the
  //      server's error code (mapped through Paraglide). On 2xx → call
  //      onSuccess(result), clear the input.
  //
  // Min height 48px on the input (UI-SPEC §"Spacing" — primary action gets
  // extra forgiveness past the 44px touch target floor).

  import { m } from "$lib/paraglide/messages.js";
  import InlineError from "./InlineError.svelte";
  import InlineInfo from "./InlineInfo.svelte";

  let {
    gameId,
    onSuccess,
  }: {
    gameId: string;
    onSuccess: (result: unknown) => void;
  } = $props();

  let value = $state("");
  let pending = $state(false);
  let errorMessage = $state<string | null>(null);
  let infoMessage = $state<string | null>(null);

  function reset(): void {
    errorMessage = null;
    infoMessage = null;
  }

  function parseHost(raw: string): URL | null {
    try {
      return new URL(raw);
    } catch {
      return null;
    }
  }

  function isRedditHost(host: string): boolean {
    return host === "reddit.com" || host === "www.reddit.com" || host === "redd.it";
  }

  function mapServerErrorCode(code: string): string {
    switch (code) {
      case "youtube_unavailable":
        return m.ingest_error_youtube_unavailable();
      case "youtube_oembed_unreachable":
        return m.ingest_error_oembed_unreachable();
      case "duplicate_item":
        return m.ingest_error_youtube_duplicate();
      case "unsupported_url":
        return m.ingest_error_unsupported_host();
      case "validation_failed":
        return m.ingest_error_malformed_url();
      default:
        return m.error_server_generic();
    }
  }

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (pending) return;
    reset();

    const url = parseHost(value.trim());
    if (!url) {
      errorMessage = m.ingest_error_malformed_url();
      return;
    }
    if (isRedditHost(url.host)) {
      infoMessage = m.ingest_info_reddit_phase3();
      return;
    }

    pending = true;
    try {
      const res = await fetch("/api/items/youtube", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameId, urlInput: value.trim() }),
      });
      if (!res.ok) {
        let code = "error_server_generic";
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) code = body.error;
        } catch {
          /* ignore body parse */
        }
        errorMessage = mapServerErrorCode(code);
        return;
      }
      const result = await res.json();
      value = "";
      onSuccess(result);
    } catch {
      errorMessage = m.error_network();
    } finally {
      pending = false;
    }
  }
</script>

<form class="paste" onsubmit={submit}>
  <label for="paste-input" class="label">{m.paste_box_label()}</label>
  <div class="row">
    <input
      id="paste-input"
      class="input"
      type="text"
      bind:value
      placeholder={m.paste_box_placeholder()}
      autocomplete="off"
      spellcheck="false"
    />
    <button type="submit" class="submit" disabled={pending || value.trim().length === 0}>
      {m.ingest_cta_add()}
    </button>
  </div>
</form>
{#if errorMessage}
  <div class="msg-slot"><InlineError message={errorMessage} /></div>
{:else if infoMessage}
  <div class="msg-slot"><InlineInfo message={infoMessage} /></div>
{/if}

<style>
  .paste {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }
  .label {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
  .row {
    display: flex;
    gap: var(--space-sm);
    min-width: 0;
  }
  .input {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 48px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-family: var(--font-family-mono);
  }
  .submit {
    min-height: 48px;
    padding: 0 var(--space-lg);
    background: var(--color-accent);
    color: var(--color-accent-text);
    border: none;
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
    flex-shrink: 0;
  }
  .submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .msg-slot {
    margin-top: var(--space-sm);
  }
</style>
