<script lang="ts">
  // AppHeader — top bar present on every authenticated page.
  //
  // Phase 2.1 Plan 02.1-09 changes (UI-SPEC §"`<AppHeader>` UI polish"):
  //   1. ADD <UserChip>: avatar (Google profile picture) + email + sign-out
  //      menu. The 28px circular avatar replaces the Phase 2 plain-text
  //      "name" trigger.
  //   2. REMOVE <ThemeToggle>: the toggle relocates to /settings only
  //      (UI-SPEC: Phase 2 UAT P1 surfaced it was clutter on every page).
  //
  // The `theme` prop is no longer consumed here but stays in the props
  // bag (set by +layout.svelte for backward compatibility) — removing it
  // would force a layout-svelte change. Phase 4 cleanup can drop it.

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
    /* Plan 02.1-39 round-6 #5 (UAT-NOTES.md §5.4 follow-up #5): AppHeader is
       NON-STICKY here. The Plan 02.1-22 closure required AppHeader to stay
       visible while content scrolled — that contract is preserved, but the
       sticky positioning has moved UP one level to the `.sticky-chrome`
       wrapper in src/routes/+layout.svelte that contains both AppHeader and
       Nav. Reason: when AppHeader and Nav were each independently sticky
       (top: 0 and top: --app-header-height respectively), every overlap
       value either left a subpixel gap (too small) or made Nav visibly slip
       up on scroll-start (too large). User quote on the slip after round-6
       #4 (419e3c7): "Зазора нет, но есть небольшой скрол табов feed sources
       что выглядит как артефакт". Wrapping both in a single sticky block
       removes the AppHeader↔Nav internal sticky boundary entirely — they
       move as one DOM unit, so neither gap nor slip is possible. */
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
