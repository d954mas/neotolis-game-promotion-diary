// Social-provider selection, keyed by platform via operator env (SOC-03).
//
// `getSocialProvider("instagram")` returns the configured provider impl, or
// `null` when the operator hasn't wired one. The null path is the SOC-05
// graceful-degrade hook: the not-configured walker + observability surfaces
// read `null` as "feature off" rather than crashing. Empty INSTAGRAM_PROVIDER
// (the safe default) ⇒ unresolved ⇒ degrade.
//
// This is the CANONICAL cross-platform switch — ONE switch, all platforms. Each
// platform's config probe + impl live in that platform's own tree
// (isTikTokConfigured + tiktokProvider come from the tiktok tree's registry
// re-export); this file only routes by platform. New platforms (X) add one more
// case keyed off the same `<PLATFORM>_PROVIDER` env convention.

import { env } from "$lib/server/config/env.js";
import { scrapeCreatorsProvider } from "./scrapecreators.js";
import {
  isTikTokConfigured,
  tiktokProvider,
} from "$lib/sources/tiktok/server/provider/registry.js";
import type { SocialPlatform, SocialProvider } from "$lib/sources/social-provider.js";

export { isTikTokConfigured };

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
    case "tiktok":
      return isTikTokConfigured() ? tiktokProvider : null;
    default:
      // Twitter / X provider lands in Phase 11.
      return null;
  }
}
