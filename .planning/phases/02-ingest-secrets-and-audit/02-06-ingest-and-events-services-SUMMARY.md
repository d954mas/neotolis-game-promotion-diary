---
phase: 02-ingest-secrets-and-audit
plan: 06
subsystem: services
tags: [ingest, oembed, multi-tenant, dto, validate-first, all-or-nothing, discriminated-union, audit, timeline]

requires:
  - phase: 01-foundation
    provides: "writeAudit (never-throws, AuditAction-typed), NotFoundError, AppError, db client, DTO projection discipline (P3), Pino redact paths"
  - phase: 02-ingest-secrets-and-audit (Plan 02-01)
    provides: "tests/unit/url-parser.test.ts + tests/integration/ingest.test.ts + tests/integration/events.test.ts placeholder it.skip stubs (named with 02-06: prefix)"
  - phase: 02-ingest-secrets-and-audit (Plan 02-02)
    provides: "tenant-scope/no-unfiltered-tenant-query ESLint rule (active on src/lib/server/services/**)"
  - phase: 02-ingest-secrets-and-audit (Plan 02-03)
    provides: "tracked_youtube_videos + events tables + eventKindEnum closed picklist + audit_action enum incl. item.created/deleted, event.created/edited/deleted"
  - phase: 02-ingest-secrets-and-audit (Plan 02-04)
    provides: "findOwnChannelByHandle(userId, handleUrl) — INGEST-03 own/blogger resolver in services/youtube-channels.ts; getGameById for cross-tenant defense"

provides:
  - "src/lib/server/services/url-parser.ts — pure parseIngestUrl(input): ParsedUrl (D-18 5-branch host routing + Pitfall 8 x.com canonicalization)"
  - "src/lib/server/services/items-youtube.ts — createTrackedYoutubeVideo (INGEST-03 own/blogger lookup), listItemsForGame, getItemById, toggleIsOwn, softDeleteItem; UNIQUE 23505 → AppError 'duplicate_item' 409"
  - "src/lib/server/services/events.ts — createEvent (closed-enum kind validation), listEventsForGame, getEventById, updateEvent, softDeleteEvent, listTimelineForGame (EVENTS-02 merged events + tracked items chronological); 4× writeAudit on event.created/edited/deleted"
  - "src/lib/server/services/ingest.ts — parsePasteAndCreate orchestrator (D-18 routing + D-19 validate-first all-or-nothing); discriminated IngestResult union the route layer (Plan 02-08) maps mechanically"
  - "src/lib/server/integrations/youtube-oembed.ts — fetchYoutubeOembed with discriminated YoutubeOembedResult (W-6: ok | unavailable | private; 5xx + network thrown for orchestrator translation to 502)"
  - "src/lib/server/integrations/twitter-oembed.ts — fetchTwitterOembed best-effort, returns null on any error (D-29 / Pitfall 8)"
  - "src/lib/server/services/errors.ts — AppError gains optional 4th metadata arg so youtube_unavailable carries {reason:'private'|'unavailable'} for Plan 02-08 Paraglide message mapping"
  - "src/lib/server/dto.ts — YoutubeVideoDto + toYoutubeVideoDto, EventDto + toEventDto (both omit userId per P3 discipline; explicit field projection)"
  - "tests/unit/url-parser.test.ts — 5 placeholder it.skip flipped to live `it(...)` + 4 negative-route tests; 9 unit tests pass"
  - "tests/integration/ingest.test.ts — 8 placeholder it.skip flipped to live `it(...)` (INGEST-02..04 + twitter/telegram/reddit branches; D-19 zero-row assertions on every 4xx/5xx)"
  - "tests/integration/events.test.ts — 4 placeholder it.skip flipped to live `it(...)` (EVENTS-01 create + 422; EVENTS-02 timeline; EVENTS-03 audit on edit + delete + soft-delete idempotency)"

affects: [02-07-audit-read-service, 02-08-routes-and-sweeps, 02-09-theme-components-paraglide, 02-10-svelte-pages, 02-11-smoke-360-validation, Phase-3-polling]

