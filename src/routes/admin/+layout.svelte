<script lang="ts">
  // Admin shell. Wraps every /admin/* page. Renders a thin breadcrumb-style
  // banner ABOVE the page content indicating admin mode. The global chrome
  // (<AppHeader> + <Nav>) is owned by the root +layout.svelte; this layout
  // only adds the admin breadcrumb.
  //
  // UI contract:
  //   - 3px accent left-border on the breadcrumb (single accent stripe so
  //     admin mode is unambiguous without filling a banner).
  //   - NOT sticky (informational; sticking competes with the existing
  //     chrome+PageHeader stack and adds no value at /admin/quota's typical
  //     scroll depth).
  //   - aria-label="Admin mode" so screen readers announce its purpose.
  //   - Inline shield-check SVG (accent stroke) per the icon-style contract
  //     inherited from <KindIcon> / <SourceKindIcon> — 24px viewBox,
  //     stroke="currentColor", stroke-width="2", linecap+linejoin="round",
  //     fill="none".

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
  /* 3px accent left-border on the admin-mode breadcrumb. The accent stripe
   * carries the entire visual weight of "admin mode" — no fill, no tint on
   * AppHeader / Nav / <main>.
   */
  .admin-breadcrumb {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-2) var(--s-4);
    border-left: 3px solid var(--accent);
    background: transparent;
    color: var(--text-2);
    font-size: var(--t-13);
    line-height: var(--lh-body);
  }
  .admin-breadcrumb__icon {
    color: var(--accent);
    flex-shrink: 0;
  }
  /* < 600px: text wraps; the 3px accent left-border + small icon stay
   * anchored at the top-left of the wrapped block. */
  @media (max-width: 600px) {
    .admin-breadcrumb {
      padding: var(--s-2);
    }
  }
</style>
