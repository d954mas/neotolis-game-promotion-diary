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

export interface EventKindDisplay {
  /** Paraglide resolver for the human label (e.g. "Instagram"). */
  label: () => string;
  /** Surfaces the PollingBadge (freshness / operator-paused / refresh-now).
   *  true for the polled kinds (youtube_video / reddit_post / instagram_post /
   *  telegram_post); false for free-form (post/conference/talk/press/other)
   *  and the not-yet-functional kinds (twitter/discord). */
  pollable: boolean;
  /** Mounts the per-event metric-history chart (and game-chart markers).
   *  Matches the kinds whose adapter implements fetchEventMetricSeries. */
  chartable: boolean;
  /** Appears as a chip in the Add Event manual kind picker
   *  (AddEventForm). true for the kinds a user can manually log today —
   *  the polled kinds with a paste flow (youtube_video / reddit_post /
   *  instagram_post / telegram_post) PLUS the free-form kinds (press / post /
   *  conference / talk / other). false for the not-yet-functional kinds
   *  (twitter_post / discord_drop), which have no adapter, no paste flow,
   *  and are filtered out of the /feed KIND axis — letting a user create
   *  events they can't then filter to would be a footgun.
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
   *  / other); false for twitter_post / discord_drop, which have no adapter —
   *  filtering to a kind you can't create is a footgun (same rationale as
   *  manualCreatable).
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
}

export interface SourceKindDisplay {
  /** Paraglide resolver for the human label (e.g. "Instagram"). */
  label: () => string;
  /** Drives the `/sources` list grouping. reddit_account + reddit_subreddit
   *  share one "Reddit" group (same `key`); `order` is the group sort key. */
  platformGroup: { key: string; label: string; order: number };
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
  },
  reddit_post: {
    label: () => m.event_kind_label_reddit_post(),
    pollable: true,
    chartable: true,
    manualCreatable: true,
    feedFilterable: true,
  },
  instagram_post: {
    label: () => m.event_kind_label_instagram_post(),
    pollable: true,
    chartable: true,
    manualCreatable: true,
    feedFilterable: true,
  },
  tiktok_post: {
    label: () => m.event_kind_label_tiktok_post(),
    pollable: true,
    chartable: true,
    manualCreatable: true,
    feedFilterable: true,
  },
  twitter_post: {
    label: () => m.event_kind_label_twitter_post(),
    pollable: false,
    chartable: false,
    manualCreatable: false,
    feedFilterable: false,
  },
  telegram_post: {
    label: () => m.event_kind_label_telegram_post(),
    pollable: true,
    chartable: true,
    manualCreatable: true,
    feedFilterable: true,
  },
  discord_drop: {
    label: () => m.event_kind_label_discord_drop(),
    pollable: false,
    chartable: false,
    manualCreatable: false,
    feedFilterable: false,
  },
  conference: {
    label: () => m.event_kind_label_conference(),
    pollable: false,
    chartable: false,
    manualCreatable: true,
    feedFilterable: true,
  },
  talk: {
    label: () => m.event_kind_label_talk(),
    pollable: false,
    chartable: false,
    manualCreatable: true,
    feedFilterable: true,
  },
  press: {
    label: () => m.event_kind_label_press(),
    pollable: false,
    chartable: false,
    manualCreatable: true,
    feedFilterable: true,
  },
  post: {
    label: () => m.event_kind_label_post(),
    pollable: false,
    chartable: false,
    manualCreatable: true,
    feedFilterable: true,
  },
  other: {
    label: () => m.event_kind_label_other(),
    pollable: false,
    chartable: false,
    manualCreatable: true,
    feedFilterable: true,
  },
} satisfies Record<EventKind, EventKindDisplay>;

// One entry per SourceKind. Same compile-time guard via `satisfies`.
export const SOURCE_KIND_DISPLAY = {
  youtube_channel: {
    label: () => m.source_kind_label_youtube_channel(),
    platformGroup: { key: "youtube", label: "YouTube", order: 0 },
  },
  reddit_account: {
    label: () => m.source_kind_label_reddit_account(),
    platformGroup: { key: "reddit", label: "Reddit", order: 1 },
  },
  reddit_subreddit: {
    label: () => m.source_kind_label_reddit_account(),
    platformGroup: { key: "reddit", label: "Reddit", order: 1 },
  },
  instagram_account: {
    label: () => m.source_kind_label_instagram_account(),
    platformGroup: { key: "instagram", label: "Instagram", order: 2 },
  },
  tiktok_account: {
    label: () => m.source_kind_label_tiktok_account(),
    platformGroup: { key: "tiktok", label: "TikTok", order: 6 },
  },
  twitter_account: {
    label: () => m.source_kind_label_twitter_account(),
    platformGroup: { key: "twitter", label: "Twitter", order: 3 },
  },
  telegram_channel: {
    label: () => m.source_kind_label_telegram_channel(),
    platformGroup: { key: "telegram", label: "Telegram", order: 4 },
  },
  discord_server: {
    label: () => m.source_kind_label_discord_server(),
    platformGroup: { key: "discord", label: "Discord", order: 5 },
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
 *  telegram_post (Phase 10 — TikTok joins the paste-flow kinds). twitter_post /
 *  discord_drop remain excluded (manualCreatable:false) — no adapter, no paste
 *  flow, filtered from /feed. */
export const MANUAL_EVENT_KINDS = [
  "youtube_video",
  "reddit_post",
  "instagram_post",
  "telegram_post",
  "tiktok_post",
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