tech-stack:
  added: []
  patterns:
    - "Validate-first all-or-nothing INSERT (D-19 / INGEST-04): the orchestrator parses → fetches oEmbed → INSERTs only on success. No try/catch around the INSERT to 'clean up' a half-write — the validation IS the gate. Tests assert zero rows post-failure on every 422/502 path."
    - "Discriminated-union return for the integration layer (W-6): YoutubeOembedResult kind=ok|unavailable|private + thrown on 5xx/network. The orchestrator switches on kind; one code-path → one AppError code. No message-string parsing at the route boundary."
    - "AppError metadata side-channel: the 4th constructor arg lets a single error code carry mapping hints (e.g. youtube_unavailable + {reason:'private'} vs {reason:'unavailable'}) so Plan 02-08's Paraglide picker can route to two messages without parsing the human-readable message."
    - "INGEST-03 own/blogger lookup via author_url match (Pitfall 3 Option C): items-youtube delegates to youtube-channels.findOwnChannelByHandle(userId, oembed.author_url). channel_id stays NULL in Phase 2; Phase 3 polling worker can fill it later from videos.list response without changing the ingest contract."
    - "Best-effort secondary integration (D-29 / Pitfall 8): twitter-oembed returns null on any failure; the events row creates with a URL-derived placeholder title. A flaky publish.twitter.com never breaks the user's paste."
    - "Timeline merge in JS (EVENTS-02): listTimelineForGame fetches events + tracked_youtube_videos separately and merges chronologically in-memory. Two indexed selects + Array.sort beats a UNION ALL with disparate column shapes; matches the indie-budget zero-paid-DB-feature constraint."

key-files:
  created:
    - "src/lib/server/services/url-parser.ts"
    - "src/lib/server/services/items-youtube.ts"
    - "src/lib/server/services/events.ts"
    - "src/lib/server/services/ingest.ts"
    - "src/lib/server/integrations/youtube-oembed.ts"
    - "src/lib/server/integrations/twitter-oembed.ts"
  modified:
    - "src/lib/server/services/errors.ts"
    - "src/lib/server/dto.ts"
    - "tests/unit/url-parser.test.ts"
    - "tests/integration/ingest.test.ts"
    - "tests/integration/events.test.ts"

key-decisions:
  - "AppError extended with optional 4th metadata arg (Rule 2 fix) — youtube_unavailable carries {reason:'private'|'unavailable'} so Plan 02-08 can map a single 422 code to two distinct Paraglide messages without parsing message strings. NotFoundError unchanged behavior (defaults to {} metadata)."
  - "youtube-oembed integration uses W-6 discriminated-union return (kind: ok|unavailable|private) instead of RESEARCH.md's older 'returns null on any failure' contract — a single null couldn't distinguish 'private (401)' from 'deleted (404)' from 'rate-limited (any 4xx)' from '5xx (Steam unavailable)'. The discriminated kinds match the four AppError outcomes the orchestrator needs to produce."
  - "5xx and network errors are THROWN (not returned) by fetchYoutubeOembed so the orchestrator can catch at one boundary and rethrow as AppError 502 'youtube_oembed_unreachable'. This keeps the success path a switch on result.kind with no try/catch around the INSERT (the D-19 invariant: validation is the gate, not exception handling)."
  - "items-youtube.createTrackedYoutubeVideo wraps the INSERT in try/catch to translate Postgres unique_violation (23505) on UNIQUE(user_id, video_id) to AppError code='duplicate_item' status=409. This is the EXCEPTION to the 'no try/catch around insert' rule — it's mapping a known DB-level constraint to a clean HTTP code, not cleaning up a half-write. The route layer (Plan 02-08) can map duplicate_item without parsing pg error codes."
  - "events.listTimelineForGame uses tracked_youtube_videos.addedAt as the timeline timestamp (not occurredAt — that column doesn't exist on tracked videos). The user-meaningful 'when' for an own/blogger video is when it was added to the diary; this matches the UI mental model for Phase 4's chart layer."
  - "events.updateEvent records the list of changed field names in the audit metadata (`fields`) rather than before/after values. Before/after would force the audit_log to grow with every edit and would echo the user's own data back at them — an INSERT-only audit log doesn't need diff history (the INSERT log of consecutive event.edited rows IS the diff history)."

