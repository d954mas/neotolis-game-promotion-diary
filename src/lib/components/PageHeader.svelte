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
  //
  // Plan 02.1-39 round-6 polish #11 (UAT-NOTES.md §5.8 follow-up #11,
  // 2026-04-30): the anchor link broke on infinite-scroll surfaces by
  // construction — clicking jumps to the bottom of the list, the sentinel
  // fires, the loader appends another page, the bottom moves further down.
  // User during round-6 UAT (verbatim, ru):
  //   "Да но оно странно работает, оно меня кидает просто вниз страницы.
  //    А если у меня тут бесконечная лента, то новые эвенты подгрузит и
  //    меня снова кинет вниз? как будто нужно чтобы там оно раскрывалось
  //    или в отдельном окне"
  // The `recoveryAnchor: string` prop is REPLACED with `onOpenRecovery:
  // () => void`. The "Recently deleted (N)" affordance becomes a <button>
  // that fires a callback; the parent owns a <RecoveryDialog> modal
  // mounted alongside <PageHeader>. The dialog decouples the recovery UI
  // from scroll position — closing the dialog returns the user exactly
  // where they were, so infinite-scroll surfaces work by construction.
  //
  // Plan 02.1-39 round-6 polish follow-up #6 (2026-04-30) — Instagram /
  // Google Sheets sticky date-section pattern. After the AppHeader+Nav
  // chrome wrapper landed (#5), the user surfaced a NEW design item during
  // round-6 UAT (NOT a round-5 finding) — verbatim quote (ru):
  //   "Так и вот где feed и в других местах где будет фид и даты,
  //    хотелось чтобы дата была всегда виджимая наверху, пока я скролю
  //    эту дату. Так в гугл таблицах или инстаграмме сделоано"
  //   ("On /feed and other places that have a feed with dates, I'd like
  //    the date to always be pinned at the top while I scroll through
  //    entries from that date. Like Google Sheets or Instagram does.")
  //
  // <FeedDateGroupHeader> already had `position: sticky; top: 0;` declared
  // — but `top: 0` placed it under the .sticky-chrome (z:10) AND the now-
  // sticky PageHeader (z:5), so it was never visible. To stick at the
  // BOTTOM of the chrome+PageHeader stack the date header needs the real
  // PageHeader height available as a CSS variable.
  //
  // PageHeader now publishes its own measured height to the
  // --page-header-height custom property on `document.documentElement` via
  // a ResizeObserver on the rendered <header> element. FeedDateGroupHeader
  // reads `top: calc(--chrome-height + --page-header-height - --sticky-overlap)`
  // and lands exactly under the sticky chrome+PageHeader stack — the
  // Instagram / Google Sheets section-header pattern.
  //
  // We use raw fractional `getBoundingClientRect().height` (no Math.ceil)
  // — same lesson as round-6 #5 for the chrome wrapper. Modern browsers
  // (Chrome 90+, Firefox 81+, Safari 16+) handle subpixel sticky `top:`
  // correctly. The 1px `--sticky-overlap` shim absorbs DPR rounding at the
  // chrome+PageHeader → date-header boundary.
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
    gap: var(--space-md);
    align-items: center;
    flex-wrap: wrap;
  }
  /* Plan 02.1-25 (sticky variant — preserves Plan 02.1-22 §2.2-bug closure):
   * anchors under the global chrome (AppHeader + Nav); background fill +
   * padding prevent scrolled content from bleeding through.
   *
   * Plan 02.1-39 round-6 #5 (UAT-NOTES.md §5.4 follow-up #5): the chrome
   * (AppHeader + Nav) is now a SINGLE sticky wrapper in +layout.svelte
   * rather than two independent sticky elements. PageHeader's sticky top
   * therefore reads ONE runtime-measured CSS var — `--chrome-height` —
   * instead of summing `--app-header-height + --nav-height`. The wrapper
   * height is written by a ResizeObserver in src/routes/+layout.svelte
   * (raw fractional `getBoundingClientRect().height`); the static fallback
   * 116px (= 72px AppHeader + 44px Nav) preserves zero visual regression
   * during SSR / pre-effect / no-JS.
   *
   * The sticky stack collapses from three tiers to two:
   *   1. .sticky-chrome (top: 0, z: 10)            — wraps AppHeader + Nav
   *   2. .page-header.sticky (top: --chrome-height, z: 5)
   *
   * `--sticky-overlap` is 1px (was 4px in round-6 #4 because we needed
   * larger slack to absorb subpixel-rounding error across TWO independent
   * boundaries simultaneously). With only one sticky boundary remaining
   * here (chrome ↔ PageHeader), 1px is sufficient — proved in round-6 #3
   * (435697e) for a single-tier defense. The overlap is invisible because
   * `.sticky-chrome` (z: 10) paints over `.page-header.sticky` (z: 5) in
   * the overlap zone. */
  .page-header.sticky {
    position: sticky;
    top: calc(var(--chrome-height, 116px) - var(--sticky-overlap, 1px));
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
  /* Plan 02.1-39 (UAT-NOTES.md §5.8 Path A): low-key text link surfacing
   * the soft-delete recovery flow. Visually subordinate to the primary
   * CTA (label + small + muted) so it does not compete for attention;
   * only appears when deletedCount > 0.
   *
   * Plan 02.1-39 round-6 polish #11 (UAT-NOTES.md §5.8 follow-up #11):
   * <a href> changed to <button onclick> — the button fires a callback
   * that opens <RecoveryDialog> in the parent surface. Same visual
   * treatment (text link styling) so the look does not regress; the
   * button-shaped element is reset to a borderless transparent surface
   * and given the same underline + muted color.
   */
  .recovery-link {
    background: transparent;
    border: none;
    padding: 0;
    font: inherit;
    cursor: pointer;
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    text-decoration: underline;
  }
  .recovery-link:hover {
    color: var(--color-text);
  }
</style>
