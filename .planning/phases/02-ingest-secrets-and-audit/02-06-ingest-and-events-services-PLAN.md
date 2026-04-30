---
phase: 02-ingest-secrets-and-audit
plan: 06
type: execute
wave: 1
depends_on: [02-03-schema-and-migration, 02-04-games-services]
files_modified:
  - src/lib/server/services/url-parser.ts
  - src/lib/server/services/items-youtube.ts
  - src/lib/server/services/events.ts
  - src/lib/server/services/ingest.ts
  - src/lib/server/integrations/youtube-oembed.ts
  - src/lib/server/integrations/twitter-oembed.ts
  - src/lib/server/dto.ts
  - tests/unit/url-parser.test.ts
  - tests/integration/ingest.test.ts
  - tests/integration/events.test.ts
autonomous: true
requirements: [INGEST-02, INGEST-03, INGEST-04, EVENTS-01, EVENTS-02, EVENTS-03]
requirements_addressed: [INGEST-02, INGEST-03, INGEST-04, EVENTS-01, EVENTS-02, EVENTS-03]
must_haves:
  truths:
    - "parseIngestUrl host-routes to youtube_video / twitter_post / telegram_post / reddit_deferred / unsupported correctly"
    - "INGEST-04: validation runs before any INSERT; malformed URL returns 422; oEmbed 5xx returns 502; cross-checks the DB to confirm no half-written tracked_youtube_videos or events row remains"
    - "INGEST-03 own/blogger auto-decision uses findOwnChannelByHandle (Plan 04) keyed on the oEmbed author_url to set tracked_youtube_videos.is_own"
    - "Twitter URL pasted into ingest.parsePasteAndCreate creates an events row with kind='twitter_post' (D-29)"
    - "Telegram URL pasted creates events row kind='telegram_post'"
    - "Reddit URL returns the friendly inline 'reddit_deferred' result; NO tracked or events row created"
    - "events service createEvent / updateEvent / softDeleteEvent / listEventsForGame all scope by userId; updates and deletes audit via writeAudit (event.created/edited/deleted)"
    - "x.com is canonicalized to twitter.com before publish.twitter.com/oembed lookup (Pitfall 8)"
  artifacts:
    - path: "src/lib/server/services/url-parser.ts"
      provides: "parseIngestUrl(input): ParsedUrl — pure host-detection + canonicalization + video-id extraction"
      contains: "parseIngestUrl"
      min_lines: 60
    - path: "src/lib/server/services/items-youtube.ts"
      provides: "createTrackedYoutubeVideo, listItemsForGame, getItemById, toggleIsOwn, softDeleteItem"
      contains: "findOwnChannelByHandle"
      min_lines: 80
    - path: "src/lib/server/services/events.ts"
      provides: "createEvent, listEventsForGame, getEventById, updateEvent, softDeleteEvent, listTimelineForGame (events + items chronological)"
      contains: "writeAudit"
      min_lines: 80
    - path: "src/lib/server/services/ingest.ts"
      provides: "parsePasteAndCreate(userId, gameId, urlInput, ipAddress) — orchestrates url-parser → oEmbed → service.create with all-or-nothing validation"
      contains: "parseIngestUrl"
      min_lines: 80
    - path: "src/lib/server/integrations/youtube-oembed.ts"
      provides: "fetchYoutubeOembed(canonicalUrl) — public, no key, 5s timeout, returns null on 401/404"
      contains: "youtube.com/oembed"
      min_lines: 35
    - path: "src/lib/server/integrations/twitter-oembed.ts"
      provides: "fetchTwitterOembed(twitterCanonicalUrl) — public, no key, 5s timeout"
      contains: "publish.twitter.com/oembed"
      min_lines: 25
    - path: "src/lib/server/dto.ts"
      provides: "toYoutubeVideoDto + toEventDto"
      contains: "toEventDto"
  key_links:
    - from: "src/lib/server/services/ingest.ts"
      to: "src/lib/server/services/url-parser.ts"
      via: "parseIngestUrl(input) → ParsedUrl discriminated union"
      pattern: "parseIngestUrl"
    - from: "src/lib/server/services/ingest.ts"
      to: "src/lib/server/integrations/youtube-oembed.ts"
      via: "fetchYoutubeOembed(canonicalUrl) called BEFORE INSERT (D-19 validate-first)"
      pattern: "fetchYoutubeOembed"
    - from: "src/lib/server/services/items-youtube.ts"
      to: "src/lib/server/services/youtube-channels.ts"
      via: "findOwnChannelByHandle(userId, authorUrl) drives is_own auto-decision (D-21)"
      pattern: "findOwnChannelByHandle"
    - from: "src/lib/server/services/events.ts"
      to: "src/lib/server/audit.ts"
      via: "writeAudit on event.created / event.edited / event.deleted (EVENTS-03)"
      pattern: "writeAudit\\(.*event\\."
---

<objective>
Land the URL-paste ingest pipeline + tracked_youtube_videos service + events service. This plan covers six REQs (INGEST-02..04, EVENTS-01..03) plus the Twitter/Telegram URL routing into the events table (D-29). The orchestrator (`services/ingest.ts`) is the load-bearing piece — validate-first, all-or-nothing, no half-writes (D-19; INGEST-04).

Purpose: This is the "single most-used widget on the game detail page" (UI-SPEC §"<PasteBox> interaction contract"). Get the validation order right (URL parse → oEmbed fetch → INSERT) and the failure modes right (malformed → 422; oEmbed 5xx → 502; reddit_deferred → 200 with info payload, no INSERT) so plan 08's HTTP routes can map them mechanically.