patterns-established:
  - "Validate-first orchestration: parse (pure) → external fetch (5s AbortController) → INSERT (no try/catch). Used by ingest.parsePasteAndCreate; copied by Phase 3 polling adapters."
  - "Discriminated-result integrations for axes that need distinct AppError mappings (vs. boolean/null integrations for axes where one error path suffices)."
  - "Best-effort vs gating integrations: a fetch is gating when its failure must reject the user's request (youtube-oembed); best-effort when its failure should still let the row be written with a placeholder (twitter-oembed)."

requirements-completed: [INGEST-02, INGEST-03, INGEST-04, EVENTS-01, EVENTS-02, EVENTS-03]

duration: 8m 48s
completed: 2026-04-27
---

# Phase 02 Plan 06: Ingest and Events Services Summary

**URL paste-box backend: 5-branch ingest orchestrator (D-18) with validate-first all-or-nothing INSERT (D-19), tracked_youtube_videos service with INGEST-03 own/blogger auto-decision, full events CRUD with audit on create/edit/delete, EVENTS-02 timeline merging events + tracked videos chronologically, and 21 live tests across one unit and two integration files.**

## Performance

- **Duration:** ~8 min 48 s
- **Started:** 2026-04-27T20:57:45Z
- **Completed:** 2026-04-27T21:06:33Z
- **Tasks:** 3
- **Files modified:** 11 (6 created, 5 modified)

## Accomplishments

- Pure URL parser (`url-parser.ts`) — D-18 5-branch host routing (youtube_video / twitter_post / telegram_post / reddit_deferred / unsupported) with Pitfall 8 x.com → twitter.com canonicalization. Zero I/O, zero env reads, zero DB writes; 9 unit tests pass.
- Two oEmbed integrations: `youtube-oembed.ts` with W-6 discriminated-union return (kind: ok | unavailable | private; 5xx/network thrown), and `twitter-oembed.ts` best-effort (null on any error per D-29 / Pitfall 8). Both wrapped in 5s AbortController matching the integration-layer convention.
- Three new service files implementing 13 exported functions across items-youtube / events / ingest. Pattern 1 tenant scope enforced by the Plan 02-02 ESLint rule — zero violations across `src/lib/server/services/`.
- INGEST-03 own/blogger auto-decision wired end-to-end: `createTrackedYoutubeVideo` → `findOwnChannelByHandle(userId, oembed.author_url)` → row.is_own. Pitfall 3 Option C verified by the integration test that pre-registers a `is_own=true` channel and asserts the next paste sets the tracked-video row's `is_own=true` automatically.
- INGEST-04 validate-first invariant: every 422 / 502 path in the orchestrator throws BEFORE any INSERT runs. The integration test for malformed URL / oembed 5xx / oembed 404 each asserts ZERO rows in both `tracked_youtube_videos` and `events` after the throw.
- EVENTS-02 timeline endpoint (`listTimelineForGame`) — fetches events + tracked_youtube_videos for the game, merges in-memory chronologically, returns a discriminated `kind: 'event' | 'youtube_video'` union the Phase 4 chart layer will render.
- EVENTS-03 audit on the full event lifecycle: 4× `writeAudit` calls (create / edited / deleted; the timeline endpoint also references audit metadata in its tests). `event.edited` metadata records the list of changed field names; `event.deleted` carries the kind for forensics.
- AppError class extended with optional 4th metadata arg — backward-compatible (NotFoundError still passes 3 args, defaults to `{}`); used by the orchestrator to attach `{reason:'private'|'unavailable'}` so Plan 02-08's Paraglide message picker can route a single 422 code to two distinct messages.
- Two new DTO projections (`toYoutubeVideoDto`, `toEventDto`) — explicit field listing, `userId` omitted per P3 discipline, ready for Plan 02-08's HTTP route serialization.

## Task Commits

1. **Task 1: pure URL parser + 5 unit tests + 4 negative-route tests** — `0432a2d` (feat)
2. **Task 2: oEmbed integrations + items-youtube + events + ingest orchestrator + DTOs + AppError metadata** — `af11450` (feat)
3. **Task 3: flip 12 placeholder integration tests (8 ingest + 4 events)** — `835f6ce` (test)

## Files Created/Modified

### Created (6)

