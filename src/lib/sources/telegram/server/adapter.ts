// telegram_channel adapter core.
//
// The Core surface (mirrors instagramAccountAdapterCore / youtubeChannelAdapterCore):
// the pure URL-parsing / observability / cross-source-read methods any caller
// (the listing + backfill handlers, tests, the cross-source readers) uses
// directly. The infrastructure-touching methods (registerQueues /
// scheduleCronTicks / backfillSource) and create-time hooks
// (normalizeSourceOnCreate / onSourceCreated / refreshQueue / workQueue) are
// COMPOSED in ./index.ts into the full `telegramAdapter`. Cross-source code
// always imports `telegramAdapter` from the barrel.
//
// Telegram is FREE — there is NO SocialProvider, NO credit reservation, NO
// budget gate (the contrast with the IG core, which threads ctx.origin through
// a paid provider seam). `pollListing` is the thin fetch+parse glue: it issues
// ONE t.me/s GET (through the global pacer inside http.ts) and parses it into
// the typed ParsedTelegramListing the handlers walk. Keeping the fetch+parse
// pair in the core lets the listing/backfill handlers stay thin and lets tests
// mock ONE method (pollListing) to drive the walker against fixture pages.

import { telegramObservability } from "./observability.js";
import { telegramParsePostUrl, telegramParseSourceUrl } from "./url.js";
import { telegramEnrichFeedDtos } from "./feed-enrichment.js";
import { telegramFetchEventMetricSeries } from "./metric-series.js";
import { telegramFetchPollStateMap } from "./poll-state.js";
import { fetchTelegramListing } from "./http.js";
import { parseTelegramListing, type ParsedTelegramListing } from "./parse.js";
import type {
  AdapterObservability,
  AdapterPollState,
  EventKind,
  EventMetricSeries,
  ParsedSourceUrl,
  ParsedUrl,
} from "$lib/sources/adapter.js";
import type { EventDto } from "$lib/server/dto.js";

interface TelegramChannelAdapterCore {
  readonly kind: "telegram_channel";
  parseUrl(url: string): ParsedUrl | null;
  parseSourceUrl(input: string): ParsedSourceUrl | null;
  readonly observability: AdapterObservability;
  /**
   * Fetch + parse ONE page of a channel's t.me/s listing. `beforeCursor` pages
   * back through history (?before=<messageId>); null/undefined starts at the
   * newest page. Returns the typed ParsedTelegramListing (channelTitle, status,
   * posts[], nextBeforeCursor). The t.me fetch goes through the global pacer
   * (http.ts) — the caller (the lane worker dispatch) has already acquired a
   * pacer slot via its claimGate, so this consumes that politeness budget.
   *
   * Kept in the core (not the handler) so the listing + backfill handlers stay
   * thin and tests can mock this single method to drive the walker against
   * fixture pages with no network.
   */
  pollListing(
    channel: string,
    beforeCursor?: string | null,
    pacer?: "acquire" | "already-acquired",
  ): Promise<ParsedTelegramListing>;
  enrichFeedDtos(userId: string, dtos: EventDto[]): Promise<void>;
  fetchEventMetricSeries(
    userId: string,
    event: { kind: EventKind; externalId: string | null },
  ): Promise<EventMetricSeries[]>;
  fetchPollStateMap(
    userId: string,
    externalIds: readonly string[],
  ): Promise<Map<string, AdapterPollState>>;
}

export const telegramChannelAdapterCore: TelegramChannelAdapterCore = {
  kind: "telegram_channel" as const,

  parseUrl(url: string): ParsedUrl | null {
    return telegramParsePostUrl(url);
  },
  parseSourceUrl(input: string): ParsedSourceUrl | null {
    return telegramParseSourceUrl(input);
  },
  observability: telegramObservability,

  async pollListing(
    channel: string,
    beforeCursor?: string | null,
    pacer: "acquire" | "already-acquired" = "acquire",
  ): Promise<ParsedTelegramListing> {
    const html = await fetchTelegramListing(channel, beforeCursor, pacer);
    return parseTelegramListing(html);
  },

  enrichFeedDtos: telegramEnrichFeedDtos,
  fetchEventMetricSeries: telegramFetchEventMetricSeries,
  fetchPollStateMap: telegramFetchPollStateMap,
};
