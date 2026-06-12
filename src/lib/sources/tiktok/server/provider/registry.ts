// TikTok-tree-local provider re-export (SOC-03).
//
// Owns the TikTok config probe (isTikTokConfigured) + the provider impl
// (tiktokProvider) so the TikTok adapter folder reads its OWN accessor from
// inside its own tree. The CANONICAL cross-platform `getSocialProvider` switch
// lives in the NEUTRAL module (src/lib/sources/social-provider-registry.ts —
// one switch, all platforms; do NOT fork it); that module imports the two
// bindings above FROM here (neutral → tree, one-directional, no cycle). This
// file re-exports getSocialProvider from there as a thin shim so the TikTok
// tree's import sites + the per-tree vi.mock targets keep working unchanged.

import { env } from "$lib/server/config/env.js";
import { scrapeCreatorsTikTokProvider } from "./scrapecreators-tiktok.js";
import type { SocialProvider } from "$lib/sources/social-provider.js";

/** Whether the operator has a usable TikTok provider configured: the provider
 *  is selected AND the shared ScrapeCreators credential is non-empty (SOC-05).
 *  Empty TIKTOK_PROVIDER (the safe default) ⇒ false ⇒ graceful degrade. */
export function isTikTokConfigured(): boolean {
  return env.TIKTOK_PROVIDER === "scrapecreators" && env.SCRAPECREATORS_API_KEY !== "";
}

/** The TikTok provider impl (the SOC-02 issuer). */
export const tiktokProvider: SocialProvider = scrapeCreatorsTikTokProvider;

// Re-export the CANONICAL cross-platform switch from the neutral registry (the
// single switch, all platforms — do NOT fork it). The TikTok tree's handlers /
// adapter import `getSocialProvider` from HERE so they read their provider
// accessor from inside their own folder; the routing logic lives in one
// neutral place. Integration tests vi.mock THIS module to inject a fake tiktok
// provider at the seam: vi.mock replaces this module's node in the graph, and
// the mocks spread importOriginal() (so the real isTikTokConfigured /
// tiktokProvider survive) then override getSocialProvider — which is why a mock
// of the TikTok registry never leaks into the instagram tree's own copy.
export { getSocialProvider } from "$lib/sources/social-provider-registry.js";
