/**
 * Module augmentation: register the custom Playwright-backed commands the
 * vitest.config.ts `browser.commands` block exposes. Vitest 4 surfaces these
 * via `commands.<name>(...args)` from `@vitest/browser/context`. The
 * `BrowserCommands` interface is declared in `vitest/internal/browser` (the
 * subpath the @vitest/browser package re-imports from); augmenting the
 * `@vitest/browser/context` surface alone is not enough — TypeScript needs
 * the augmentation on the original definition site.
 */

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    goto(url: string): Promise<void>;
    measureScrollWidth(): Promise<number>;
    measureClientWidth(): Promise<number>;
    currentUrl(): Promise<string>;
    // Plan 02.1-34 (UAT-NOTES.md §4.22.A regression guard): expose
    // getComputedStyle(document.body).overflowX so a public-routed test can
    // assert body's overflow-x is `clip` (not `hidden`) — the load-bearing
    // distinction that keeps `position: sticky` working on AppHeader.
    measureBodyOverflowX(): Promise<string>;
  }
}

export {};
