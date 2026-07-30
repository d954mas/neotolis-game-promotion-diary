// Central kind-display config — the SINGLE source of truth for the per-kind
// facts the UI surfaces currently hardcoded in scattered switches/allowlists.
//
// WHY THIS FILE EXISTS
//
// Before this module, adding a new EventKind / SourceKind (Instagram in Phase 8)
// meant editing ~7 surfaces that each carried their own per-kind switch with a
// SILENT `default → "Other"` / skip. A missed surface mis-rendered at runtime
// instead of failing the build. This module makes an omission a COMPILE ERROR:
// `EVENT_KIND_DISPLAY satisfies Record<EventKind, …>` requires EVERY key, so a
// new kind that is missing here fails `pnpm typecheck`. Same philosophy the
// codebase already enforces in `errors.ts categoryToSnapshotStatus` (a switch
// with no `default`) and `AuditFlow` (TS union + Postgres CHECK).
//
// CLIENT-SAFE: imports only paraglide `m` (client-safe) + the adapter type
// unions (erased at runtime). NO `.svelte` imports — both `.svelte` components
// and `+page.server.ts` loaders import from here.
//
// KISS: this carries ONLY the facts a surface actually reads today. Color is
// deliberately NOT here — chart-theme `resolveKindColor` already resolves
// `--k-<kind>` dynamically for any kind, so duplicating it would be a second
// source of truth. Icons live in `kind-icon-svg.ts` (events) and
// `SourceKindIcon.svelte` (sources) which are already config-driven.

import { m } from "$lib/paraglide/messages.js";
import type { EventKind, SourceKind } from "./adapter.js";
import type { AddSourceUiKind } from "./kind-matrix.js";

export interface EventKindDisplay {
  /** Paraglide resolver for the human label (e.g. "Instagram"). */
  label: () => string;
  /** Surfaces the PollingBadge (freshness / operator-paused / refresh-now).
   *  true for the polled kinds (youtube_video / reddit_post / instagram_post /
   *  telegram_post); false for free-form (post/conference/talk/press/other)
   *  and the not-yet-functional discord_drop. */
  pollable: boolean;
  /** Mounts the per-event metric-history chart (and game-chart markers).
   *  Matches the kinds whose adapter implements fetchEventMetricSeries. */
  chartable: boolean;
  /** Appears as a chip in the Add Event manual kind picker
   *  (AddEventForm). true for the kinds a user can manually log today —
   *  the polled kinds with a paste flow (youtube_video / reddit_post /
   *  instagram_post / telegram_post) PLUS the free-form kinds (press / post /
   *  conference / talk / other). false for the not-yet-functional discord_drop,
   *  which has no adapter, no paste flow, and is filtered out of the /feed KIND
   *  axis — letting a user create events they can't then filter to would be a
   *  footgun.
   *
   *  This flag (via the `satisfies Record<EventKind, …>` below) is the
   *  COMPILE-TIME guard that a future new kind can't be silently omitted
   *  from the picker: the new key must declare manualCreatable, forcing an
   *  explicit yes/no decision. Order is carried by MANUAL_EVENT_KINDS. */
  manualCreatable: boolean;
  /** Appears as an option in the /feed KIND filter axis (FiltersSheet's
   *  checkbox list, derived from FEED_FILTERABLE_EVENT_KINDS). true for the
   *  kinds a user can see in their feed and meaningfully filter — the pollable
   *  paste-flow kinds (youtube_video / reddit_post / instagram_post /
   *  telegram_post) PLUS the free-form kinds (press / post / conference / talk
   *  / other); false for discord_drop, which has no adapter — filtering to a
   *  kind you can't create is a footgun (same rationale as manualCreatable).
   *
   *  Phase 10 D-08: this flag REPLACES the hand-maintained allowlist that used
   *  to live in FiltersSheet.svelte (FUNCTIONAL_KIND_OPTIONS). That hand-list
   *  was never updated when instagram_post / telegram_post shipped, so the
   *  social kinds silently dropped out of the /feed filter — the user-reported
   *  regression. Deriving from this flag means a new adapter kind auto-appears
   *  in the filter the moment it's marked feedFilterable:true, with no sheet
   *  edit, and the `satisfies Record<EventKind, …>` below forces the explicit
   *  yes/no decision for every future kind. */
  feedFilterable: boolean;
  /** How the manual-create boundary (createEventSchema / updateEventSchema in
   *  events.ts) validates the `url` field against THIS kind. The SINGLE source
   *  of truth for kind↔URL consistency — the route reads this instead of
   *  carrying its own hardcoded {kind→expected} map (which silently omitted the
   *  social kinds, accepting a twitter_post with a YouTube URL).
   *
   *   - "required":         url MUST be present AND parse as this exact kind.
   *                         The kind's identity IS the URL (youtube_video /
   *                         reddit_post — no link, no event).
   *   - "match-if-present": url is OPTIONAL (a manual social log may have no
   *                         link), but IF present it MUST parse as this kind —
   *                         a wrong-platform URL is rejected.
   *   - "freeform":         no kind↔URL check — a link to anything is fine
   *                         (post / conference / talk / press / other).
   *
   *  parseIngestUrl returns the matching kind name for every URL-parseable kind
   *  (youtube_video / reddit_post / instagram_post / tiktok_post /
   *  telegram_post / twitter_post), so the expected parsed kind IS the event
   *  kind — the validator compares `parseIngestUrl(url).kind === kind`. The
   *  `satisfies Record<EventKind, …>` below compile-forces a mode on every
   *  future kind, so a new pollable kind can't slip past the boundary unchecked. */
  urlValidation: "required" | "match-if-present" | "freeform";
}

