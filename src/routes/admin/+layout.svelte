<script lang="ts">
  // Phase 3.0 Plan 13 — admin shell.
  //
  // Wraps every /admin/* page (today only /admin/quota; Phase 6+ may add
  // more). Renders a thin breadcrumb-style banner ABOVE the page content
  // indicating admin mode. The global chrome (<AppHeader> + <Nav>) is owned
  // by the root +layout.svelte; this layout only adds the admin breadcrumb.
  //
  // UI-SPEC contract (.planning/phases/03.0-polling-pipeline-plumbing-youtube/03.0-UI-SPEC.md):
  //   - 3px accent left-border on the breadcrumb (single accent stripe so
  //     admin mode is unambiguous without filling a banner).
  //   - NOT sticky (informational; sticking it competes with the existing
  //     chrome+PageHeader stack and adds no value at /admin/quota's typical
  //     scroll depth).
  //   - aria-label="Admin mode" so screen readers announce its purpose.
  //   - Inline shield-check SVG (accent stroke) per the icon-style contract
  //     inherited from <KindIcon> / <SourceKindIcon> — 24px viewBox,
  //     stroke="currentColor", stroke-width="2", linecap+linejoin="round",
  //     fill="none".
  //
  // The breadcrumb body and aria-label come from messages/en.json
  // (admin_layout_breadcrumb / admin_layout_breadcrumb_aria, shipped in
  // Plan 03.0-02).

  import { m } from "$lib/paraglide/messages.js";
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<nav class="admin-breadcrumb" aria-label={m.admin_layout_breadcrumb_aria()}>
  <svg
    class="admin-breadcrumb__icon"
    viewBox="0 0 24 24"
    width="16"
    height="16"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    fill="none"
    aria-hidden="true"
  >
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
  <span>{m.admin_layout_breadcrumb()}</span>
</nav>

{@render children()}

<style>
  /* UI-SPEC §"Color → Accent (10%) — new surfaces":
   * 3px accent left-border on the admin-mode breadcrumb. The accent stripe
   * carries the entire visual weight of "admin mode" — no fill, no tint on
   * AppHeader / Nav / <main>. Phase 6 may revisit if /admin/* grows.
   */
  .admin-breadcrumb {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-sm) var(--space-md);
    border-left: 3px solid var(--color-accent);
    background: transparent;
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    line-height: var(--line-height-mono);
  }
  .admin-breadcrumb__icon {
    color: var(--color-accent);
    flex-shrink: 0;
  }
  /* UI-SPEC §"Layout & Responsive Contract → AdminLayout breadcrumb at < 600px":
   * text wraps; the 3px accent left-border + small icon stay anchored at
   * the top-left of the wrapped block. */
  @media (max-width: 600px) {
    .admin-breadcrumb {
      padding: var(--space-sm);
    }
  }
</style>