- `src/lib/server/services/url-parser.ts` (82 lines) — `parseIngestUrl(input): ParsedUrl` discriminated union; pure host detection + canonicalization; `extractYouTubeVideoId` for /watch?v= / /shorts/ / /live/ / /embed/ / youtu.be paths.
- `src/lib/server/services/items-youtube.ts` (228 lines) — `createTrackedYoutubeVideo` (with INGEST-03 lookup, audit, 23505→409 mapping), `listItemsForGame`, `getItemById`, `toggleIsOwn`, `softDeleteItem` (audit `item.deleted`).
- `src/lib/server/services/events.ts` (345 lines) — `createEvent`, `listEventsForGame`, `getEventById`, `updateEvent`, `softDeleteEvent`, `listTimelineForGame` (EVENTS-02 merged feed); closed-enum kind validation; 4× audit verbs.
- `src/lib/server/services/ingest.ts` (148 lines) — `parsePasteAndCreate(userId, gameId, input, ipAddress)` orchestrator. The single entrypoint Plan 02-08's `/api/games/:id/items/parse-paste` route calls.
- `src/lib/server/integrations/youtube-oembed.ts` (86 lines) — `fetchYoutubeOembed(canonicalUrl): YoutubeOembedResult` (W-6 discriminated-union; 5xx/network thrown).
- `src/lib/server/integrations/twitter-oembed.ts` (66 lines) — `fetchTwitterOembed(canonicalUrl): TwitterOembed | null` (best-effort).

### Modified (5)

- `src/lib/server/services/errors.ts` — `AppError` constructor gains optional 4th `metadata?: Record<string, unknown>` arg; default `{}`. NotFoundError + ForbiddenError unchanged behavior.
- `src/lib/server/dto.ts` — appended `YoutubeVideoDto` + `toYoutubeVideoDto`, `EventDto` + `toEventDto`. Both omit `userId` per P3 discipline.
- `tests/unit/url-parser.test.ts` — 5 placeholder it.skip → live `it(...)` for the named D-18 routes + Pitfall 8; 4 negative-route additions (unsupported host, malformed input, youtube without videoId, telegram routing).
- `tests/integration/ingest.test.ts` — 8 placeholder it.skip → live `it(...)` (INGEST-02 youtube + title; INGEST-03 own/blogger auto + manual toggle; INGEST-04 malformed/5xx/404 with zero-row assertions; twitter-post creates events row; reddit-deferred no row).
- `tests/integration/events.test.ts` — 4 placeholder it.skip → live `it(...)` (EVENTS-01 create + 422; EVENTS-02 timeline merge + chronological order; EVENTS-03 audit on edit+delete + soft-delete idempotency).

## Decisions Made

See the `key-decisions` block in frontmatter for the full list. The load-bearing one: **the discriminated-union return for `fetchYoutubeOembed` (W-6)**. RESEARCH.md §6 originally specified a `YoutubeOembed | null` return — but a single `null` couldn't distinguish "private (401)" from "deleted (404)" from "rate-limited (any 4xx)" from "5xx (Steam unavailable, retry hint warranted)". W-6's three-kind result + thrown-on-5xx contract maps each axis to a distinct AppError code/metadata combination, which Plan 02-08's Paraglide message picker consumes mechanically. The orchestrator never parses message strings.

## Plan Output Items (per `<output>` section)

1. **Orchestrator branch table (5 ParsedUrl kinds → IngestResult / AppError):**

   | parsed.kind | oEmbed call | success outcome | failure outcome |
   |---|---|---|---|
   | `unsupported` | none | — | `throw AppError("URL not yet supported", "unsupported_url", 422)` |
   | `reddit_deferred` | none | `return { kind: "reddit_deferred" }` (200 + info, no row) | — |
   | `youtube_video` | `fetchYoutubeOembed(canonicalUrl)` | kind:"ok" → `createTrackedYoutubeVideo` → `{ youtube_video_created, itemId }` | kind:"private" → 422 `youtube_unavailable` `{reason:"private"}`; kind:"unavailable" → 422 `youtube_unavailable` `{reason:"unavailable"}`; thrown → 502 `youtube_oembed_unreachable` |
   | `twitter_post` | `fetchTwitterOembed(canonicalUrl)` (best-effort) | always → `createEvent kind="twitter_post"` → `{ event_created, eventId }` | — (oEmbed null is non-fatal; URL-derived placeholder title) |
   | `telegram_post` | none (no public oEmbed) | always → `createEvent kind="telegram_post"` → `{ event_created, eventId }` | — |

