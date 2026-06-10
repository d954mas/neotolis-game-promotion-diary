// TikTok-tree-local provider re-export (SOC-03).
//
// Thin re-export of `isTikTokConfigured` + the provider so the tiktok adapter
// folder imports its OWN config probe + impl from inside its own tree, instead
// of reaching across into instagram's registry for them. The CANONICAL
// cross-platform `getSocialProvider` switch lives in instagram's registry today
// (one switch, all platforms — do NOT fork it); this file only surfaces the
// tiktok-specific pieces for the tiktok tree's local imports.

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
