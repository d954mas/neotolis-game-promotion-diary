// Social-provider selection, keyed by platform via operator env (SOC-03).
//
// `getSocialProvider("instagram")` returns the configured provider impl, or
// `null` when the operator hasn't wired one. The null path is the SOC-05
// graceful-degrade hook: the not-configured walker + observability surfaces
// read `null` as "feature off" rather than crashing. Empty INSTAGRAM_PROVIDER
// (the safe default) ⇒ unresolved ⇒ degrade.
//
// Today the only platform + impl is instagram + scrapecreators. Later phases
// (TikTok / X) add their own per-platform branches keyed off the same
// `<PLATFORM>_PROVIDER` env convention.

import { env } from "$lib/server/config/env.js";
import { scrapeCreatorsProvider } from "./scrapecreators.js";
import type { SocialPlatform, SocialProvider } from "$lib/sources/social-provider.js";

/** Whether the operator has a usable Instagram provider configured: the
 *  provider is selected AND its credential is non-empty. */
export function isInstagramConfigured(): boolean {
  return env.INSTAGRAM_PROVIDER === "scrapecreators" && env.SCRAPECREATORS_API_KEY !== "";
}

/**
 * Resolve the provider for a platform, or `null` when not configured.
 *
 * `null` is a first-class outcome (SOC-05) — the caller degrades gracefully
 * (the walker no-ops, the UI shows "not configured") rather than treating it
 * as an error.
 */
export function getSocialProvider(platform: SocialPlatform): SocialProvider | null {
  switch (platform) {
    case "instagram":
      return isInstagramConfigured() ? scrapeCreatorsProvider : null;
    default:
      // TikTok / Twitter providers land in Phases 9-11.
      return null;
  }
}