export interface SourceKindDisplay {
  /** Paraglide resolver for the human label (e.g. "Instagram"). */
  label: () => string;
  /** Drives the `/sources` list grouping. reddit_account + reddit_subreddit
   *  share one "Reddit" group (same `key`); `order` is the group sort key. */
  platformGroup: { key: string; label: string; order: number };
  /** Paraglide resolver for the per-platform auto-import poll cadence, surfaced
   *  in the Add-Source auto-import toggle, the source-settings card, and the
   *  BackfillPicker blurb. The string states what THIS kind's crons actually do
   *  (scheduleCronTicks in `<kind>/server/index.ts`) — NOT a global "every 6
   *  hours" (the stale copy this field replaced). The free-form not-built
   *  discord kind carries a neutral string since it has no auto-import cron yet; `satisfies Record<SourceKind, …>` still forces an
   *  explicit entry for every future kind, so a new adapter can't ship with a
   *  wrong-but-inherited cadence label. */
  cadence: () => string;
}

// One entry per EventKind. `satisfies Record<EventKind, …>` is the compile-time
// guard: drop a key → `pnpm typecheck` fails ("property 'X' is missing").
export const EVENT_KIND_DISPLAY = {
  youtube_video: {
    label: () => m.event_kind_label_youtube_video(),
    pollable: true,
    chartable: true,
    manualCreatable: true,
    feedFilterable: true,
    urlValidation: "required",
  },
  reddit_post: {
    label: () => m.event_kind_label_reddit_post(),
    pollable: true,
    chartable: true,
    manualCreatable: true,
    feedFilterable: true,
    urlValidation: "required",
  },
  instagram_post: {
    label: () => m.event_kind_label_instagram_post(),
    pollable: true,
    chartable: true,
    manualCreatable: true,
    feedFilterable: true,
    urlValidation: "match-if-present",
  },
  tiktok_post: {
    label: () => m.event_kind_label_tiktok_post(),
    pollable: true,
    chartable: true,
    manualCreatable: true,
    feedFilterable: true,
    urlValidation: "match-if-present",
  },
  twitter_post: {
    label: () => m.event_kind_label_twitter_post(),
    pollable: true,
    chartable: true,
    manualCreatable: true,
    feedFilterable: true,
    urlValidation: "match-if-present",
  },
  telegram_post: {
    label: () => m.event_kind_label_telegram_post(),
    pollable: true,
    chartable: true,
    manualCreatable: true,
    feedFilterable: true,
    urlValidation: "match-if-present",
  },
  discord_drop: {
    label: () => m.event_kind_label_discord_drop(),
    pollable: false,
    chartable: false,
    manualCreatable: false,
    feedFilterable: false,
    urlValidation: "freeform",
  },
  conference: {
    label: () => m.event_kind_label_conference(),
    pollable: false,
    chartable: false,
    manualCreatable: true,
    feedFilterable: true,
    urlValidation: "freeform",
  },
  talk: {
    label: () => m.event_kind_label_talk(),
    pollable: false,
    chartable: false,
    manualCreatable: true,
    feedFilterable: true,
    urlValidation: "freeform",
  },
  press: {
    label: () => m.event_kind_label_press(),
    pollable: false,
    chartable: false,
    manualCreatable: true,
    feedFilterable: true,
    urlValidation: "freeform",
  },
  post: {
    label: () => m.event_kind_label_post(),
    pollable: false,
    chartable: false,
    manualCreatable: true,
    feedFilterable: true,
    urlValidation: "freeform",
  },
  other: {
    label: () => m.event_kind_label_other(),
    pollable: false,
    chartable: false,
    manualCreatable: true,
    feedFilterable: true,
    urlValidation: "freeform",
  },
} satisfies Record<EventKind, EventKindDisplay>;