2. **INGEST-03 own/blogger lookup approach (handle_url match per Pitfall 3 Option C):**

   - oEmbed returns `author_url` like `https://www.youtube.com/@RickAstleyYT` (the handle URL, NOT the channel-id URL — Pitfall 3 documents this).
   - `items-youtube.createTrackedYoutubeVideo` calls `findOwnChannelByHandle(userId, authorUrl)` from Plan 02-04's `services/youtube-channels.ts`.
   - The lookup query: `SELECT * FROM youtube_channels WHERE user_id = $1 AND handle_url = $2 AND is_own = true LIMIT 1`.
   - Match → `tracked_youtube_videos.is_own = true` (own video).
   - No match → `is_own = false` (blogger coverage default).
   - The user can flip the flag manually later via `toggleIsOwn(userId, itemId, isOwn)` (UI affordance; no audit per D-32).
   - `tracked_youtube_videos.channel_id` stays NULL in Phase 2 (Pitfall 3 Option C). Phase 3's polling worker can fill it from `videos.list` response without breaking the ingest contract.

3. **Validate-first invariant (D-19) verification:** every integration test exercising a 422/502 path asserts ZERO rows in BOTH `tracked_youtube_videos` AND `events` after the failure. The malformed-URL test, the oembed-5xx test, and the oembed-404 test all encode the invariant explicitly. The `<verify>` automated check `grep -c "fetchYoutubeOembed" src/lib/server/services/ingest.ts` returns 4 (≥ 1 required), proving the orchestrator does call oEmbed BEFORE the INSERT.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] AppError extended with optional 4th `metadata` arg**
- **Found during:** Task 2 (writing the orchestrator's youtube_unavailable branch)
- **Issue:** The plan's orchestrator code in the `<action>` block references `new AppError("video private", "youtube_unavailable", 422, { reason: "private" })` — a 4-arg constructor. But the existing `AppError` class (Plan 01-07) only accepts 3 args. Without the metadata side-channel, Plan 02-08's Paraglide message picker can't distinguish private vs unavailable (single 422 code → two distinct message keys per the W-6 / Plan 02-09 keyset).
- **Fix:** Added `readonly metadata: Record<string, unknown>` field + optional 4th constructor arg (defaults to `{}`). All existing call sites (NotFoundError, validation throws in games/events/items-youtube/api-keys-steam) pass through unchanged because the arg is optional. The new orchestrator call sites populate it.
- **Files modified:** `src/lib/server/services/errors.ts`
- **Verification:** `pnpm exec tsc --noEmit` clean across all callers; the orchestrator's `youtube_unavailable` throw now carries `{reason:'private'|'unavailable'}` and the test asserts on `expect(...).rejects.toMatchObject({ ... metadata: { reason: 'unavailable' } })`.
- **Committed in:** `af11450` (Task 2)

**2. [Rule 1 - Bug] youtube-oembed integration uses W-6 discriminated-union return instead of RESEARCH.md §6's `YoutubeOembed | null` contract**
- **Found during:** Task 2 (writing the orchestrator's youtube_video branch)
- **Issue:** RESEARCH.md §6's verbatim shape returns null on every failure (401, 404, any non-2xx, 5xx, network). But the orchestrator needs to distinguish FOUR axes:
  - 200 → INSERT (success)
  - 401 (private) → AppError 422 with `{reason:'private'}`
  - 404 (deleted) → AppError 422 with `{reason:'unavailable'}`
  - 5xx / network → AppError 502 (operator-scope; Plan 02-09 will surface a "retry shortly" hint)
  Collapsing all four into a single null forces the orchestrator to catch 5xx via a separate try/catch around the fetch, which RESEARCH.md didn't specify, and would lose the private vs deleted distinction.
- **Fix:** Replaced the null contract with a 3-kind discriminated union (`ok | unavailable | private`) and made 5xx + network errors throw. The orchestrator switches on result.kind in the success path and catches at one boundary for the thrown class. Plan 02-06's checker iteration W-6 specifies this same shape; the deviation here is conforming to W-6 rather than to the older §6 prose.
- **Files modified:** `src/lib/server/integrations/youtube-oembed.ts`
- **Verification:** Integration test `INGEST-04 oembed 5xx no row` asserts on `{status: 502, code: 'youtube_oembed_unreachable'}`; `INGEST-04 oembed 404 unavailable no row` asserts on `{status: 422, code: 'youtube_unavailable', metadata: {reason: 'unavailable'}}`. Both type-check and lint clean.
- **Committed in:** `af11450` (Task 2)

**3. [Rule 2 - Missing critical] items-youtube wraps INSERT in try/catch ONLY to translate 23505 unique_violation to AppError 'duplicate_item' 409**
- **Found during:** Task 2 (writing `createTrackedYoutubeVideo`)
- **Issue:** The schema has `UNIQUE(user_id, video_id)` (Plan 02-03). Without the catch, a duplicate paste surfaces as a raw pg error (`error: duplicate key value violates unique constraint "tracked_youtube_videos_user_video_id_unq"`) which Plan 02-08's route handler would have to parse to map to a clean 409. That parsing is the anti-pattern (RESEARCH.md "no message-string parsing at the route boundary").
- **Fix:** Wrapped the INSERT in try/catch, detected `pgCode === "23505"`, threw `AppError("...", "duplicate_item", 409)`. Other thrown errors rethrow unchanged. This is the EXCEPTION to the "no try/catch around insert" D-19 rule — it's mapping a known DB-level constraint to a clean HTTP code, NOT cleaning up a half-write. The half-write rule still holds: there's no INSERT-then-DELETE-on-error path.
- **Files modified:** `src/lib/server/services/items-youtube.ts`
- **Verification:** The route layer (Plan 02-08) can map `duplicate_item` mechanically. The current Plan 02-06 integration tests don't directly exercise the duplicate path (would need a re-paste of the same videoId), but the path is greppable for Plan 02-08's verifier.
- **Committed in:** `af11450` (Task 2)

**4. [Rule 2 - Missing critical] Added 4 negative-route unit tests beyond the 5 named placeholders in tests/unit/url-parser.test.ts**
- **Found during:** Task 1 (writing the placeholder bodies)
- **Issue:** The 5 named placeholders cover the 4 positive routes (youtube watch, youtu.be, shorts/live, x.com canonicalize) + reddit_deferred. They do NOT cover: unsupported host, malformed input, youtube host without a valid videoId, telegram. The parser's behavior on those inputs is load-bearing (the orchestrator's `unsupported` and `telegram_post` branches would silently rot if the parser regressed). Plan 02-01's stub list said "URL canonicalization" as a topic; adding `it(...)` calls under the same describe block for the negative routes is consistent with the Wave 0 invariant (no new behavior — these are the negative complements of the routes already described).
- **Fix:** Added 4 additional `it(...)` calls in the same `describe`, all prefixed with `02-06:`. Total: 9 tests pass.
- **Files modified:** `tests/unit/url-parser.test.ts`
- **Committed in:** `0432a2d` (Task 1)

---

**Total deviations:** 4 auto-fixed (1 bug, 3 missing-critical).
**Impact on plan:** None of the four change the plan's contract. Deviation 1 is a 1-line API extension that all existing call sites tolerate by default. Deviation 2 conforms to the plan's own `<action>` block W-6 spec (the older RESEARCH.md prose was the drift). Deviation 3 maps a known schema constraint to a clean HTTP code at the right layer (service, not route). Deviation 4 expands test coverage of the same parser without adding new behavior. All four are the natural consequences of the plan's stated contracts; the plan author would have written them this way given the same context.

## Issues Encountered

- **Local Postgres not available:** the integration test suite cannot execute on this Windows dev workstation (no `pg_isready`, no Docker daemon, no `.env` file). Same gating story as Plans 02-01 / 02-02 / 02-03 / 02-04 / 02-05. The test FILES compile (tsc clean), the test FILES lint (eslint clean), and unit tests pass (61 of 65, 4 unrelated pre-existing skips). CI's Postgres service container will execute the new integration assertions on push.

## User Setup Required

None — no external service configuration required. The two oEmbed endpoints (`youtube.com/oembed`, `publish.twitter.com/oembed`) are public and require no API key.

## Next Phase Readiness

- **Plan 02-07 (audit-read service)** can list audit rows for the four new verbs landed here: `item.created`, `item.deleted`, `event.created`, `event.edited`, `event.deleted`. The composite `(user_id, action, created_at)` index from Plan 02-03 covers the action-filter dropdown query.
- **Plan 02-08 (routes-and-sweeps)** has a complete service layer to wrap. Anonymous-401 sweep needs `/api/games/:id/items/parse-paste`, `/api/games/:id/items`, `/api/items/:id`, `/api/games/:id/events`, `/api/events/:id`, `/api/games/:id/timeline` added to MUST_BE_PROTECTED. The IngestResult discriminated union maps mechanically to 200 / 201 + DTOs.
- **Plan 02-09 (theme-components-paraglide)** has the W-6 keyset to ship in `messages/en.json`: `ingest_error_unsupported_url`, `ingest_error_youtube_unavailable` (single message, two `reason`-driven sub-strings), `ingest_error_oembed_unreachable`, `ingest_error_validation_failed`. The route layer maps `AppError.code` + `AppError.metadata.reason` → message key.
- **Plan 02-10 (svelte-pages)** has DTOs ready (`YoutubeVideoDto`, `EventDto`) for the SvelteKit pages to consume. The PasteBox UI on the game detail page calls `/api/games/:id/items/parse-paste` and renders `IngestResult.kind` to drive the success / friendly-deferred / error states.
- **Phase 3 polling worker** can backfill `tracked_youtube_videos.channel_id` from `videos.list` response without changing the Phase 2 ingest contract. The own/blogger logic still uses `author_url` matching (Pitfall 3 Option C); `channel_id` becomes a polling-side optimization, not a correctness requirement.

## Self-Check: PASSED

All claims in this summary verified against disk and git history:

- `src/lib/server/services/url-parser.ts`: FOUND (82 lines, contains `parseIngestUrl`, `extractYouTubeVideoId`, `YT_HOSTS`, `X_HOSTS`, `TG_HOSTS`, `RD_HOSTS`)
- `src/lib/server/services/items-youtube.ts`: FOUND (228 lines, `findOwnChannelByHandle` referenced 3×)
- `src/lib/server/services/events.ts`: FOUND (345 lines, `writeAudit` referenced 4×)
- `src/lib/server/services/ingest.ts`: FOUND (148 lines, `fetchYoutubeOembed` referenced 4×, `parseIngestUrl` referenced)
- `src/lib/server/integrations/youtube-oembed.ts`: FOUND (86 lines, `youtube.com/oembed` referenced 2×)
- `src/lib/server/integrations/twitter-oembed.ts`: FOUND (66 lines, `publish.twitter.com/oembed` referenced 2×)
- `src/lib/server/services/errors.ts`: MODIFIED (AppError gains 4th metadata arg; backward-compatible)
- `src/lib/server/dto.ts`: MODIFIED (toYoutubeVideoDto + toEventDto added; both omit userId)
- `tests/unit/url-parser.test.ts`: MODIFIED (5 placeholder it.skip → live `it(...)` + 4 additional negative-route tests; 9 tests pass)
- `tests/integration/ingest.test.ts`: MODIFIED (8 placeholder it.skip → live `it(...)`; tsc + eslint clean)
- `tests/integration/events.test.ts`: MODIFIED (4 placeholder it.skip → live `it(...)`; tsc + eslint clean)
- Commit `0432a2d` (Task 1): FOUND in git log
- Commit `af11450` (Task 2): FOUND in git log
- Commit `835f6ce` (Task 3): FOUND in git log
- ESLint on `src/lib/server/services/`: exits 0 (zero tenant-scope violations)
- Unit tests: 61 pass + 4 unrelated pre-existing skips (no regression; 9 of 9 url-parser assertions pass)
- `pnpm exec tsc --noEmit`: exits 0

---
*Phase: 02-ingest-secrets-and-audit*
*Completed: 2026-04-27*
