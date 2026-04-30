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
  // Plan 02.1-39 (UAT-NOTES.md §5.7): /feed, /games, /audit set sticky too
  // for UX consistency — every list page's title row + CTA stays pinned
  // under AppHeader instead of scrolling away. Single CSS variable
  // `--app-header-height` on :root replaces the hardcoded `top: 72px` so
  // the offset has one source of truth in src/app.css.
  //
  // Plan 02.1-39 (UAT-NOTES.md §5.8 Path A): optional `deletedCount` +
  // `recoveryAnchor` props render an inline "Recently deleted (N)" link
  // anchoring to `#${recoveryAnchor}`. /feed passes both when its loader
  // returns deletedEvents.length > 0; the link surfaces the soft-delete
  // recovery panel without the user scrolling past the entire feed.

  import { m } from "$lib/paraglide/messages.js";

  let {
    title,
    cta,
    sticky = false,
    deletedCount,
    recoveryAnchor,
  }: {
    title: string;
    cta?: { href?: string; label: string; onClick?: () => void };
    sticky?: boolean;
    deletedCount?: number;
    recoveryAnchor?: string;
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
  {#if deletedCount && deletedCount > 0 && recoveryAnchor}
    <a class="recovery-link" href={`#${recoveryAnchor}`}>
      {m.page_header_recently_deleted({ count: deletedCount })}
    </a>
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
   * anchors under the global AppHeader (sticky top:0); background fill +
   * padding prevent scrolled content from bleeding through.
   * Plan 02.1-39 (UAT-NOTES.md §5.4 + §5.7): swap the hardcoded `top: 72px`
   * for `var(--app-header-height, 72px)` so this offset shares its source
   * of truth with FeedQuickNav's sticky calc(). The 72px fallback preserves
   * zero visual regression in browsers without custom-property support. */
  .page-header.sticky {
    position: sticky;
    top: var(--app-header-height, 72px);
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
  /* Plan 02.1-39 (UAT-NOTES.md §5.8 Path A): low-key text link anchoring to
   * the in-page DeletedEventsPanel. Visually subordinate to the primary CTA
   * (label + small + muted) so it does not compete for attention; only
   * appears when deletedCount > 0. */
  .recovery-link {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    text-decoration: underline;
  }
  .recovery-link:hover {
    color: var(--color-text);
  }
</style>