// One entry per SourceKind. Same compile-time guard via `satisfies`.
//
// `cadence` mirrors each kind's scheduleCronTicks in <kind>/server/index.ts:
//   - youtube_channel : active poll "0 */6 * * *" (every 6h).
//   - reddit_*        : active poll "0 6 * * *" (daily) + cold poll "0 5 * * *"
//                        (daily) + warm one-shot lane "0 * * * *" (hourly next-day
//                        catch, retired after one refresh — 12-SPIKE: Reddit posts
//                        stabilize in 1-2 days, so NO long-lived warm loop).
//   - instagram_account: active poll "0 6 * * *" (daily) + warm per-post lane
//                        "0 * * * *" (hourly, >26h staleness gate → ~1 paid
//                        stats refresh/day per recent post).
//   - tiktok_account  : active poll "0 6 * * *" (daily) + warm lane "0 * * * *"
//                        (hourly, >26h gate → ~1 paid refresh/day).
//   - telegram_channel: active listing "0 */6 * * *" (every 6h) + warm lane
//                        "0 * * * *" (hourly, 12h staleness gate → view counts
//                        refresh ~twice/day).
//   - twitter_account : active poll "0 6 * * *" (daily) + warm per-post lane
//                        "0 * * * *" (hourly, >26h staleness gate → ~1 paid
//                        stats refresh/day per recent tweet) — mirrors IG/TikTok.
//   - discord         : no adapter, no auto-import cron yet → neutral string.
export const SOURCE_KIND_DISPLAY = {
  youtube_channel: {
    label: () => m.source_kind_label_youtube_channel(),
    platformGroup: { key: "youtube", label: "YouTube", order: 0 },
    cadence: () => m.source_cadence_youtube_channel(),
  },
  reddit_account: {
    label: () => m.source_kind_label_reddit_account(),
    platformGroup: { key: "reddit", label: "Reddit", order: 1 },
    cadence: () => m.source_cadence_reddit_account(),
  },
  reddit_subreddit: {
    label: () => m.source_kind_label_reddit_account(),
    platformGroup: { key: "reddit", label: "Reddit", order: 1 },
    cadence: () => m.source_cadence_reddit_account(),
  },
  instagram_account: {
    label: () => m.source_kind_label_instagram_account(),
    platformGroup: { key: "instagram", label: "Instagram", order: 2 },
    cadence: () => m.source_cadence_instagram_account(),
  },
  tiktok_account: {
    label: () => m.source_kind_label_tiktok_account(),
    platformGroup: { key: "tiktok", label: "TikTok", order: 6 },
    cadence: () => m.source_cadence_tiktok_account(),
  },
  twitter_account: {
    label: () => m.source_kind_label_twitter_account(),
    platformGroup: { key: "twitter", label: "Twitter / X", order: 7 },
    cadence: () => m.source_cadence_twitter(),
  },
  telegram_channel: {
    label: () => m.source_kind_label_telegram_channel(),
    platformGroup: { key: "telegram", label: "Telegram", order: 4 },
    cadence: () => m.source_cadence_telegram_channel(),
  },
  discord_server: {
    label: () => m.source_kind_label_discord_server(),
    platformGroup: { key: "discord", label: "Discord", order: 5 },
    cadence: () => m.source_cadence_default(),
  },
} satisfies Record<SourceKind, SourceKindDisplay>;

