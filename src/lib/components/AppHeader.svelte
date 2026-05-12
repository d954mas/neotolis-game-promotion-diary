<script lang="ts">
  // AppHeader — top bar present on every authenticated page.
  //
  //   1. <UserChip>: avatar (Google profile picture) + email + sign-out
  //      menu. The 28px circular avatar is the trigger.
  //   2. The theme toggle lives only on /settings — it was clutter on
  //      every page.
  //
  // The `theme` prop is no longer consumed here but stays in the props
  // bag (set by +layout.svelte for backward compatibility) — removing it
  // would force a layout-svelte change.

  import { m } from "$lib/paraglide/messages.js";
  import UserChip from "./UserChip.svelte";

  type UserShape = { name: string; email: string; image: string | null } | null;
  type Theme = "light" | "dark" | "system";

  let {
    user,
    theme: _theme,
    onSignOut,
    onSignOutAllDevices,
  }: {
    user: UserShape;
    theme?: Theme;
    onSignOut?: () => void;
    onSignOutAllDevices?: () => void;
  } = $props();
</script>

<header class="header">
  <a href="/feed" class="brand">{m.app_title()}</a>
  <div class="actions">
    {#if user}
      <UserChip {user} {onSignOut} {onSignOutAllDevices} />
    {/if}
  </div>
</header>

<style>
  .header {
    /* AppHeader is NON-STICKY here. AppHeader must stay visible while
       content scrolls — that contract is preserved by the
       `.sticky-chrome` wrapper in src/routes/+layout.svelte that
       contains both AppHeader and Nav. When AppHeader and Nav were
       each independently sticky (top: 0 and top: --app-header-height
       respectively), every overlap value either left a subpixel gap
       (too small) or made Nav visibly slip up on scroll-start (too
       large). User quote on the slip: "Зазора нет, но есть небольшой
       скрол табов feed sources что выглядит как артефакт". Wrapping
       both in a single sticky block removes the AppHeader↔Nav internal
       sticky boundary entirely — they move as one DOM unit, so neither
       gap nor slip is possible. */
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
</style>
