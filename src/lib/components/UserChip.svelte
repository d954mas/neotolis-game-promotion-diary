<script lang="ts">
  // UserChip — avatar + email + sign-out menu for AppHeader.
  //
  // v2 shape:
  //   - 24px circular avatar; Google profile picture when user.image is
  //     set (renders with referrerpolicy="no-referrer" +
  //     crossorigin="anonymous" so a network failure flips to the
  //     initial-letter fallback without leaking referrer — LB-9).
  //     Fallback uses --accent-soft background + --accent text initial.
  //   - email at --text-2 (hidden below 560px viewport).
  //   - chevron in --text-3 to signal "menu".
  //   - <button> trigger with aria-label
  //     `Account menu — {email}` (Paraglide key preserved).
  //   - menu panel uses --surface-2 + --shadow-elev + --r-md; item
  //     hover gets --accent-soft + --accent text.
  //   - Esc closes the menu; click outside closes the menu (existing
  //     script logic preserved).

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
        class="avatar-img"
        src={user.image}
        alt=""
        referrerpolicy="no-referrer"
        crossorigin="anonymous"
        onerror={() => (imageBroke = true)}
      />
    {:else}
      <span class="avatar-initial" aria-hidden="true">{initial}</span>
    {/if}
    <span class="email">{user.email}</span>
    <svg
      class="chevron"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
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
    gap: var(--s-2);
    padding: var(--s-1) var(--s-2) var(--s-1) var(--s-1);
    min-height: var(--hit);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    color: var(--text);
    cursor: pointer;
    font-family: var(--f-sans);
    font-size: var(--t-13);
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .user-chip:hover,
  .user-chip:focus-visible {
    background: var(--accent-soft);
    border-color: var(--accent-strong);
  }
  .avatar-img,
  .avatar-initial {
    width: 24px;
    height: 24px;
    border-radius: var(--r-pill);
    background: var(--accent-soft);
    color: var(--accent);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: var(--w-sb);
    font-size: var(--t-12);
    object-fit: cover;
    flex-shrink: 0;
  }
  .email {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-2);
  }
  .chevron {
    color: var(--text-3);
    flex-shrink: 0;
  }
  /* 560px hard-coded breakpoint per UI-SPEC (no token covers this). */
  @media (max-width: 560px) {
    .email {
      display: none;
    }
  }
  .menu {
    position: absolute;
    top: calc(100% + var(--s-1));
    right: 0;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-elev);
    min-width: 240px;
    padding: var(--s-1);
    z-index: 20;
    display: flex;
    flex-direction: column;
    gap: var(--s-0);
  }
  .menu-email {
    padding: var(--s-2) var(--s-3);
    font-size: var(--t-12);
    color: var(--text-3);
    border-bottom: 1px solid var(--border-hairline);
    margin-bottom: var(--s-1);
  }
  .menu-item {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    color: var(--text);
    border: 0;
    padding: var(--s-2) var(--s-3);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    border-radius: var(--r-sm);
    cursor: pointer;
    min-height: var(--hit);
  }
  .menu-item:hover,
  .menu-item:focus-visible {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .menu-item-danger {
    color: var(--danger);
  }
  .menu-item-danger:hover,
  .menu-item-danger:focus-visible {
    background: var(--accent-soft);
    color: var(--danger);
  }
  @media (prefers-reduced-motion: reduce) {
    .user-chip {
      transition: none;
    }
  }
</style>