Output: 1 new pure parser, 2 new service files (items-youtube, events), 1 orchestrator, 2 new integrations files (youtube-oembed, twitter-oembed), DTO additions for items + events, live test bodies for `tests/unit/url-parser.test.ts`, `tests/integration/ingest.test.ts`, and `tests/integration/events.test.ts`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/lib/server/db/schema/tracked-youtube-videos.ts
@src/lib/server/db/schema/events.ts
@src/lib/server/db/schema/youtube-channels.ts
@src/lib/server/services/games.ts
@src/lib/server/services/youtube-channels.ts
@src/lib/server/services/errors.ts
@src/lib/server/audit.ts
@src/lib/server/dto.ts
@.planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md
@.planning/phases/02-ingest-secrets-and-audit/02-CONTEXT.md
@.planning/phases/02-ingest-secrets-and-audit/02-04-SUMMARY.md

<interfaces>
<!-- ParsedUrl discriminated union (D-18; verbatim from RESEARCH.md §"5. URL parser" lines 1170–1230):

export type ParsedUrl =
  | { kind: "youtube_video"; videoId: string; canonicalUrl: string }
  | { kind: "twitter_post"; canonicalUrl: string }
  | { kind: "telegram_post"; canonicalUrl: string }
  | { kind: "reddit_deferred" }
  | { kind: "unsupported" };
-->

<!-- YoutubeOembed shape (RESEARCH.md §"6. YouTube oEmbed fetch" lines 1232–1273):
{
  title: string,
  authorName: string,
  authorUrl: string,         // https://www.youtube.com/@<handle> — the handle URL (Pitfall 3)
  thumbnailUrl: string,
}
fetchYoutubeOembed returns null on 401/404 (private/deleted) or non-2xx.
-->

<!-- INGEST-03 own/blogger resolver (D-21 + Pitfall 3 Option C):
- oEmbed returns author_url like https://www.youtube.com/@RickAstleyYT
- Look up youtube_channels WHERE userId = $1 AND handle_url = author_url AND is_own = true
- If found → tracked_youtube_videos.is_own = true
- If not → tracked_youtube_videos.is_own = false (default; user can toggle later)
findOwnChannelByHandle(userId, handleUrl) is exported by Plan 04's youtube-channels service.
-->

