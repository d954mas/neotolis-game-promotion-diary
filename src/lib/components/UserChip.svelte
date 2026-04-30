<script lang="ts">
  // UserChip — avatar + email + sign-out menu for AppHeader (Plan 02.1-09).
  //
  // UI-SPEC §"Layout & Responsive Contract — `<AppHeader>`":
  //   - 28px circular avatar (Google profile picture from user.image)
  //   - email label hidden below 480px viewport (hard-coded media query —
  //     UI-SPEC FLAG accepts hard-coding here; the token would be premature)
  //   - <button> trigger with aria-label `Account menu — {email}`
  //   - menu items: read-only email + Sign out + Sign out from all devices
  //   - Esc closes the menu; click outside closes the menu
  //
  // UI-SPEC §"Registry Safety": Google profile picture rendered with
  //   referrerpolicy="no-referrer" + crossorigin="anonymous" + alt="" so a
  //   network failure renders the fallback (initial-letter placeholder
  //   generated client-side) without leaking referrer.

  import { m } from "$lib/paraglide/messages.js";

  type UserShape = { name: string; email: string; image: string | null };

  let {
    user,
    onSignOut,
    onSignOutAllDevices,
  }: {
    user: UserShape;
    onSignOut?: () => void;
    onSignOutAllDevices?: () => void;
  } = $props();

  let menuOpen = $state(false);
  let imageBroke = $state(false);
  let panelEl: HTMLDivElement | null = $state(null);

  const initial = $derived((user.email[0] ?? user.name[0] ?? "?").toUpperCase());

  function toggle(): void {
    menuOpen = !menuOpen;
  }

  function close(): void {
    menuOpen = false;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && menuOpen) {
      e.preventDefault();
      close();
    }
  }

  function onWindowClick(e: MouseEvent): void {
    if (!menuOpen || !panelEl) return;
    const target = e.target as Node;
    if (!panelEl.contains(target)) close();
  }

  $effect(() => {
    if (typeof document === "undefined") return;
    document.addEventListener("keydown", onKeydown);
    document.addEventListener("click", onWindowClick);
    return () => {
      document.removeEventListener("keydown", onKeydown);
      document.removeEventListener("click", onWindowClick);
    };
  });
</script>

<div bind:this={panelEl} class="user-chip-wrap">
  <button
    type="button"
    class="user-chip"
    aria-label={m.appheader_account_menu_aria({ email: user.email })}
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    onclick={toggle}
  >
    {#if user.image && !imageBroke}
      <img
        class="avatar"
        src={user.image}
        alt=""
        referrerpolicy="no-referrer"
        crossorigin="anonymous"
        onerror={() => (imageBroke = true)}
      />
    {:else}
      <span class="avatar avatar-fallback" aria-hidden="true">{initial}</span>
    {/if}
    <span class="email">{user.email}</span>
  </button>
  {#if menuOpen}
    <div class="menu" role="menu">
      <span class="menu-email">{user.email}</span>
      <button
        type="button"
        class="menu-item"
        role="menuitem"
        onclick={() => {
          close();
          onSignOut?.();
        }}
      >
        {m.sign_out()}
      </button>
      <button
        type="button"
        class="menu-item menu-item-danger"
        role="menuitem"
        onclick={() => {
          close();
          onSignOutAllDevices?.();
        }}
      >
        {m.sign_out_all_devices()}
      </button>
    </div>
  {/if}
</div>

<style>
  .user-chip-wrap {
    position: relative;
  }
  .user-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-sm);
    min-height: 44px;
    padding: 4px var(--space-sm);
    background: transparent;
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    cursor: pointer;
  }
  .user-chip:hover,
  .user-chip:focus-visible {
    background: var(--color-surface);
  }
  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    object-fit: cover;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    flex-shrink: 0;
  }
  .avatar-fallback {
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text);
  }
  .email {
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text);
    max-width: 18ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* UI-SPEC FLAG: 480px hard-coded breakpoint (the token set has none). */
  @media (max-width: 479px) {
    .email {
      display: none;
    }
  }
  .menu {
    position: absolute;
    top: calc(100% + var(--space-xs));
    right: 0;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    box-shadow: 0 4px 12px rgb(0 0 0 / 12%);
    min-width: 240px;
    z-index: 10;
    display: flex;
    flex-direction: column;
    padding: var(--space-xs) 0;
  }
  .menu-email {
    padding: var(--space-sm) var(--space-md);
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    border-bottom: 1px solid var(--color-border);
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
    min-height: 44px;
  }
  .menu-item:hover,
  .menu-item:focus-visible {
    background: var(--color-bg);
  }
  .menu-item-danger {
    color: var(--color-destructive);
  }
</style>