// Derived helper sets — computed FROM the config so they can NEVER drift from
// the per-kind flags. Surfaces that want a membership test (PollingBadge,
// EventDetailContent) read these instead of re-listing the kinds.
export const POLLABLE_EVENT_KINDS: ReadonlySet<EventKind> = new Set(
  (Object.keys(EVENT_KIND_DISPLAY) as EventKind[]).filter((k) => EVENT_KIND_DISPLAY[k].pollable),
);

export const CHARTABLE_EVENT_KINDS: ReadonlySet<EventKind> = new Set(
  (Object.keys(EVENT_KIND_DISPLAY) as EventKind[]).filter((k) => EVENT_KIND_DISPLAY[k].chartable),
);

/** The /feed KIND filter axis membership — every kind a user can see in their
 *  feed and meaningfully filter to. FiltersSheet derives its KIND checkbox
 *  list from this set (sorted by label), so a new adapter kind auto-appears in
 *  the filter the moment it's marked feedFilterable:true — no hand-maintained
 *  allowlist to forget (Phase 10 D-08, the IG/Telegram regression fix). */
export const FEED_FILTERABLE_EVENT_KINDS: ReadonlySet<EventKind> = new Set(
  (Object.keys(EVENT_KIND_DISPLAY) as EventKind[]).filter(
    (k) => EVENT_KIND_DISPLAY[k].feedFilterable,
  ),
);

/** The /feed KIND filter axis chips, in render ORDER. The live /feed page
 *  (feed/+page.svelte) renders the KIND axis as an explicit ordered chip strip
 *  — paste-flow platforms first (YouTube / Reddit / Instagram / Telegram /
 *  TikTok), then Press, then the free-form catch-alls (Post / Conference / Talk
 *  / Other) — so an ORDER list is required (the boolean feedFilterable flag
 *  alone can't express chip order). FEED_FILTERABLE_EVENT_KINDS stays the source
 *  of MEMBERSHIP; this list is the source of ORDER, and
 *  tests/unit/feed-filter-derivation.test.ts asserts the two never drift (the
 *  set of kinds here MUST equal exactly FEED_FILTERABLE_EVENT_KINDS — same
 *  exact-set-equality guard MANUAL_EVENT_KINDS carries).
 *
 *  Phase 10 D-08: this REPLACES the hand-maintained KIND_AXIS_ORDER array that
 *  lived in feed/+page.svelte. That hand-list was never updated when
 *  instagram_post / telegram_post / tiktok_post shipped, so the social kinds
 *  silently dropped out of the LIVE /feed KIND axis (the FiltersSheet was the
 *  /audit-only mount, not /feed) — the user-reported regression. Deriving from
 *  this list means a new adapter kind auto-appears in the axis the moment it's
 *  marked feedFilterable:true and placed here, with the drift test as the guard. */
export const FEED_KIND_FILTER_KINDS = [
  "youtube_video",
  "reddit_post",
  "instagram_post",
  "telegram_post",
  "tiktok_post",
  "twitter_post",
  "press",
  "post",
  "conference",
  "talk",
  "other",
] as const satisfies readonly EventKind[];

/** The Add Event manual kind picker (AddEventForm) chip list, in render
 *  order. EXPLICIT order list because chip order is a deliberate UX choice
 *  (platform-with-paste-flow kinds first, then free-form) that the boolean
 *  flag alone can't express. The flag stays the source of MEMBERSHIP; this
 *  list is the source of ORDER, and `tests/unit/kind-display.test.ts` asserts
 *  the two never drift — the set of kinds here MUST equal exactly the set of
 *  `manualCreatable: true` entries in EVENT_KIND_DISPLAY. So adding a kind is
 *  still a single decision (set its manualCreatable flag): the test fails
 *  loudly until the kind is either placed here or marked manualCreatable:false.
 *
 *  instagram_post sits right after reddit_post (Phase 08 — Instagram joins the
 *  paste-flow kinds); telegram_post sits right after instagram_post (Phase 09 —
 *  Telegram joins the paste-flow kinds); tiktok_post sits right after
 *  telegram_post (Phase 10 — TikTok joins the paste-flow kinds); twitter_post
 *  sits right after tiktok_post (Phase 11 — Twitter/X joins the paste-flow
 *  kinds, paid twitterapi.io). discord_drop remains excluded
 *  (manualCreatable:false) — no adapter, no paste flow, filtered from /feed. */
