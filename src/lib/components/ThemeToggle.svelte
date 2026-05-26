<script lang="ts">
  // ThemeToggle (v2 — D-05 segmented control redesign).
  //
  // Per D-05: three-button segmented control (light | dark | system) replaces
  // the previous single-button cyclic toggle. The script API now exposes
  // choose(target: Theme): the user names the destination instead of
  // stepping through an order.
  //
  // LB-12 preserved verbatim: optimistic
  // document.documentElement.dataset.theme update + POST /api/me/theme on
  // every choose() + revert on error. The cookie is written by the server
  // route (src/lib/server/http/routes/me-theme.ts); next SSR render reads
  // it via themeHandle (src/hooks.server.ts).
  //
  // Icons: sun (light), moon (dark), monitor (system). Inline SVG, 16px,
  // stroke-width 1.75 per the v2 iconography contract.
  //
  // Paraglide keys preserved: m.theme_label_light / dark / system,
  // m.theme_toggle_aria_label, m.error_server_generic, m.error_network.

  import { m } from "$lib/paraglide/messages.js";

  type Theme = "light" | "dark" | "system";

  let { current }: { current: Theme } = $props();

  // Local state seeds from the SSR-resolved `current` prop and then evolves
  // independently — optimistic toggles + revert-on-error work without
  // waiting for a parent re-render.
  // svelte-ignore state_referenced_locally
  let active = $state<Theme>(current);
  let pending = $state(false);
  let errorText = $state<string | null>(null);

  async function choose(target: Theme): Promise<void> {
    if (pending) return;
    if (target === active) return;
    const previous = active;
    active = target;
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = target;
    }
    pending = true;
    errorText = null;
    try {
      const res = await fetch("/api/me/theme", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme: target }),
      });
      if (!res.ok) {
        active = previous;
        if (typeof document !== "undefined") {
          document.documentElement.dataset.theme = previous;
        }
        errorText = m.error_server_generic();
      }
    } catch {
      active = previous;
      if (typeof document !== "undefined") {
        document.documentElement.dataset.theme = previous;
      }
      errorText = m.error_network();
    } finally {
      pending = false;
    }
  }

  function labelFor(t: Theme): string {
    if (t === "light") return m.theme_label_light();
    if (t === "dark") return m.theme_label_dark();
    return m.theme_label_system();
  }
</script>

<div class="segmented" role="radiogroup" aria-label={m.theme_toggle_aria_label()}>
  {#each ["light", "dark", "system"] as const as opt (opt)}
    <button
      type="button"
      role="radio"
      aria-checked={active === opt}
      class="seg"
      class:active={active === opt}
      onclick={() => choose(opt)}
      disabled={pending}
      title={labelFor(opt)}
    >
      {#if opt === "light"}
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path
            d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
          />
        </svg>
      {:else if opt === "dark"}
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" />
        </svg>
      {:else}
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      {/if}
    </button>
  {/each}
</div>
{#if errorText}
  <span class="error" role="alert">{errorText}</span>
{/if}

<style>
  /* v2 segmented control — three role="radio" buttons inside a
   * role="radiogroup" container. --surface-2 container with --hit-sized
   * buttons. Active state washes with --accent-soft + --accent text +
   * --accent-strong border. */
  .segmented {
    display: inline-flex;
    gap: var(--s-1);
    padding: var(--s-1);
    background: var(--surface-2);
    border: 1px solid var(--border-hairline);
    border-radius: var(--r-sm);
  }
  .seg {
    min-width: var(--hit);
    min-height: var(--hit);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--r-sm);
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .seg:hover:not(.active):not(:disabled) {
    background: var(--accent-soft);
    color: var(--text);
  }
  .seg.active {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent-strong);
  }
  .seg:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .error {
    display: block;
    margin-top: var(--s-2);
    color: var(--danger);
    font-family: var(--f-sans);
    font-size: var(--t-13);
  }
  @media (prefers-reduced-motion: reduce) {
    .seg {
      transition: none;
    }
  }
</style>