<!-- D-19 INGEST-04 validation order (CRITICAL — RESEARCH.md Pitfall 1):
1. parseIngestUrl(input) — pure, in-memory, no I/O. Reject malformed → 422.
2. For youtube_video: fetchYoutubeOembed(canonicalUrl) — 5s AbortController. If null → 502.
3. For twitter_post: fetchTwitterOembed(canonicalUrl) — 5s. Failure is non-fatal (events row creates with title=URL).
4. ONLY AFTER step 2/3 succeeds, db.insert(...) runs. NO try/catch after insert.
-->
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Pure URL parser + 5 unit tests (no I/O, no DB)</name>
  <files>src/lib/server/services/url-parser.ts, tests/unit/url-parser.test.ts</files>
  <read_first>
    - .planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md §"5. URL parser" lines 1170–1230 (verbatim implementation; copy with only the file-header comment changed)
    - tests/unit/url-parser.test.ts (placeholder file from Plan 02-01 — has 5 it.skip stubs to flip)
    - .planning/phases/02-ingest-secrets-and-audit/02-CONTEXT.md `<decisions>` D-18 (host routing rules) and `<deviations>` Pitfall 8 (x.com canonicalization)
  </read_first>
  <behavior>
    Pure function `parseIngestUrl(input: string): ParsedUrl`. No I/O. Inputs:
    - YouTube canonical: `https://www.youtube.com/watch?v=dQw4w9WgXcQ` → `{kind:'youtube_video', videoId:'dQw4w9WgXcQ', canonicalUrl: same}`.
    - YouTube alt: `https://youtu.be/dQw4w9WgXcQ` → canonicalUrl normalized to `https://www.youtube.com/watch?v=dQw4w9WgXcQ`.
    - YouTube shorts: `https://www.youtube.com/shorts/abc123XYZ_-` → `videoId='abc123XYZ_-'` (11-char check `/^[\w-]{11}$/`).
    - YouTube live / embed: same handling.
    - x.com: `https://x.com/Foo/status/123` → `{kind:'twitter_post', canonicalUrl:'https://twitter.com/Foo/status/123'}`.
    - twitter.com: same kind, canonicalUrl unchanged.
    - t.me: `https://t.me/somechannel/42` → `{kind:'telegram_post', canonicalUrl: same}`.
    - reddit.com OR redd.it: `{kind:'reddit_deferred'}`.
    - Anything else (`example.com/foo`): `{kind:'unsupported'}`.
    - Malformed (`not-a-url`, `'  '`, empty string): `{kind:'unsupported'}`.
  </behavior>
  <action>
    **A. Create `src/lib/server/services/url-parser.ts`** — copy the implementation from RESEARCH.md §"5. URL parser" lines 1170–1230 verbatim (the entire file, including the `extractYouTubeVideoId` helper and the `YT_HOSTS / X_HOSTS / TG_HOSTS / RD_HOSTS` Sets). The file header comment should reference D-18 and Pitfall 8.

    **B. Replace 5 `it.skip` stubs in `tests/unit/url-parser.test.ts` with `it(...)`**:

    ```typescript
    import { describe, it, expect } from "vitest";
    import { parseIngestUrl } from "../../src/lib/server/services/url-parser.js";

    describe("URL parser canonicalization", () => {
      it("02-06: parseIngestUrl handles youtube.com/watch?v=ID", () => {
        const r = parseIngestUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        expect(r).toEqual({ kind: "youtube_video", videoId: "dQw4w9WgXcQ", canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
      });

      it("02-06: parseIngestUrl handles youtu.be/ID", () => {
        const r = parseIngestUrl("https://youtu.be/dQw4w9WgXcQ");
        expect(r.kind).toBe("youtube_video");
        if (r.kind === "youtube_video") {
          expect(r.videoId).toBe("dQw4w9WgXcQ");
          expect(r.canonicalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        }
      });

      it("02-06: parseIngestUrl handles /shorts/ID and /live/ID", () => {
        for (const path of ["shorts", "live", "embed"]) {
          const r = parseIngestUrl(`https://www.youtube.com/${path}/dQw4w9WgXcQ`);
          expect(r.kind).toBe("youtube_video");
          if (r.kind === "youtube_video") expect(r.videoId).toBe("dQw4w9WgXcQ");
        }
      });

      it("02-06: parseIngestUrl canonicalizes x.com → twitter.com", () => {
        const r = parseIngestUrl("https://x.com/AnnaIndie/status/12345");
        expect(r.kind).toBe("twitter_post");
        if (r.kind === "twitter_post") expect(r.canonicalUrl).toBe("https://twitter.com/AnnaIndie/status/12345");
      });

      it("02-06: parseIngestUrl returns reddit_deferred for reddit.com", () => {
        expect(parseIngestUrl("https://www.reddit.com/r/IndieDev/comments/abc/foo/").kind).toBe("reddit_deferred");
        expect(parseIngestUrl("https://redd.it/abc").kind).toBe("reddit_deferred");
        expect(parseIngestUrl("https://old.reddit.com/r/foo").kind).toBe("reddit_deferred");
      });

      // Sanity tests not in the placeholder list — these document behavior; OK to add as additional `it` calls in this single file because Plan 01's stub list said "URL canonicalization" generally.
      it("returns unsupported for unknown host", () => {
        expect(parseIngestUrl("https://example.com/foo").kind).toBe("unsupported");
      });
      it("returns unsupported for malformed input", () => {
        expect(parseIngestUrl("not-a-url").kind).toBe("unsupported");
        expect(parseIngestUrl("").kind).toBe("unsupported");
      });
    });
    ```
  </action>
  <verify>
    <automated>pnpm test:unit tests/unit/url-parser.test.ts --reporter=verbose 2>&1 | tail -20</automated>
  </verify>
  <done>
    `pnpm test:unit tests/unit/url-parser.test.ts` reports ≥7 passing assertions; all 5 placeholder stubs are now `it(...)` not `it.skip(...)`. `parseIngestUrl` is pure (no fetch, no env, no Date side effects).
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: oEmbed integrations + items-youtube + events services + ingest orchestrator + DTOs</name>
  <files>src/lib/server/integrations/youtube-oembed.ts, src/lib/server/integrations/twitter-oembed.ts, src/lib/server/services/items-youtube.ts, src/lib/server/services/events.ts, src/lib/server/services/ingest.ts, src/lib/server/dto.ts</files>
  <read_first>
    - src/lib/server/services/games.ts (Plan 04 — getGameById pattern; ingest must assert game ownership before insert)
    - src/lib/server/services/youtube-channels.ts (Plan 04 — findOwnChannelByHandle is exported here; INGEST-03 calls it)
    - src/lib/server/services/api-keys-steam.ts (Plan 05 — for the AppError code/status pattern when validation fails)
    - src/lib/server/db/schema/tracked-youtube-videos.ts and events.ts (Plan 03 — column names)
    - src/lib/server/db/schema/audit-log.ts + src/lib/server/audit/actions.ts (Plan 03 — action enum members 'item.created', 'item.deleted', 'event.created', 'event.edited', 'event.deleted')
    - .planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md §"6. YouTube oEmbed fetch" lines 1232–1273 (verbatim) and §"Pitfall 1" lines 921–926 (validate-first INSERT order) and §"Pitfall 8" (x.com canonicalization — already handled in url-parser.ts)
  </read_first>
  <action>
    **A. Create `src/lib/server/integrations/youtube-oembed.ts`** — discriminated-union return type per checker W-6 (NOT the older "returns null on any failure" contract from RESEARCH.md §6). Key contract:

    ```typescript
    export type YoutubeOembedResult =
      | { kind: "ok"; data: { title: string; authorName: string; authorUrl: string; thumbnailUrl: string } }
      | { kind: "unavailable" }   // 404 — video deleted / region-locked / never existed
      | { kind: "private" };       // 401 — video set to private

    /**
     * fetchYoutubeOembed returns a discriminated result for the 2xx / 401 / 404 axes.
     * Network errors and 5xx are THROWN — the orchestrator (services/ingest.ts) wraps
     * them into AppError("youtube_oembed_unreachable", 502). This split lets the
     * orchestrator map cleanly:
     *   - ok          → write tracked_youtube_videos row (201)
     *   - unavailable → throw AppError("youtube_unavailable", 422)   [user error: bad URL]
     *   - private     → throw AppError("youtube_unavailable", 422, {reason:"private"})
     *   - thrown      → caught + rethrown as AppError("youtube_oembed_unreachable", 502)
     */
    export async function fetchYoutubeOembed(canonicalUrl: string): Promise<YoutubeOembedResult> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(
          `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`,
          { signal: ctrl.signal, headers: { "user-agent": "neotolis-game-promotion-diary/0.1" } },
        );
        if (res.status === 401) return { kind: "private" };
        if (res.status === 404) return { kind: "unavailable" };
        if (res.status >= 500) throw new Error("youtube_oembed_5xx");
        if (!res.ok) return { kind: "unavailable" };   // any other 4xx treated as unavailable
        const j = (await res.json()) as Record<string, unknown>;
        return {
          kind: "ok",
          data: {
            title: String(j.title ?? ""),
            authorName: String(j.author_name ?? ""),
            authorUrl: String(j.author_url ?? ""),
            thumbnailUrl: String(j.thumbnail_url ?? ""),
          },
        };
      } finally {
        clearTimeout(timer);
      }
    }
    ```

    The orchestrator (`services/ingest.ts` Section E below) maps the three result-kinds:
      - `kind: "ok"` → `createTrackedYoutubeVideo(...)`
      - `kind: "unavailable"` → `throw new AppError("video unavailable", "youtube_unavailable", 422, { reason: "unavailable" })`
      - `kind: "private"` → `throw new AppError("video private", "youtube_unavailable", 422, { reason: "private" })`
      - any thrown error (5xx / network / abort) → caught at the orchestrator boundary and rethrown as `new AppError("youtube oembed unreachable", "youtube_oembed_unreachable", 502)`.

    Plan 02-09 paraglide key mapping (the executor adds these to messages/en.json in Plan 02-09):
      - 422 with `reason: "unavailable"` or `reason: "private"` → `m.ingest_error_youtube_unavailable()` (already in the Plan 09 keyset).
      - 502 `youtube_oembed_unreachable` → `m.ingest_error_oembed_unreachable()` (NEW key — add to Plan 09's messages/en.json bullet list and to the i18n.test.ts required[] array).

    **B. Create `src/lib/server/integrations/twitter-oembed.ts`** — similar shape, smaller surface. Reference https://publish.twitter.com/oembed?url=<canonicalUrl>&omit_script=1. Returns `{authorName: string, html: string} | null`. Failure is non-fatal — the events row stores `title: <author_handle from URL>` if oEmbed succeeds, otherwise just stores the URL with a generic title.

    ```typescript
    // src/lib/server/integrations/twitter-oembed.ts
    import { logger } from "../logger.js";

    export interface TwitterOembed {
      authorName: string;
      authorHandle: string;   // extracted from URL or response.author_url
      html: string;            // raw oEmbed HTML; trimmed to text in service layer
    }

    export async function fetchTwitterOembed(canonicalUrl: string): Promise<TwitterOembed | null> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(
          `https://publish.twitter.com/oembed?url=${encodeURIComponent(canonicalUrl)}&omit_script=1`,
          { signal: ctrl.signal, headers: { "user-agent": "neotolis-game-promotion-diary/0.1" } },
        );
        if (!res.ok) {
          logger.warn({ status: res.status, url: canonicalUrl }, "twitter oembed non-2xx");
          return null;
        }
        const j = (await res.json()) as Record<string, unknown>;
        // canonicalUrl path: /<handle>/status/<id>
        const handle = new URL(canonicalUrl).pathname.split("/").filter(Boolean)[0] ?? "unknown";
        return {
          authorName: String(j.author_name ?? handle),
          authorHandle: handle,
          html: String(j.html ?? ""),
        };
      } catch (err) {
        // Non-fatal: events row creates with placeholder title.
        logger.warn({ err, url: canonicalUrl }, "twitter oembed fetch threw");
        return null;
      } finally {
        clearTimeout(timer);
      }
    }
    ```

    **C. Create `src/lib/server/services/items-youtube.ts`**:

    Export shape:
    ```typescript
    export interface CreateTrackedYoutubeVideoInput {
      gameId: string;
      videoId: string;
      url: string;                  // canonicalUrl from parser
      title: string | null;          // from oEmbed
      channelId: string | null;      // from oEmbed (may be null — Pitfall 3)
      authorUrl: string | null;      // handle URL from oEmbed.author_url
    }
    export async function createTrackedYoutubeVideo(userId: string, input: CreateTrackedYoutubeVideoInput, ipAddress: string): Promise<TrackedVideoRow>
    export async function listItemsForGame(userId: string, gameId: string): Promise<TrackedVideoRow[]>
    export async function getItemById(userId: string, itemId: string): Promise<TrackedVideoRow>
    export async function toggleIsOwn(userId: string, itemId: string, isOwn: boolean): Promise<TrackedVideoRow>
    export async function softDeleteItem(userId: string, itemId: string, ipAddress: string): Promise<void>
    ```

    Implementation rules:
    1. `createTrackedYoutubeVideo`:
       - Pre-flight: `await getGameById(userId, input.gameId)` to assert game exists & is not soft-deleted (throws NotFoundError on cross-tenant — defense in depth).
       - INGEST-03 own/blogger lookup (D-21): if `input.authorUrl` is non-null, call `findOwnChannelByHandle(userId, input.authorUrl)`. If returns a row → `is_own = true`; else `false`.
       - INSERT into trackedYoutubeVideos with `userId, gameId, videoId, url, title, channelId, authorUrl, isOwn`. The `UNIQUE(user_id, video_id)` constraint translates to `409 Conflict` at the route boundary; the service surfaces a specific AppError code='duplicate_item' status=409 by detecting the `unique_violation` (Postgres error code 23505) — wrap the INSERT in try/catch and rethrow.
       - `await writeAudit({action: 'item.created', metadata: {kind:'youtube', item_id, video_id: input.videoId, game_id: input.gameId, is_own}})`.
    2. `toggleIsOwn`: UPDATE `tracked_youtube_videos` SET is_own = $1 WHERE userId AND id. NO audit (UI affordance, low forensic value).
    3. `softDeleteItem`: UPDATE deleted_at = now() WHERE userId AND id; if 0 rows → NotFoundError; audit `item.deleted`.
    4. `listItemsForGame`: WHERE userId AND gameId AND deleted_at IS NULL ORDER BY added_at DESC.

    **D. Create `src/lib/server/services/events.ts`**:

    Export shape:
    ```typescript
    export type EventKind = 'conference' | 'talk' | 'twitter_post' | 'telegram_post' | 'discord_drop' | 'press' | 'other';
    export interface CreateEventInput { gameId: string; kind: EventKind; occurredAt: Date | string; title: string; url?: string|null; notes?: string|null; }
    export async function createEvent(userId: string, input: CreateEventInput, ipAddress: string): Promise<EventRow>
    export async function listEventsForGame(userId: string, gameId: string): Promise<EventRow[]>
    export async function getEventById(userId: string, eventId: string): Promise<EventRow>
    export interface UpdateEventInput { kind?: EventKind; occurredAt?: Date|string; title?: string; url?: string|null; notes?: string|null; }
    export async function updateEvent(userId: string, eventId: string, input: UpdateEventInput, ipAddress: string): Promise<EventRow>
    export async function softDeleteEvent(userId: string, eventId: string, ipAddress: string): Promise<void>
    export async function listTimelineForGame(userId: string, gameId: string): Promise<TimelineRow[]>
    ```

    Implementation rules:
    1. `createEvent`: validate kind is in the closed enum (zod or manual), title non-empty, occurredAt parseable Date. Pre-flight: `getGameById` for cross-tenant assert. INSERT scoped by userId + gameId. Audit `event.created` with metadata `{kind, event_id, game_id, occurred_at: occurredAt.toISOString()}`.
    2. `updateEvent`: UPDATE WHERE userId AND id; throw NotFoundError on miss; audit `event.edited` with metadata `{kind: row.kind, event_id, fields: Object.keys(input)}`.
    3. `softDeleteEvent`: UPDATE deleted_at = now(); audit `event.deleted` with metadata `{event_id, kind}`.
    4. `listTimelineForGame` (EVENTS-02 boundary): SELECT events + tracked_youtube_videos for this user+game where deleted_at IS NULL; merge in JS into a single chronologically-sorted array. Returned rows discriminated by `{kind: 'event' | 'youtube_video', ...}`. The chart layer is Phase 4; Phase 2 only ships the data endpoint.

    **E. Create `src/lib/server/services/ingest.ts`** — the orchestrator (D-18 routing + D-19 validate-first):

    ```typescript
    // src/lib/server/services/ingest.ts
    //
    // Orchestrator: parses URL → fetches oEmbed (validate FIRST per D-19) →
    // dispatches to items-youtube / events / friendly-deferred / unsupported.
    //
    // Result is a discriminated union the route handler maps to:
    //   - { kind: 'youtube_video_created', item: TrackedVideoDto }   → 201
    //   - { kind: 'event_created', event: EventDto }                  → 201
    //   - { kind: 'reddit_deferred' }                                  → 200 + info body (D-18)
    //   - throws AppError 422 ('validation_failed' / 'unsupported_url' / 'youtube_unavailable')
    //   - throws AppError 502 ('youtube_oembed_unreachable')

    import { parseIngestUrl } from "./url-parser.js";
    import { fetchYoutubeOembed } from "../integrations/youtube-oembed.js";
    import { fetchTwitterOembed } from "../integrations/twitter-oembed.js";
    import { createTrackedYoutubeVideo } from "./items-youtube.js";
    import { createEvent } from "./events.js";
    import { AppError } from "./errors.js";

    export type IngestResult =
      | { kind: "youtube_video_created"; itemId: string }
      | { kind: "event_created"; eventId: string }
      | { kind: "reddit_deferred" };

    export async function parsePasteAndCreate(
      userId: string,
      gameId: string,
      input: string,
      ipAddress: string,
    ): Promise<IngestResult> {
      const parsed = parseIngestUrl(input);

      if (parsed.kind === "unsupported") {
        throw new AppError("URL not yet supported", "unsupported_url", 422);
      }
      if (parsed.kind === "reddit_deferred") {
        return { kind: "reddit_deferred" };  // 200 with info body; Plan 08 maps
      }

      if (parsed.kind === "youtube_video") {
        // W-6 discriminated-union mapping:
        //   - kind:"ok"          → INSERT
        //   - kind:"unavailable" → 422 youtube_unavailable
        //   - kind:"private"     → 422 youtube_unavailable (reason in metadata)
        //   - thrown (5xx/net)   → 502 youtube_oembed_unreachable
        let oembed: Awaited<ReturnType<typeof fetchYoutubeOembed>>;
        try {
          oembed = await fetchYoutubeOembed(parsed.canonicalUrl);
        } catch (err) {
          throw new AppError(
            "youtube oembed unreachable",
            "youtube_oembed_unreachable",
            502,
            { cause: String((err as Error)?.message ?? err) },
          );
        }
        if (oembed.kind === "private") {
          throw new AppError("video is private", "youtube_unavailable", 422, { reason: "private" });
        }
        if (oembed.kind === "unavailable") {
          throw new AppError("video unavailable", "youtube_unavailable", 422, { reason: "unavailable" });
        }
        // oembed.kind === "ok" — INSERT only after validate succeeds (D-19; INGEST-04).
        const item = await createTrackedYoutubeVideo(
          userId,
          {
            gameId,
            videoId: parsed.videoId,
            url: parsed.canonicalUrl,
            title: oembed.data.title,
            channelId: null,           // Pitfall 3 Option C: keep null; match by author_url instead
            authorUrl: oembed.data.authorUrl,
          },
          ipAddress,
        );
        return { kind: "youtube_video_created", itemId: item.id };
      }

      if (parsed.kind === "twitter_post") {
        // Twitter oEmbed is best-effort (Pitfall 8). Failure is non-fatal — events row
        // still created with the URL as title.
        const oembed = await fetchTwitterOembed(parsed.canonicalUrl).catch(() => null);
        const title = oembed?.authorName
          ? `Tweet by ${oembed.authorName}`
          : `Tweet at ${new URL(parsed.canonicalUrl).pathname}`;
        const event = await createEvent(
          userId,
          {
            gameId,
            kind: "twitter_post",
            occurredAt: new Date(),
            title,
            url: parsed.canonicalUrl,
            notes: oembed?.html ?? null,
          },
          ipAddress,
        );
        return { kind: "event_created", eventId: event.id };
      }

      // telegram_post (no public oEmbed — store URL only)
      // parsed.kind === 'telegram_post'
      const event = await createEvent(
        userId,
        {
          gameId,
          kind: "telegram_post",
          occurredAt: new Date(),
          title: `Telegram post at ${new URL(parsed.canonicalUrl).pathname}`,
          url: parsed.canonicalUrl,
          notes: null,
        },
        ipAddress,
      );
      return { kind: "event_created", eventId: event.id };
    }
    ```

    **F. AMEND `src/lib/server/dto.ts`** — append `toYoutubeVideoDto` and `toEventDto`:

    ```typescript
    import type { trackedYoutubeVideos, events } from "./db/schema/index.js";
    type YoutubeVideoRow = typeof trackedYoutubeVideos.$inferSelect;
    type EventRow = typeof events.$inferSelect;

    export interface YoutubeVideoDto {
      id: string;
      gameId: string;
      videoId: string;
      url: string;
      title: string | null;
      channelId: string | null;
      authorUrl: string | null;
      isOwn: boolean;
      addedAt: Date;
      lastPolledAt: Date | null;
      lastPollStatus: string | null;
      createdAt: Date;
      updatedAt: Date;
      deletedAt: Date | null;
    }
    export function toYoutubeVideoDto(r: YoutubeVideoRow): YoutubeVideoDto { /* explicit fields, NO userId */ }

    export interface EventDto {
      id: string;
      gameId: string;
      kind: "conference" | "talk" | "twitter_post" | "telegram_post" | "discord_drop" | "press" | "other";
      occurredAt: Date;
      title: string;
      url: string | null;
      notes: string | null;
      createdAt: Date;
      updatedAt: Date;
      deletedAt: Date | null;
    }
    export function toEventDto(r: EventRow): EventDto { /* explicit fields, NO userId */ }
    ```
  </action>
  <verify>
    <automated>pnpm exec tsc --noEmit 2>&1 | tail -10 && pnpm exec eslint src/lib/server/services/items-youtube.ts src/lib/server/services/events.ts src/lib/server/services/ingest.ts 2>&1 | tail -10</automated>
  </verify>
  <done>
    Five new files compile and lint clean (zero tenant-scope violations). DTO projections strip `userId`. The orchestrator's branches cover all 5 ParsedUrl variants and translate to the documented IngestResult / AppError shapes.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Flip ingest.test.ts (7 stubs) + events.test.ts (4 stubs)</name>
  <files>tests/integration/ingest.test.ts, tests/integration/events.test.ts</files>
  <read_first>
    - tests/integration/ingest.test.ts (placeholder file from Plan 02-01 — has 7 it.skip stubs)
    - tests/integration/events.test.ts (placeholder file from Plan 02-01 — has 4 it.skip stubs)
    - tests/integration/helpers.ts (seedUserDirectly)
    - src/lib/server/services/ingest.ts and items-youtube.ts and events.ts (Task 2 outputs — functions under test)
    - src/lib/server/integrations/youtube-oembed.ts and twitter-oembed.ts (mock points)
    - .planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md §"Validation Architecture" lines 1453–1463 (the 7 INGEST + 4 EVENTS test cases)
  </read_first>
  <action>
    Use `vi.spyOn` on the integrations modules (same pattern as Plan 05 with Steam). Replace each `it.skip` with `it`.

    **ingest.test.ts test bodies (sketch — full bodies follow the same shape):**

    ```typescript
    import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
    import { eq, and } from "drizzle-orm";
    import { parsePasteAndCreate } from "../../src/lib/server/services/ingest.js";
    import { createGame } from "../../src/lib/server/services/games.js";
    import { createChannel } from "../../src/lib/server/services/youtube-channels.js";
    import { db } from "../../src/lib/server/db/client.js";
    import { trackedYoutubeVideos } from "../../src/lib/server/db/schema/tracked-youtube-videos.js";
    import { events } from "../../src/lib/server/db/schema/events.js";
    import * as YT from "../../src/lib/server/integrations/youtube-oembed.js";
    import * as TW from "../../src/lib/server/integrations/twitter-oembed.js";
    import { AppError } from "../../src/lib/server/services/errors.js";
    import { seedUserDirectly } from "./helpers.js";

    describe("URL ingest paste-box (INGEST-02..04, twitter/telegram event create)", () => {
      const ytSpy = vi.spyOn(YT, "fetchYoutubeOembed");
      const twSpy = vi.spyOn(TW, "fetchTwitterOembed");
      afterEach(() => { ytSpy.mockReset(); twSpy.mockReset(); });

      it("02-06: INGEST-02 youtube paste creates tracked item with title", async () => {
        ytSpy.mockResolvedValue({ title: "Never Gonna Give You Up", authorName: "Rick Astley", authorUrl: "https://www.youtube.com/@RickAstleyYT", thumbnailUrl: "" });
        const u = await seedUserDirectly({ email: "i1@test.local" });
        const g = await createGame(u.id, { title: "G" }, "127.0.0.1");
        const r = await parsePasteAndCreate(u.id, g.id, "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "127.0.0.1");
        expect(r.kind).toBe("youtube_video_created");
        const [row] = await db.select().from(trackedYoutubeVideos).where(eq(trackedYoutubeVideos.userId, u.id)).limit(1);
        expect(row!.title).toBe("Never Gonna Give You Up");
        expect(row!.videoId).toBe("dQw4w9WgXcQ");
      });

      it("02-06: INGEST-03 is_own auto decision via youtube_channels match", async () => {
        ytSpy.mockResolvedValue({ title: "T", authorName: "A", authorUrl: "https://www.youtube.com/@MyOwn", thumbnailUrl: "" });
        const u = await seedUserDirectly({ email: "i2@test.local" });
        const g = await createGame(u.id, { title: "G" }, "127.0.0.1");
        await createChannel(u.id, { handleUrl: "https://www.youtube.com/@MyOwn", isOwn: true });
        await parsePasteAndCreate(u.id, g.id, "https://www.youtube.com/watch?v=ABC12345678", "127.0.0.1");
        const [row] = await db.select().from(trackedYoutubeVideos).where(eq(trackedYoutubeVideos.userId, u.id)).limit(1);
        expect(row!.isOwn).toBe(true);
      });

      it("02-06: INGEST-03 toggle is_own", async () => { /* ... uses toggleIsOwn from items-youtube ... */ });

      it("02-06: INGEST-04 malformed URL rejects + no half-write", async () => {
        const u = await seedUserDirectly({ email: "i4@test.local" });
        const g = await createGame(u.id, { title: "G" }, "127.0.0.1");
        await expect(parsePasteAndCreate(u.id, g.id, "not-a-url", "127.0.0.1"))
          .rejects.toMatchObject({ status: 422, code: "unsupported_url" });
        const rows = await db.select().from(trackedYoutubeVideos).where(eq(trackedYoutubeVideos.userId, u.id));
        expect(rows.length).toBe(0);
        const evs = await db.select().from(events).where(eq(events.userId, u.id));
        expect(evs.length).toBe(0);
      });

      it("02-06: INGEST-04 oembed 5xx no row", async () => {
        // W-6: 5xx is now THROWN by fetchYoutubeOembed; mock with mockRejectedValue,
        // and expect the orchestrator's translated AppError code "youtube_oembed_unreachable".
        ytSpy.mockRejectedValue(new Error("youtube_oembed_5xx"));
        const u = await seedUserDirectly({ email: "i5@test.local" });
        const g = await createGame(u.id, { title: "G" }, "127.0.0.1");
        await expect(parsePasteAndCreate(u.id, g.id, "https://www.youtube.com/watch?v=ABC12345678", "127.0.0.1"))
          .rejects.toMatchObject({ status: 502, code: "youtube_oembed_unreachable" });
        const rows = await db.select().from(trackedYoutubeVideos).where(eq(trackedYoutubeVideos.userId, u.id));
        expect(rows.length).toBe(0);
      });

      it("02-06: INGEST-04 oembed 404 unavailable no row", async () => {
        // W-6: a 404 (deleted/region-locked) maps to 422 youtube_unavailable.
        ytSpy.mockResolvedValue({ kind: "unavailable" });
        const u = await seedUserDirectly({ email: "i5b@test.local" });
        const g = await createGame(u.id, { title: "G" }, "127.0.0.1");
        await expect(parsePasteAndCreate(u.id, g.id, "https://www.youtube.com/watch?v=ABC12345678", "127.0.0.1"))
          .rejects.toMatchObject({ status: 422, code: "youtube_unavailable" });
        const rows = await db.select().from(trackedYoutubeVideos).where(eq(trackedYoutubeVideos.userId, u.id));
        expect(rows.length).toBe(0);
      });

      it("02-06: twitter paste creates events row kind=twitter_post", async () => {
        twSpy.mockResolvedValue({ authorName: "Anna Indie", authorHandle: "AnnaIndie", html: "<blockquote>...</blockquote>" });
        const u = await seedUserDirectly({ email: "i6@test.local" });
        const g = await createGame(u.id, { title: "G" }, "127.0.0.1");
        const r = await parsePasteAndCreate(u.id, g.id, "https://twitter.com/AnnaIndie/status/12345", "127.0.0.1");
        expect(r.kind).toBe("event_created");
        const [row] = await db.select().from(events).where(eq(events.userId, u.id)).limit(1);
        expect(row!.kind).toBe("twitter_post");
        expect(row!.url).toBe("https://twitter.com/AnnaIndie/status/12345");
      });

      it("02-06: reddit paste returns inline info, no row created", async () => {
        const u = await seedUserDirectly({ email: "i7@test.local" });
        const g = await createGame(u.id, { title: "G" }, "127.0.0.1");
        const r = await parsePasteAndCreate(u.id, g.id, "https://www.reddit.com/r/IndieDev/comments/abc/foo/", "127.0.0.1");
        expect(r.kind).toBe("reddit_deferred");
        // Assert NO row in either table
        expect((await db.select().from(trackedYoutubeVideos).where(eq(trackedYoutubeVideos.userId, u.id))).length).toBe(0);
        expect((await db.select().from(events).where(eq(events.userId, u.id))).length).toBe(0);
      });
    });
    ```

    **events.test.ts test bodies:**

    ```typescript
    describe("events CRUD (EVENTS-01..03)", () => {
      it("02-06: EVENTS-01 create conference event", async () => {
        const u = await seedUserDirectly({ email: "e1@test.local" });
        const g = await createGame(u.id, { title: "G" }, "127.0.0.1");
        const ev = await createEvent(u.id, { gameId: g.id, kind: "conference", occurredAt: new Date("2026-06-01"), title: "GDC 2026" }, "127.0.0.1");
        expect(ev.kind).toBe("conference");
      });

      it("02-06: EVENTS-01 invalid kind returns 422", async () => {
        const u = await seedUserDirectly({ email: "e2@test.local" });
        const g = await createGame(u.id, { title: "G" }, "127.0.0.1");
        await expect(createEvent(u.id, { gameId: g.id, kind: "not-a-kind" as any, occurredAt: new Date(), title: "X" }, "127.0.0.1"))
          .rejects.toMatchObject({ code: "validation_failed", status: 422 });
      });

      it("02-06: EVENTS-02 timeline returns events + items chronological", async () => {
        const u = await seedUserDirectly({ email: "e3@test.local" });
        const g = await createGame(u.id, { title: "G" }, "127.0.0.1");
        // seed one event + one tracked item via direct service calls
        await createEvent(u.id, { gameId: g.id, kind: "press", occurredAt: new Date("2026-04-01"), title: "Coverage" }, "127.0.0.1");
        // (insert a tracked_youtube_videos row directly via service or DB)
        const tl = await listTimelineForGame(u.id, g.id);
        expect(tl.length).toBeGreaterThanOrEqual(1);
        // Assert chronological by occurred_at / added_at
        for (let i = 1; i < tl.length; i++) {
          expect(tl[i - 1].occurredAt.getTime()).toBeLessThanOrEqual(tl[i].occurredAt.getTime());
        }
      });

      it("02-06: EVENTS-03 audit on edit and delete", async () => {
        const u = await seedUserDirectly({ email: "e4@test.local" });
        const g = await createGame(u.id, { title: "G" }, "127.0.0.1");
        const ev = await createEvent(u.id, { gameId: g.id, kind: "talk", occurredAt: new Date(), title: "T" }, "127.0.0.1");
        await updateEvent(u.id, ev.id, { title: "T2" }, "127.0.0.1");
        await softDeleteEvent(u.id, ev.id, "127.0.0.1");
        const audits = await db.select().from(auditLog).where(eq(auditLog.userId, u.id));
        const actions = audits.map((a) => a.action);
        expect(actions).toContain("event.created");
        expect(actions).toContain("event.edited");
        expect(actions).toContain("event.deleted");
      });
    });
    ```
  </action>
  <verify>
    <automated>pnpm test:integration tests/integration/ingest.test.ts tests/integration/events.test.ts --reporter=verbose 2>&1 | tail -40</automated>
  </verify>
  <done>
    11 placeholder it.skip stubs (7 ingest + 4 events) flipped to live `it` and pass. Validate-first invariant (D-19) verified by INGEST-04 tests asserting zero rows after a 422 / 502 path.
  </done>
</task>

</tasks>

<verification>
- `pnpm exec eslint src/lib/server/services/` exits 0.
- `pnpm test:unit tests/unit/url-parser.test.ts && pnpm test:integration tests/integration/ingest.test.ts tests/integration/events.test.ts` all green.
- `grep -c "writeAudit" src/lib/server/services/events.ts` >= 3.
- `grep -c "fetchYoutubeOembed" src/lib/server/services/ingest.ts` >= 1 (validate-first).
- `grep -c "findOwnChannelByHandle" src/lib/server/services/items-youtube.ts` >= 1 (INGEST-03).
</verification>

<success_criteria>
- INGEST-02: YouTube paste fetches oEmbed BEFORE INSERT; row carries title + author_url.
- INGEST-03: own/blogger auto-decision works via handle_url match (Pitfall 3 Option C); toggle endpoint exists.
- INGEST-04: malformed URL rejects 422 with no row; oEmbed 5xx rejects 502 with no row.
- EVENTS-01: create event with closed-enum kind; invalid kind → 422.
- EVENTS-02: timeline endpoint merges events + tracked items chronologically.
- EVENTS-03: audit on update + delete; reads via `event.created/edited/deleted` audit actions.
- D-29: Twitter URL paste auto-creates events kind='twitter_post'; Telegram URL → kind='telegram_post'; Reddit URL → reddit_deferred (no row).
- D-19: every test exercising a validation failure asserts zero rows post-failure.
- 5 unit tests + 7 ingest integration tests + 4 events integration tests passing.
</success_criteria>

<output>
After completion, create `.planning/phases/02-ingest-secrets-and-audit/02-06-SUMMARY.md` summarizing the orchestrator branch table (5 ParsedUrl kinds → IngestResult / AppError mapping) and the INGEST-03 own/blogger lookup approach (handle_url match per Pitfall 3 Option C).
</output>
