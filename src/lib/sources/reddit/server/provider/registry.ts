// Reddit-tree-local provider re-export (SOC-03) — home of the ★D-08 ISOLATION
// GATE, the heart of Phase 12.
//
// Owns the Reddit config probe (isRedditConfigured) + the provider impl
// (redditProvider) so the Reddit adapter folder reads its OWN accessor from
// inside its own tree. The CANONICAL cross-platform `getSocialProvider` switch
// lives in the NEUTRAL module (src/lib/sources/social-provider-registry.ts — one
// switch, all platforms; do NOT fork it); that module imports the two bindings
// below FROM here (neutral → tree, one-directional, no cycle). This file
// re-exports getSocialProvider from there as a thin shim so the Reddit tree's
// import sites + the per-tree vi.mock targets keep working unchanged.
//
// ★ THE D-08 KILL-SWITCH (success criterion #2 / T-12-03-E mitigation):
// isRedditConfigured() checks REDDIT_IMPORT_ENABLED FIRST, as an INDEPENDENT
// AND-term, BEFORE the provider-key check. Reddit REUSES the shared
// SCRAPECREATORS_API_KEY (the same key that enables IG + TikTok), so a plain
// provider-key gate (like isTikTokConfigured) would AUTO-ENABLE Reddit the moment
// the operator configured IG/TikTok. Reddit is a legally-hotter platform (D-08),
// so it stays OFF until the operator EXPLICITLY flips REDDIT_IMPORT_ENABLED="true"
// — even with the key present. The reddit-isolation property test asserts this.
//
// There is NO apify branch: 12-SPIKE returned GO, so the author path is
// ScrapeCreators (no APIFY_TOKEN env, no apify-reddit.ts). A NO-GO would have
// escalated the Apify path to a separate human-gated plan, never wired here.

import { env } from "$lib/server/config/env.js";
import { scrapeCreatorsRedditProvider } from "./scrapecreators-reddit.js";
import type { SocialProvider } from "$lib/sources/social-provider.js";

/**
 * Whether the operator has a usable Reddit provider configured.
 *
 * ★ The kill-switch is checked FIRST as an independent AND-term (D-08): Reddit is
 * OFF unless REDDIT_IMPORT_ENABLED is EXPLICITLY "true", regardless of whether the
 * shared ScrapeCreators key is set. Only THEN does the provider-key check run.
 * Default REDDIT_IMPORT_ENABLED="false" ⇒ false ⇒ graceful degrade.
 */
export function isRedditConfigured(): boolean {
  if (env.REDDIT_IMPORT_ENABLED !== "true") return false;
  return env.REDDIT_PROVIDER === "scrapecreators" && env.SCRAPECREATORS_API_KEY !== "";
}

/** The Reddit provider impl (the SOC-02 issuer). GO decision: ScrapeCreators. */
export const redditProvider: SocialProvider = scrapeCreatorsRedditProvider;

// Re-export the CANONICAL cross-platform switch from the neutral registry (the
// single switch, all platforms — do NOT fork it). The Reddit tree's handlers /
// adapter import `getSocialProvider` from HERE so they read their provider
// accessor from inside their own folder; the routing logic lives in one neutral
// place. Integration tests vi.mock THIS module to inject a fake reddit provider
// at the seam without leaking into the IG/TikTok trees' own copies.
export { getSocialProvider } from "$lib/sources/social-provider-registry.js";
