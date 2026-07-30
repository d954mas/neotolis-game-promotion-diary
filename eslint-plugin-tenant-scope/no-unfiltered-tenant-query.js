/**
 * Custom ESLint rule.
 *
 * SCOPE — what this rule enforces:
 *   This rule enforces tenant scoping (`eq(<table>.userId, ...)`) on Drizzle
 *   SELECT / UPDATE / DELETE queries against tenant-owned tables. It is the
 *   STRUCTURAL half of the two-layer tenant-scope defense; the integration
 *   test `tests/integration/tenant-scope.test.ts` is the BEHAVIORAL half.
 *
 * SCOPE — what this rule does NOT enforce:
 *   This rule does NOT enforce audit-log append-only semantics. The audit
 *   append-only invariant (no `.update()` / `.delete()` against `auditLog`,
 *   no `update*` / `delete*` exports from `src/lib/server/audit.ts`) is
 *   asserted by `tests/unit/audit-append-only.test.ts`. The two invariants
 *   share the same family of risks but have different surfaces and
 *   different enforcement layers — keep them mentally separated.
 *
 *   Other related guarantees enforced elsewhere:
 *   - DTO ciphertext-strip — enforced by `tests/unit/dto.test.ts`.
 *   - Anonymous-401 sweep — enforced by `tests/integration/anonymous-401.test.ts`.
 *   - Cross-tenant 404 (not 403) at the route boundary — enforced by
 *     `tests/integration/tenant-scope.test.ts` body-string checks.
 */
// Catches Drizzle queries against tenant-owned tables that omit the
// mandatory `userId` filter (cross-tenant leak prevention).
// The rule is structural — it walks the .from(<TABLE>) call site and
// checks the surrounding chain text for `.where(...userId...)`.
// It is COMPLEMENTARY to the integration cross-tenant test (which catches
// BEHAVIORAL drift) — neither alone suffices.
//
// Allowlisted tables (NOT tenant-owned):
//   - Better Auth core: user, session, account, verification (Better Auth
//     manages its own scoping; queries here use sessionId / accountId).
//   - subredditRules: shared seed data (curated rule cache).
//
// Disable comments must include a justification per the convention in
// AGENTS.md:
//   // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- caller scope guarantee in services/X
//
// PRs that add a disable comment without `--` justification fail review.

import { ESLintUtils } from "@typescript-eslint/utils";

// `eventGames` is the M:N junction with userId denormalized so this rule
// can require a userId WHERE clause on every Drizzle query (the rule
// cannot inspect FK-chained values).
//
// `adapterRefreshQueue` is a hybrid: service lanes (queue_name LIKE
// 'service_%') write `user_id=NULL` and ARE cross-tenant by design;
// user lanes (queue_name LIKE 'user_%') write `user_id NOT NULL` and
// are tenant data feeding per-user quota counters + purge cascades.
// Treating it as a tenant table makes the default-safe choice — any
// query without `eq(.userId, userId)` MUST opt out explicitly with
// `eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query --
// service-lane scan / cross-tenant operator view`. Pre-fix the table
// was blanket-allowlisted so a future bug reading user-lane rows
// without userId would slip past.
// Exported (named) so the D-08 export-completeness drift guard
// (tests/unit/export-completeness.test.ts) reads the SAME set this rule
// enforces — one source of truth for "what is a tenant table". A new
// tenant table added here without a matching AccountExportEnvelope key (or
// an explicit exclusion) fails that test. The default export below is the
// ESLint rule; a named export alongside it does not affect rule loading.
export const TENANT_TABLES = new Set([
  "games",
  "gameSteamListings",
  "dataSources",
  "apiKeysSteam",
  "events",
  "eventGames",
  "auditLog",
  "adapterRefreshQueue",
  "wishlistSnapshots", // commercially-sensitive per-user wishlist data (D-06) — tenant-scoped, NOT public like youtubeVideoSnapshots
]);

