// Cross-platform social-provider selection (SOC-03) — the CANONICAL switch.
//
// `getSocialProvider("instagram" | "tiktok")` returns the configured provider
// impl, or `null` when the operator hasn't wired one. The null path is the
// SOC-05 graceful-degrade hook: the not-configured walker + observability
// surfaces read `null` as "feature off" rather than crashing. Empty
// <PLATFORM>_PROVIDER (the safe default) ⇒ unresolved ⇒ degrade.
//
// This module is NEUTRAL — it sits next to social-provider.ts (the types) and
// imports each platform's config probe + impl FROM that platform's own tree,
// one-directional (neutral → instagram, neutral → tiktok). No tree imports the
// other tree's registry for the switch, so there is no ESM cycle. The two
// tree-local registries (instagram|tiktok/server/provider/registry.ts) are thin
// re-export shims of this module's getSocialProvider so existing import sites +
// the per-tree vi.mock targets keep working unchanged. New platforms (X) add
// one more case keyed off the same `<PLATFORM>_PROVIDER` env convention,
// contributing only their isConfigured probe + provider impl from their tree.

import {
  isInstagramConfigured,
  instagramProvider,
} from "$lib/sources/instagram/server/provider/registry.js";
import {
  isTikTokConfigured,
  tiktokProvider,
} from "$lib/sources/tiktok/server/provider/registry.js";
import type { SocialPlatform, SocialProvider } from "$lib/sources/social-provider.js";

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
      return isInstagramConfigured() ? instagramProvider : null;
    case "tiktok":
      return isTikTokConfigured() ? tiktokProvider : null;
    default:
      // Twitter / X provider lands in Phase 11.
      return null;
  }
}
