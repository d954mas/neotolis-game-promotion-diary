<script lang="ts">
  // PageHeader — shared title + CTA row for /feed, /games, /sources.
  //
  // The primary CTA sits NEXT TO the page title, not pushed to the right
  // edge. User quote: "Хочется кнопку после заголовка". Layout is
  // `display: flex; gap; align-items: center;` — both elements wrap
  // together on narrow viewports.
  //
  // Three list pages share this pattern; a single component eliminates 3
  // inline header blocks (no premature abstraction).
  //
  // CTA prop variants:
  //   - { href, label }      — link (navigation-style; e.g. /sources/new)
  //   - { onClick, label }   — button (toggle-style; e.g. /games inline form)
  //
  // The sticky positioning is available via an opt-in `sticky` prop — set
  // when the consumer needs the header to stay anchored under <AppHeader>
  // while a long list scrolls. /feed, /games, /audit all set sticky for
  // UX consistency. Single CSS variable `--app-header-height` on :root
  // gives the offset one source of truth in src/app.css.
  //
  // Optional `deletedCount` + `onOpenRecovery` props render an inline
  // "Recently deleted (N)" button that opens a <RecoveryDialog> modal
  // mounted in the parent. The dialog decouples the recovery UI from
  // scroll position — closing the dialog returns the user exactly where
  // they were, so infinite-scroll surfaces work by construction.
  //
  // Instagram / Google Sheets sticky date-section pattern — user quote (ru):
  //   "хотелось чтобы дата была всегда виджимая наверху, пока я скролю
  //    эту дату. Так в гугл таблицах или инстаграмме сделоано"
  //
  // <FeedDateGroupHeader> sticks at the BOTTOM of the chrome+PageHeader
  // stack — the date header needs the real PageHeader height available as
  // a CSS variable.
  //
  // PageHeader publishes its own measured height to the
  // --page-header-height custom property on `document.documentElement` via
  // a ResizeObserver on the rendered <header> element. FeedDateGroupHeader
  // reads `top: calc(--chrome-height + --page-header-height - --sticky-overlap)`
  // and lands exactly under the sticky chrome+PageHeader stack — the
  // Instagram / Google Sheets section-header pattern.
  //
  // We use raw fractional `getBoundingClientRect().height` (no Math.ceil).
  // Modern browsers (Chrome 90+, Firefox 81+, Safari 16+) handle subpixel
  // sticky `top:` correctly. The 1px `--sticky-overlap` shim absorbs DPR
  // rounding at the chrome+PageHeader → date-header boundary.
  //
  // Cleanup on unmount: routes that DON'T render PageHeader (login, the
  // landing page) must not carry stale `--page-header-height`. Setting the
  // property to '0px' on cleanup means FeedDateGroupHeader on those routes
  // (none today, defensive for the future) computes its `top:` against a
  // PageHeader that isn't there.

  import { m } from "$lib/paraglide/messages.js";

  let {
    title,
    cta,
    sticky = false,
    deletedCount,
    onOpenRecovery,
  }: {
    title: string;
    cta?: { href?: string; label: string; onClick?: () => void };
    sticky?: boolean;
    deletedCount?: number;
    onOpenRecovery?: () => void;
  } = $props();

  let headerEl: HTMLElement | undefined = $state();

  $effect(() => {
    if (typeof window === "undefined") return;
    if (!headerEl) return;
    const root = document.documentElement;
    const sync = (): void => {
      root.style.setProperty(
        "--page-header-height",
        `${headerEl!.getBoundingClientRect().height}px`,
      );
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(headerEl);
    return () => {
      ro.disconnect();
      root.style.setProperty("--page-header-height", "0px");
    };
  });
</script>

<header class="page-header" class:sticky bind:this={headerEl}>
  <h1>{title}</h1>
  {#if cta}
    {#if cta.onClick}
      <button type="button" class="cta" onclick={cta.onClick}>{cta.label}</button>
    {:else if cta.href}
      <a href={cta.href} class="cta">{cta.label}</a>
    {/if}
  {/if}
  {#if deletedCount && deletedCount > 0 && onOpenRecovery}
    <button type="button" class="recovery-link" onclick={onOpenRecovery}>
      {m.page_header_recently_deleted({ count: deletedCount })}
    </button>
  {/if}
</header>

<style>
  .page-header {
    display: flex;
    gap: var(--s-3);
    align-items: center;
    flex-wrap: wrap;
    background: var(--bg);
    min-width: 0;
  }
  .page-header h1 {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    color: var(--text);
    line-height: var(--lh-tight);
    letter-spacing: -0.01em;
  }
  /* Sticky variant — anchors under the global chrome (AppHeader + Nav);
   * background fill + padding prevent scrolled content from bleeding
   * through.
   *
   * The chrome (AppHeader + Nav) is a SINGLE sticky wrapper in
   * +layout.svelte rather than two independent sticky elements.
   * PageHeader's sticky top reads ONE runtime-measured CSS var —
   * `--chrome-height` — instead of summing
   * `--app-header-height + --nav-height`. The wrapper height is written
   * by a ResizeObserver in src/routes/+layout.svelte (raw fractional
   * `getBoundingClientRect().height`); the static fallback 116px
   * (= 72px AppHeader + 44px Nav) preserves zero visual regression
   * during SSR / pre-effect / no-JS.
   *
   * Sticky stack (two tiers):
   *   1. .sticky-chrome (top: 0, z: 10)            — wraps AppHeader + Nav
   *   2. .page-header.sticky (top: --chrome-height, z: 5)
   *
   * `--sticky-overlap` is 1px — sufficient for the single sticky boundary
   * remaining here (chrome ↔ PageHeader). The overlap is invisible
   * because `.sticky-chrome` (z: 10) paints over `.page-header.sticky`
   * (z: 5) in the overlap zone. */
  .page-header.sticky {
    position: sticky;
    top: calc(var(--chrome-height, 116px) - var(--sticky-overlap, 1px));
    z-index: 5;
    padding: var(--s-2) 0;
    background: var(--bg);
  }
  /* CTA — ghost-styled to match prototype `.btn.add-event`
   * (docs/design/v2/ui-kit/index.html .btn.add-event lines 365-389 +
   * src/lib/components/feed/PageHead.svelte `.cta-primary`).
   * The shared chrome's primary additive CTA reads as "additive action"
   * with an accent-only leading glyph; the solid-accent fill was visually
   * heavier than the prototype intends. */
  .cta {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: var(--hit-lg);
    padding: 0 var(--s-4);
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    font-weight: var(--w-md);
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .cta:hover {
    background: var(--surface-3, var(--surface-2));
    border-color: var(--accent);
  }
  /* Accent the "+" / leading glyph when the label starts with it — matches
   * the prototype's pattern where the leading + carries the accent and the
   * remainder of the chip stays neutral. Label authors include the literal
   * "+ " prefix in the i18n message; we recolor it via ::first-letter
   * approximation isn't workable, so we instead lift the accent into the
   * first space-prefix character using a CSS gradient on the button text:
   * here we lift the whole label slightly via `text-shadow: 0 0 0 transparent;`
   * fallback — actual leading-+ accent is delivered by callers that use the
   * cta-plus glyph (see PageHead.svelte). For shared PageHeader we keep the
   * label uniform; the ghost style alone matches the prototype's weight. */
  /* Low-key text link surfacing the soft-delete recovery flow. Visually
   * subordinate to the primary CTA (label + small + muted) so it does
   * not compete for attention; only appears when deletedCount > 0.
   *
   * Rendered as <button onclick> — the button fires a callback that
   * opens <RecoveryDialog> in the parent surface. The button-shaped
   * element is reset to a borderless transparent surface with the same
   * underline + muted color as the original text link.
   */
  .recovery-link {
    background: transparent;
    border: none;
    padding: 0;
    font: inherit;
    cursor: pointer;
    font-size: var(--t-13);
    color: var(--text-3);
    text-decoration: underline;
  }
  .recovery-link:hover {
    color: var(--accent);
  }
  @media (prefers-reduced-motion: reduce) {
    .cta {
      transition: none;
    }
  }
  @media (max-width: 480px) {
    .page-header {
      flex-direction: column;
      align-items: stretch;
      gap: var(--s-2);
    }
    .cta {
      align-self: flex-start;
    }
  }
</style>
