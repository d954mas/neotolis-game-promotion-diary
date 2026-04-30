<script lang="ts">
  // ThemeToggle — three-way light/dark/system switch (UX-01, D-40).
  //
  // Click cycles light → dark → system → light. Optimistically updates
  // document.documentElement.dataset.theme for an instant swap (no FOUC),
  // then POSTs /api/me/theme. On error, reverts.
  //
  // The cookie is written by the server (route handler at
  // src/lib/server/http/routes/me-theme.ts) so we don't touch document.cookie
  // here. The next SSR render reads the cookie via themeHandle in
  // src/hooks.server.ts, so the data-theme attribute survives navigation.
  //
  // Icons: sun (light), moon (dark), monitor (system). Inline SVG, 20px.
  // Touch target 44px floor (WCAG 2.5.5 AA).

  import { m } from "$lib/paraglide/messages.js";

  type Theme = "light" | "dark" | "system";

  let { current }: { current: Theme } = $props();

  // Local state seeds from the SSR-resolved `current` prop and then evolves
  // independently — we want optimistic toggles + revert-on-error to work
  // without waiting for a parent re-render. The Svelte warning about
  // capturing the initial value is the desired behavior here.
  // svelte-ignore state_referenced_locally
  let active = $state<Theme>(current);
  let pending = $state(false);
  let errorText = $state<string | null>(null);

  const order: readonly Theme[] = ["light", "dark", "system"];

  function next(t: Theme): Theme {
    const i = order.indexOf(t);
    return order[(i + 1) % order.length] as Theme;
  }

  async function cycle(): Promise<void> {
    if (pending) return;
    const previous = active;
    const target = next(active);
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

  const label = $derived(
    active === "light"
      ? m.theme_label_light()
      : active === "dark"
        ? m.theme_label_dark()
        : m.theme_label_system(),
  );
</script>

<button
  type="button"
  class="toggle"
  onclick={cycle}
  aria-label={m.theme_toggle_aria_label()}
  title={label}
  disabled={pending}
>
  {#if active === "light"}
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path
        d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
      />
    </svg>
  {:else if active === "dark"}
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
    </svg>
  {:else}
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
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
{#if errorText}
  <span class="error" role="alert">{errorText}</span>
{/if}

<style>
  .toggle {
    min-width: 44px;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-sm);
    background: transparent;
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
  }
  .toggle:hover:not(:disabled) {
    background: var(--color-surface);
  }
  .toggle:disabled {
    opacity: 0.5;
    cursor: progress;
  }
  .error {
    font-size: var(--font-size-label);
    color: var(--color-destructive);
    margin-left: var(--space-sm);
  }
</style>
