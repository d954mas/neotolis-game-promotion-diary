<script lang="ts">
  // AppHeader — top bar present on every authenticated page.
  // App title + ThemeToggle + sign-out menu. Mobile-friendly (44px touch targets).
  //
  // The user prop carries the DTO-projected user (from event.locals.user
  // populated by hooks.server.ts authHandle). When null, we render a minimal
  // header with just the title + theme toggle (the page itself shows the
  // sign-in CTA).

  import { m } from "$lib/paraglide/messages.js";
  import ThemeToggle from "./ThemeToggle.svelte";

  type UserShape = { name: string; email: string } | null;
  type Theme = "light" | "dark" | "system";

  let {
    user,
    theme,
    onSignOut,
    onSignOutAllDevices,
  }: {
    user: UserShape;
    theme: Theme;
    onSignOut?: () => void;
    onSignOutAllDevices?: () => void;
  } = $props();

  let menuOpen = $state(false);

  function toggleMenu(): void {
    menuOpen = !menuOpen;
  }

  function closeMenu(): void {
    menuOpen = false;
  }
</script>

<header class="header">
  <a href="/" class="brand">{m.app_title()}</a>
  <div class="actions">
    <ThemeToggle current={theme} />
    {#if user}
      <div class="user">
        <button
          type="button"
          class="user-trigger"
          onclick={toggleMenu}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          {user.name}
        </button>
        {#if menuOpen}
          <div class="menu" role="menu">
            <button
              type="button"
              class="menu-item"
              role="menuitem"
              onclick={() => {
                closeMenu();
                onSignOut?.();
              }}
            >
              {m.sign_out()}
            </button>
            <button
              type="button"
              class="menu-item"
              role="menuitem"
              onclick={() => {
                closeMenu();
                onSignOutAllDevices?.();
              }}
            >
              {m.sign_out_all_devices()}
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</header>

<style>
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
    padding: var(--space-md);
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    min-width: 0;
  }
  .brand {
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text);
    text-decoration: none;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
  }
  .user {
    position: relative;
  }
  .user-trigger {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: transparent;
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
    cursor: pointer;
  }
  .menu {
    position: absolute;
    top: calc(100% + var(--space-xs));
    right: 0;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    box-shadow: 0 4px 12px rgb(0 0 0 / 12%);
    min-width: 200px;
    z-index: 10;
  }
  .menu-item {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    color: var(--color-text);
    border: none;
    padding: var(--space-sm) var(--space-md);
    font-size: var(--font-size-body);
    cursor: pointer;
  }
  .menu-item:hover {
    background: var(--color-bg);
  }
</style>
