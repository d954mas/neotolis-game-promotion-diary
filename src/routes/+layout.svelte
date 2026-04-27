<script lang="ts">
  // Minimal Phase 1 shell — a single `<main>` with the page slot.
  // Phase 4 lands the real navigation chrome and dashboard layout.
  // Plan 01-09: page <title> sourced from Paraglide so it is i18n-ready (UX-04, D-17/D-18).
  import { m } from "$lib/paraglide/messages.js";
  let { children } = $props();
</script>

<svelte:head>
  <title>{m.app_title()}</title>
</svelte:head>

<main>
  {@render children()}
</main>
