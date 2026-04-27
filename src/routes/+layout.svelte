<script lang="ts">
  // Minimal Phase 1 shell — a single `<main>` with the page slot.
  // Phase 4 lands the real navigation chrome and dashboard layout.
  let { children } = $props();
</script>

<main>
  {@render children()}
</main>
