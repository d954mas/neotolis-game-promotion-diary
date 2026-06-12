// Instagram-tree-local provider re-export (SOC-03).
//
// Owns the Instagram config probe (isInstagramConfigured) + the provider impl
// (instagramProvider) so the IG adapter folder reads its OWN accessor from
// inside its own tree. The CANONICAL cross-platform `getSocialProvider` switch
// lives in the NEUTRAL module (src/lib/sources/social-provider-registry.ts —
// one switch, all platforms; do NOT fork it); that module imports the two
// bindings above FROM here (neutral → tree, one-directional, no cycle). This
// file re-exports getSocialProvider from there as a thin shim so the IG tree's
// import sites + the per-tree vi.mock targets keep working unchanged.

import { env } from "$lib/server/config/env.js";
import { scrapeCreatorsProvider } from "./scrapecreators.js";
import type { SocialProvider } from "$lib/sources/social-provider.js";

/** Whether the operator has a usable Instagram provider configured: the
 *  provider is selected AND its credential is non-empty. */
export function isInstagramConfigured(): boolean {
  return env.INSTAGRAM_PROVIDER === "scrapecreators" && env.SCRAPECREATORS_API_KEY !== "";
}

/** The Instagram provider impl (the SOC-02 issuer). */
export const instagramProvider: SocialProvider = scrapeCreatorsProvider;

// Re-export the CANONICAL cross-platform switch from the neutral registry (the
// single switch, all platforms — do NOT fork it). The IG tree's handlers /
// adapter import `getSocialProvider` from HERE so they read their provider
// accessor from inside their own folder; the routing logic lives in one
// neutral place. Integration tests vi.mock THIS module to inject a fake
// provider at the seam: vi.mock replaces this module's node in the graph, and
// the mocks spread importOriginal() (so the real isInstagramConfigured /
// instagramProvider survive) then override getSocialProvider — which is why a
// mock of the IG registry never leaks into the TikTok tree's own copy.
export { getSocialProvider } from "$lib/sources/social-provider-registry.js";