export const ALLOWLIST_TABLES = new Set([
  "subredditRules", // non-tenant by design (shared seed data)
  "user", // Better Auth core
  "session", // Better Auth core
  "account", // Better Auth core
  "verification", // Better Auth core
  // Public external data, no tenant scope.
  //
  // These tables hold YouTube public-data shared across tenants by video_id
  // / channel_id and operator-side quota counters keyed on (date_pacific,
  // api_key_id). The events table that REFERENCES this data remains
  // tenant-owned (events.user_id) — the snapshot / cache / quota rows
  // themselves are public statistics or operator-side state. Anyone with
  // `events.external_id = X` for video X sees the same view count
  // history. Re-validating tenant scope on these tables would force a
  // useless join.
  //
  // The allowlist entries here are explicit-intent documentation: queries
  // against these identifiers do not currently trip the rule (they're not
  // in TENANT_TABLES) but if a future refactor accidentally adds them to
  // TENANT_TABLES, the allowlist is the explicit override that keeps the
  // public-data semantic legible to reviewers.
  "youtubeVideoSnapshots",
  "youtubeChannels",
  "youtubeServiceQuotaUsage",
  // Public-data cache for video metadata (title / description / channel
  // info). Same semantics as youtubeChannels — keyed on video_id, no
  // user_id, shared across all tenants who ever reference this video.
  "youtubeVideos",
  // Phase 12 Reddit public-data tables (no user_id by design — ScrapeCreators
  // rebuild). Same public-data semantics as the YouTube/IG/TikTok caches: post
  // score / comment count / subreddit subscribers are identical regardless of
  // which tenant looked them up. NOTE: `adapterRefreshQueue` is intentionally
  // NOT here — it lives in TENANT_TABLES because user lanes carry user_id;
  // cross-tenant scans (service lanes) must opt out with an inline
  // `eslint-disable-next-line ... -- …` justification per call-site.
  "redditAccounts", // public external data, no tenant scope (account subject entity)
  "redditSubreddits", // public external data, no tenant scope (subreddit subject entity)
  "redditPosts", // public external data, no tenant scope
  "redditPostSnapshots", // public external data, no tenant scope (time-series)
  // Phase 8 Instagram + social-provider public-data / operator-state tables
  // (no user_id by design — same public-data semantics as the YouTube cache:
  // a post's play/like/comment counts are identical regardless of which
  // tenant looked them up; the operator spend/balance rows are operator-side
  // state keyed by platform/provider, not tenant data).
  "instagramAccounts", // public external data, no tenant scope (account subject entity)
  "instagramPosts", // public external data, no tenant scope
  "instagramPostSnapshots", // public external data, no tenant scope (time-series)
  "socialProviderSpend", // operator-side spend counter, no tenant scope
  "socialProviderBalance", // operator prepaid-balance ceiling row, keyed by platform/provider — quota.ts queries it un-tenant-scoped
  // Phase 9 Telegram public-data tables (no user_id by design — a channel
  // post's view count is identical regardless of which tenant looked it up).
  "telegramChannels", // public external data, no tenant scope (channel subject entity)
  "telegramPosts", // public external data, no tenant scope
  "telegramPostSnapshots", // public external data, no tenant scope (time-series)
  "telegramPacer", // singleton rate-limit-token row, no tenant scope
  // Phase 10 TikTok public-data tables (no user_id by design — a video's
  // view/like/comment/share count is identical regardless of which tenant
  // looked it up; same public-data semantics as the YouTube/IG/Telegram caches).
  "tiktokAccounts", // public external data, no tenant scope (account subject entity)
  "tiktokPosts", // public external data, no tenant scope
  "tiktokPostSnapshots", // public external data, no tenant scope (time-series)
  // Phase 11 Twitter/X public-data tables (no user_id by design — a tweet's
  // view/like/comment/share count is identical regardless of which tenant
  // looked it up; same public-data semantics as the YouTube/IG/Telegram/TikTok
  // caches).
  "twitterAccounts", // public external data, no tenant scope (account subject entity)
  "twitterPosts", // public external data, no tenant scope
  "twitterPostSnapshots", // public external data, no tenant scope (time-series)
  "twitterPacer", // singleton rate-limit-token row, no tenant scope (parity with redditPacer/telegramPacer)
]);

export default ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: "problem",
    messages: {
      missingUserIdFilter:
        "Drizzle query on tenant-owned table '{{table}}' must include a userId filter in .where(...)",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        // Match `.from(<TABLE>)`
        if (node.callee.type !== "MemberExpression") return;
        const propName =
          node.callee.property.type === "Identifier" ? node.callee.property.name : null;
        if (propName !== "from") return;
        const arg = node.arguments[0];
        if (!arg || arg.type !== "Identifier") return;
        if (ALLOWLIST_TABLES.has(arg.name)) return;
        if (!TENANT_TABLES.has(arg.name)) return;

        // Walk up the surrounding chained expression to the outermost call so
        // `.where(...)` (which sits OUTSIDE this `.from(...)` / `.update(...)`
        // node) is captured in the chain text. Drizzle chains alternate
        // CallExpression -> MemberExpression -> CallExpression... so a single
        // loop that consumes all three node kinds is the only correct walk.
        let chain = node.parent;
        while (
          chain &&
          (chain.type === "MemberExpression" ||
            chain.type === "CallExpression" ||
            chain.type === "AwaitExpression")
        ) {
          chain = chain.parent;
        }

        const sourceCode = context.sourceCode;
        const chainText = sourceCode.getText(chain ?? node);
        // Match .where(...) that contains the identifier `userId`.
        if (!/\.where\s*\(\s*[\s\S]*?\buserId\b[\s\S]*?\)/.test(chainText)) {
          context.report({
            node,
            messageId: "missingUserIdFilter",
            data: { table: arg.name },
          });
        }
      },
      // Match `db.update(<TABLE>)` and `db.delete(<TABLE>)` — same logic.
      // For these calls the table is `node.arguments[0]` and the chain MUST
      // also contain a userId-bearing .where(...).
      // Note: `db.insert(<TABLE>)` is intentionally NOT checked because
      // .values({...}) carries `userId` literally in the inserted row.
      ":matches(CallExpression[callee.property.name='update'], CallExpression[callee.property.name='delete'])"(
        node,
      ) {
        if (node.callee.type !== "MemberExpression") return;
        const arg = node.arguments[0];
        if (!arg || arg.type !== "Identifier") return;
        if (ALLOWLIST_TABLES.has(arg.name)) return;
        if (!TENANT_TABLES.has(arg.name)) return;

        // See update/delete branch comment above — single ping-pong walk.
        let chain = node.parent;
        while (
          chain &&
          (chain.type === "MemberExpression" ||
            chain.type === "CallExpression" ||
            chain.type === "AwaitExpression")
        ) {
          chain = chain.parent;
        }

        const sourceCode = context.sourceCode;
        const chainText = sourceCode.getText(chain ?? node);
        if (!/\.where\s*\(\s*[\s\S]*?\buserId\b[\s\S]*?\)/.test(chainText)) {
          context.report({
            node,
            messageId: "missingUserIdFilter",
            data: { table: arg.name },
          });
        }
      },
    };
  },
});
