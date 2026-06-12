// Twitter/X-tree-local provider re-export (SOC-03).
//
// Owns the Twitter config probe (isTwitterConfigured) + the provider impl
// (twitterProvider) so the Twitter adapter folder reads its OWN accessor from inside
// its own tree. The CANONICAL cross-platform `getSocialProvider` switch lives in the
// NEUTRAL module (src/lib/sources/social-provider-registry.ts — one switch, all
// platforms; do NOT fork it); that module imports the two bindings above FROM here
// (neutral → tree, one-directional, no cycle). This file re-exports getSocialProvider
// from there as a thin shim so the Twitter tree's import sites + the per-tree vi.mock
// targets keep working unchanged.

import { env } from "$lib/server/config/env.js";
import { twitterapiioTwitterProvider } from "./twitterapiio-twitter.js";
import type { SocialProvider } from "$lib/sources/social-provider.js";

/** Whether the operator has a usable Twitter/X provider configured: the provider is
 *  selected (twitterapi.io — the SECOND vendor, D-01) AND its OWN credential is
 *  non-empty (SOC-05). Empty TWITTER_PROVIDER (the safe default) ⇒ false ⇒ graceful
 *  degrade. NOTE the vendor-specific key: TWITTERAPIIO_API_KEY, NOT the shared
 *  ScrapeCreators key (twitterapi.io is a different vendor with its own prepaid balance). */
export function isTwitterConfigured(): boolean {
  return env.TWITTER_PROVIDER === "twitterapi.io" && env.TWITTERAPIIO_API_KEY !== "";
}

/** The Twitter/X provider impl (the SOC-02 issuer). */
export const twitterProvider: SocialProvider = twitterapiioTwitterProvider;

// Re-export the CANONICAL cross-platform switch from the neutral registry (the single
// switch, all platforms — do NOT fork it). The Twitter tree's handlers / adapter import
// `getSocialProvider` from HERE so they read their provider accessor from inside their
// own folder; the routing logic lives in one neutral place. Integration tests vi.mock
// THIS module to inject a fake twitter provider at the seam.
export { getSocialProvider } from "$lib/sources/social-provider-registry.js";
