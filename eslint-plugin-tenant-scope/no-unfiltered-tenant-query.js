/**
 * Custom ESLint rule (Plan 02-02 — Phase 2 Wave 0).
 *
 * SCOPE — what this rule enforces:
 *   This rule enforces tenant scoping (`eq(<table>.userId, ...)`) on Drizzle
 *   SELECT / UPDATE / DELETE queries against tenant-owned tables. It is the
 *   STRUCTURAL half of the two-layer Pattern 1 defense; the integration test
 *   `tests/integration/tenant-scope.test.ts` is the BEHAVIORAL half.
 *
 * SCOPE — what this rule does NOT enforce:
 *   This rule does NOT enforce audit-log append-only semantics. The audit
 *   append-only invariant (no `.update()` / `.delete()` against `auditLog`,
 *   no `update*` / `delete*` exports from `src/lib/server/audit.ts`) is asserted
 *   by `tests/unit/audit-append-only.test.ts` (Plan 02-07). The two invariants
 *   share the same family of risks (PITFALL P19) but have different surfaces
 *   and different enforcement layers — keep them mentally separated.
 *
 * SCOPE — what this rule does NOT enforce (continued):
 *   - DTO ciphertext-strip (D-39 / P3) — enforced by `tests/unit/dto.test.ts`.
 *   - Anonymous-401 sweep — enforced by `tests/integration/anonymous-401.test.ts`.
 *   - Cross-tenant 404 (not 403) at the route boundary — enforced by
 *     `tests/integration/tenant-scope.test.ts` body-string checks.
 */
// Catches Drizzle queries against tenant-owned tables that omit the
// mandatory `userId` filter (Pattern 1 — PITFALL P1 cross-tenant leak).
// The rule is structural — it walks the .from(<TABLE>) call site and
// checks the surrounding chain text for `.where(...userId...)`.
// It is COMPLEMENTARY to the integration cross-tenant test (which catches
// BEHAVIORAL drift) — neither alone suffices.
//
// Allowlisted tables (NOT tenant-owned):
//   - Better Auth core: user, session, account, verification (Better Auth
//     manages its own scoping; queries here use sessionId / accountId).
//   - Phase 5 subredditRules: shared seed data (curated rule cache).
//
// Disable comments must include a justification per the convention in
// AGENTS.md (Pitfall 7 of RESEARCH.md):
//   // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- caller scope guarantee in services/X
//
// PRs that add a disable comment without `--` justification fail review.

import { ESLintUtils } from "@typescript-eslint/utils";

// Phase 2.1 (Plan 02.1-01): unified `dataSources` replaces the per-platform
// `youtubeChannels` / `gameYoutubeChannels` / `trackedYoutubeVideos` trio.
// `events` carries forward; `gameSteamListings` / `apiKeysSteam` / `games` /
// `auditLog` unchanged from Phase 2.
const TENANT_TABLES = new Set([
  "games",
  "gameSteamListings",
  "dataSources",
  "apiKeysSteam",
  "events",
  "auditLog",
]);

const ALLOWLIST_TABLES = new Set([
  "subredditRules", // Phase 5 — non-tenant by design (shared seed data)
  "user", // Better Auth core
  "session", // Better Auth core
  "account", // Better Auth core
  "verification", // Better Auth core
]);

export default ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: "problem",
    messages: {
      missingUserIdFilter:
        "Drizzle query on tenant-owned table '{{table}}' must include a userId filter in .where(...) (Pattern 1; PITFALL P1)",
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
