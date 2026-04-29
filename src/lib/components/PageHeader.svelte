<script lang="ts">
  // PageHeader — shared title + CTA row for /feed, /games, /sources.
  //
  // Plan 02.1-25 (UAT-NOTES.md §3.1-polish): user wanted the primary CTA
  // sitting NEXT TO the page title, not pushed to the right edge. Quote:
  // "Хочется кнопку после заголовка". Layout is `display: flex; gap;
  // align-items: center;` — both elements wrap together on narrow viewports.
  //
  // Rule of three earns the abstraction: 3 list pages share this pattern;
  // a single component eliminates 3 inline header blocks. Premature for
  // 1 or 2 consumers, justified at 3 (Philosophy: no premature abstraction).
  //
  // CTA prop variants:
  //   - { href, label }      — link (navigation-style; e.g. /sources/new)
  //   - { onClick, label }   — button (toggle-style; e.g. /games inline form)
  // The optional onClick supports /games' inline-form-toggle case while
  // href supports the standard navigation case.
  //
  // The sticky positioning behavior previously inlined in /sources is
  // available via an opt-in `sticky` prop — set when the consumer needs the
  // header to stay anchored under <AppHeader> while a long list scrolls.
  // The default is non-sticky to match /feed and /games defaults.

  let {
    title,
    cta,
    sticky = false,
  }: {
    title: string;
    cta?: { href?: string; label: string; onClick?: () => void };
    sticky?: boolean;
  } = $props();
</script>

<header class="page-header" class:sticky>
  <h1>{title}</h1>
  {#if cta}
    {#if cta.onClick}
      <button type="button" class="cta" onclick={cta.onClick}>{cta.label}</button>
    {:else if cta.href}
      <a href={cta.href} class="cta">{cta.label}</a>
    {/if}
  {/if}
</header>

<style>
  .page-header {
    display: flex;
    gap: var(--space-md);
    align-items: center;
    flex-wrap: wrap;
  }
  /* Plan 02.1-25 (sticky variant — preserves Plan 02.1-22 §2.2-bug closure):
   * `top: 72px` anchors under the global AppHeader (sticky top:0); background
   * fill + padding prevent scrolled content from bleeding through. */
  .page-header.sticky {
    position: sticky;
    top: 72px;
    z-index: 5;
    padding: var(--space-sm) 0;
    background: var(--color-bg);
  }
  h1 {
    margin: 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
  }
  .cta {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-accent);
    color: var(--color-accent-text, #fff);
    border: none;
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
  }
  .cta:hover {
    filter: brightness(1.05);
  }
</style>
