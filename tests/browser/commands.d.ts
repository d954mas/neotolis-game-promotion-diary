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
  }
}

export {};