export const MANUAL_EVENT_KINDS = [
  "youtube_video",
  "reddit_post",
  "instagram_post",
  "telegram_post",
  "tiktok_post",
  "twitter_post",
  "press",
  "post",
  "conference",
  "talk",
  "other",
] as const satisfies readonly EventKind[];

/** Human label for any EventKind. The string union arg keeps callers that hold
 *  a widened `string` (DTO `kind` columns) honest — an unknown kind falls back
 *  to the "Other" label rather than crashing. Known kinds resolve via the
 *  config (single source of truth). */
export function eventKindLabel(kind: string): string {
  return (EVENT_KIND_DISPLAY[kind as EventKind] ?? EVENT_KIND_DISPLAY.other).label();
}

/** Human label for any SourceKind. */
export function sourceKindDisplayLabel(kind: SourceKind): string {
  return SOURCE_KIND_DISPLAY[kind].label();
}

/** The per-platform auto-import poll cadence string for a SourceKind (e.g.
 *  "New videos every 6 hours" / "New posts daily; stats of recent posts refresh
 *  hourly"). The SINGLE source of truth the Add-Source toggle, source-settings
 *  card, and BackfillPicker blurb all read — no surface re-states "every 6
 *  hours". The synthetic Add-Source UI kind "reddit" is resolved via
 *  addSourceUiCadenceLabel below before reaching here. */
export function sourceCadenceLabel(kind: SourceKind): string {
  return SOURCE_KIND_DISPLAY[kind].cadence();
}

/** Maps the synthetic Add-Source UI kind "reddit" (a single chip the server
 *  resolves to reddit_account vs reddit_subreddit by URL shape) onto the
 *  representative DB SourceKind whose cadence we surface. Every other
 *  AddSourceUiKind IS already a SourceKind. The `satisfies Record<…>` makes a
 *  new Add-Source UI kind a COMPILE error here, so the Add-Source surfaces can
 *  never paste a kind the cadence map doesn't cover. */
const ADD_SOURCE_UI_KIND_TO_SOURCE_KIND = {
  youtube_channel: "youtube_channel",
  reddit: "reddit_account",
  twitter_account: "twitter_account",
  telegram_channel: "telegram_channel",
  discord_server: "discord_server",
  instagram_account: "instagram_account",
  tiktok_account: "tiktok_account",
} as const satisfies Record<AddSourceUiKind, SourceKind>;

/** The cadence string for an Add-Source UI kind (the chip-picker union that
 *  carries the synthetic "reddit"). Both Add-Source surfaces (/sources/new +
 *  AddSourceModal) call THIS so the auto-import toggle + BackfillPicker blurb
 *  speak the real per-platform cadence with ONE shared map — never a per-surface
 *  copy. An unknown string (the picker's widened `kind?: string` prop) falls
 *  back to the neutral default rather than crashing. */
export function addSourceUiCadenceLabel(kind: AddSourceUiKind): string {
  const sourceKind = ADD_SOURCE_UI_KIND_TO_SOURCE_KIND[kind];
  return sourceKind ? sourceCadenceLabel(sourceKind) : m.source_cadence_default();
}

/** The `/sources` platform groups in render order, de-duplicated by group key
 *  (reddit_account + reddit_subreddit collapse to one "Reddit" group). Drives
 *  the source-list grouping so a newly-added kind (instagram_account) shows up
 *  without editing the page. */
export const SOURCE_PLATFORM_GROUPS: ReadonlyArray<{
  key: string;
  label: string;
  order: number;
}> = (() => {
  const byKey = new Map<string, { key: string; label: string; order: number }>();
  for (const kind of Object.keys(SOURCE_KIND_DISPLAY) as SourceKind[]) {
    const g = SOURCE_KIND_DISPLAY[kind].platformGroup;
    if (!byKey.has(g.key)) byKey.set(g.key, g);
  }
  return [...byKey.values()].sort((a, b) => a.order - b.order);
})();

/** The platform-group key for a SourceKind — the `/sources` page buckets each
 *  source into the group with this key. */
export function sourcePlatformGroupKey(kind: SourceKind): string {
  return SOURCE_KIND_DISPLAY[kind].platformGroup.key;
}
