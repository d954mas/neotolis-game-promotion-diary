// Steam Web API integration — store.steampowered.com appdetails fetch.
//
// Plan 02-04 lands `fetchSteamAppDetails` (no API key required); Plan 02-05
// extends this same file with `validateSteamKey` (api.steampowered.com/IWishlistService).
// We keep both calls in one file so future Steam endpoints (price polling,
// review counts, ...) have an obvious home.
//
// Rate limit: ~200 req / 5min on the public store endpoint per
// steamcommunity folklore. Phase 2 fetches once at listing INSERT time;
// Phase 6 will add a shared appdetails cache to absorb repeat lookups
// across users, but that's deferred — single-user instances will not
// hit the limit at any realistic insert rate.
//
// 5-second AbortController timeout: Steam's store endpoint is generally
// fast (<500ms p95) but occasionally hangs. We never want a slow Steam
// response to keep an `addSteamListing` request hanging — the listing
// row is created either way (with NULL cover/release if Steam is down),
// so a transient outage degrades gracefully.

import { logger } from "../logger.js";

export interface SteamAppDetails {
  appId: number;
  name: string;
  /** capsule_image / header_image — null if Steam returned no asset. */
  coverUrl: string | null;
  /** Free-form date string ("Q4 2026" / "14 Mar, 2026" / null if coming_soon). */
  releaseDate: string | null;
  comingSoon: boolean;
  genres: string[];
  categories: string[];
  /** Full Steam payload for forensics + future schema extraction (stored in raw_appdetails jsonb). */
  raw: unknown;
}

/**
 * Fetch the public Steam appdetails record for `appId`.
 *
 * Returns `null` when:
 *   - the request fails (timeout / non-2xx HTTP)
 *   - Steam returns `success: false` (invalid app id)
 *   - the response shape is missing the expected `data` block
 *
 * Callers should treat `null` as "Steam unreachable / app unknown" and
 * still create the listing row with NULL metadata fields.
 */
export async function fetchSteamAppDetails(appId: number): Promise<SteamAppDetails | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(
      `https://store.steampowered.com/api/appdetails?appids=${appId}&l=en`,
      {
        signal: ctrl.signal,
        headers: { "user-agent": "neotolis-game-promotion-diary/0.1" },
      },
    );
    if (!res.ok) {
      logger.warn({ appId, status: res.status }, "steam appdetails non-2xx");
      return null;
    }
    const j = (await res.json()) as Record<string, { success: boolean; data?: unknown }>;
    const block = j[String(appId)];
    if (!block || !block.success || !block.data) return null;
    const d = block.data as {
      name?: string;
      header_image?: string;
      capsule_image?: string;
      release_date?: { date?: string; coming_soon?: boolean };
      genres?: Array<{ description?: string }>;
      categories?: Array<{ description?: string }>;
    };
    return {
      appId,
      name: d.name ?? "",
      coverUrl: d.header_image ?? d.capsule_image ?? null,
      releaseDate: d.release_date?.date ?? null,
      comingSoon: Boolean(d.release_date?.coming_soon),
      genres: (d.genres ?? []).map((g) => g.description ?? "").filter(Boolean),
      categories: (d.categories ?? []).map((c) => c.description ?? "").filter(Boolean),
      raw: d,
    };
  } catch (err) {
    logger.warn({ appId, err: (err as Error).message }, "steam appdetails fetch failed");
    return null;
  } finally {
    clearTimeout(timer);
  }
}
