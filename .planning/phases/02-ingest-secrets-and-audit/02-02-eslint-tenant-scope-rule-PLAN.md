---
phase: 02-ingest-secrets-and-audit
plan: 02
type: execute
wave: 0
depends_on: []
files_modified:
  - eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js
  - eslint-plugin-tenant-scope/index.js
  - eslint-plugin-tenant-scope/package.json
  - eslint.config.js
  - tests/unit/tenant-scope-eslint-rule.test.ts
  - package.json
autonomous: true
requirements: []
requirements_addressed: []
must_haves:
  truths:
    - "ESLint flat config loads a local plugin `tenant-scope` and registers `no-unfiltered-tenant-query` as an `error`"
    - "Lint rejects `db.select().from(games).where(eq(games.id, gid))` (missing userId filter)"
    - "Lint accepts `db.select().from(games).where(and(eq(games.userId, userId), eq(games.id, gid)))`"
    - "Lint accepts queries against allowlisted tables (user, session, account, verification, subredditRules)"
    - "RuleTester unit suite passes for valid + invalid cases"
  artifacts:
    - path: "eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js"
      provides: "AST rule walking Drizzle .from(<TABLE>) calls"
      min_lines: 60
    - path: "eslint-plugin-tenant-scope/index.js"
      provides: "Plugin export with rules map"
      min_lines: 10
    - path: "eslint-plugin-tenant-scope/package.json"
      provides: "Local-package boilerplate so eslint.config.js can import via name"
      min_lines: 5
    - path: "eslint.config.js"
      provides: "Plugin registered + rule turned on for src/lib/server/services/**"
      contains: "tenant-scope/no-unfiltered-tenant-query"
    - path: "tests/unit/tenant-scope-eslint-rule.test.ts"
      provides: "RuleTester valid/invalid suite"
      min_lines: 40
  key_links:
    - from: "eslint.config.js"
      to: "eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js"
      via: "Plugin registration via local-package import"
      pattern: "tenant-scope.*no-unfiltered-tenant-query"
    - from: "tests/unit/tenant-scope-eslint-rule.test.ts"
      to: "eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js"
      via: "RuleTester import + run"
      pattern: "RuleTester.*\\bno-unfiltered-tenant-query\\b"
---

<objective>
Land the custom ESLint AST rule (D-38) `no-unfiltered-tenant-query` as a local plugin that fires on Drizzle queries against tenant-owned tables when no `userId` filter is present in `.where(...)`. Cross-cutting Wave 0 task: every later plan that writes a service file is checked by this rule, so it must exist before service code lands.

Purpose: Structural defense for Pattern 1 (PITFALL P1 — cross-tenant via missing tenant filter). Two-layer enforcement: this rule + the integration cross-tenant test (extended in plan 08).

Output: One local ESLint plugin (3 files), eslint.config.js wiring, one unit test file using `@typescript-eslint/rule-tester`. No new top-level deps needed — `@typescript-eslint/utils` is already a transitive dep via `@typescript-eslint/eslint-plugin@^8.12`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@eslint.config.js
@.planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md
@.planning/phases/02-ingest-secrets-and-audit/02-CONTEXT.md

<interfaces>
<!-- Drizzle 0.45.2 query method-chain shape (already in repo via Phase 1 services):

```typescript
db.select().from(table).where(and(eq(table.userId, uid), eq(table.id, rowId))).limit(1)
db.update(table).set({...}).where(...).returning(...)
db.delete(table).where(...)
db.insert(table).values({...}) — NOT covered by this rule (insert.values has userId in the literal)
```

Tenant-owned tables that ship in Phase 2 (Plan 03 creates the schema files):
  games, gameSteamListings, youtubeChannels, gameYoutubeChannels,
  apiKeysSteam, trackedYoutubeVideos, events, auditLog

Allowlist (NOT tenant-owned, should NOT trigger the rule):
  user, session, account, verification — Better Auth core (Better Auth manages its own scoping)
  subredditRules — Phase 5; non-tenant by design (shared seed data)

@typescript-eslint/utils RuleCreator API (verified against @typescript-eslint/eslint-plugin@^8.12 transitive):
```javascript
import { ESLintUtils } from "@typescript-eslint/utils";
const rule = ESLintUtils.RuleCreator.withoutDocs({ meta: {...}, defaultOptions: [], create(context) { return {...AST visitors} } });
```

@typescript-eslint/rule-tester API:
```javascript
import { RuleTester } from "@typescript-eslint/rule-tester";
const tester = new RuleTester({});
tester.run("rule-name", rule, { valid: [...], invalid: [{code, errors:[{messageId}]}] });
```
-->
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Create the local ESLint plugin (rule + index + package.json) and register in eslint.config.js</name>
  <files>eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js, eslint-plugin-tenant-scope/index.js, eslint-plugin-tenant-scope/package.json, eslint.config.js, package.json</files>
  <read_first>
    - eslint.config.js (current flat-config — confirms ESM flat-config style, the existing `no-restricted-properties` rule for env discipline, and where to add a new plugin entry)
    - package.json (confirms `@typescript-eslint/eslint-plugin` + `@typescript-eslint/parser` versions; NO new top-level deps needed — `@typescript-eslint/utils` is transitive)
    - .planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md §"ESLint AST tenant-scope rule (D-38)" lines 731–826 (full AST sketch, allowlist, RuleTester examples — copy this verbatim into the rule file)
  </read_first>
  <behavior>
    - Rule fires on `CallExpression` where `node.callee.property.name === "from"` and `node.arguments[0]` is an Identifier in TENANT_TABLES.
    - Walks back up the chain to the surrounding expression, then checks if any `.where(...)` call in the chain text contains the literal `userId`. If not, reports `missingUserIdFilter`.
    - Allowlisted identifiers (`user`, `session`, `account`, `verification`, `subredditRules`) bypass the rule.
    - The rule treats `tx.select().from(<TENANT>)` identically to `db.select().from(<TENANT>)` — both `db` and `tx` chains are caught (tx is the Drizzle transaction-binding identifier in services).
  </behavior>
  <action>
    **A. Create `eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js`** with this exact content (verbatim from RESEARCH.md §"ESLint AST tenant-scope rule (D-38)" lines 731–793):

    ```javascript
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

    const TENANT_TABLES = new Set([
      "games",
      "gameSteamListings",
      "youtubeChannels",
      "gameYoutubeChannels",
      "apiKeysSteam",
      "trackedYoutubeVideos",
      "events",
      "auditLog",
    ]);

    const ALLOWLIST_TABLES = new Set([
      "subredditRules",  // Phase 5 — non-tenant by design (shared seed data)
      "user",            // Better Auth core
      "session",         // Better Auth core
      "account",         // Better Auth core
      "verification",    // Better Auth core
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
              node.callee.property.type === "Identifier"
                ? node.callee.property.name
                : null;
            if (propName !== "from") return;
            const arg = node.arguments[0];
            if (!arg || arg.type !== "Identifier") return;
            if (ALLOWLIST_TABLES.has(arg.name)) return;
            if (!TENANT_TABLES.has(arg.name)) return;

            // Walk up to find the surrounding chained expression (statement scope).
            let chain = node.parent;
            while (chain && chain.type === "MemberExpression") {
              chain = chain.parent;
            }
            // Walk further if the chain ends inside a CallExpression / await.
            while (
              chain &&
              (chain.type === "CallExpression" ||
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

            let chain = node.parent;
            while (chain && chain.type === "MemberExpression") {
              chain = chain.parent;
            }
            while (
              chain &&
              (chain.type === "CallExpression" ||
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
    ```

    **B. Create `eslint-plugin-tenant-scope/index.js`**:

    ```javascript
    import noUnfilteredTenantQuery from "./no-unfiltered-tenant-query.js";

    export default {
      rules: {
        "no-unfiltered-tenant-query": noUnfilteredTenantQuery,
      },
    };
    ```

    **C. Create `eslint-plugin-tenant-scope/package.json`**:

    ```json
    {
      "name": "eslint-plugin-tenant-scope",
      "version": "0.0.0",
      "type": "module",
      "main": "./index.js",
      "private": true
    }
    ```

    **D. Add the plugin to `package.json`** as a workspace-style local link. Append `"eslint-plugin-tenant-scope": "link:./eslint-plugin-tenant-scope"` to the `devDependencies` block (preserve sort order if the file is sorted alphabetically). Then run `pnpm install` to materialize the link.

    **E. Edit `eslint.config.js`** (existing flat-config). Add at the top:
    ```javascript
    import tenantScope from "./eslint-plugin-tenant-scope/index.js";
    ```
    Then add a config block (after the existing TS configs) that registers the plugin and turns the rule on for service files:
    ```javascript
    {
      files: ["src/lib/server/services/**/*.ts", "src/lib/server/services/**/*.tsx"],
      plugins: {
        "tenant-scope": tenantScope,
      },
      rules: {
        "tenant-scope/no-unfiltered-tenant-query": "error",
      },
    },
    ```

    Severity is `error` — services that miss userId fail lint. Disable comments require `--` justification per Pitfall 7.
  </action>
  <verify>
    <automated>pnpm exec eslint --no-eslintrc -c eslint.config.js --rule "tenant-scope/no-unfiltered-tenant-query: error" --stdin --stdin-filename=src/lib/server/services/x.ts <<< 'import { db } from "../db/client.js"; import { games } from "../db/schema/games.js"; import { eq } from "drizzle-orm"; export async function f(gid: string) { return db.select().from(games).where(eq(games.id, gid)); }' 2>&1 | grep -q "no-unfiltered-tenant-query" && echo "rule fires on missing userId" || (echo "RULE DID NOT FIRE"; exit 1)</automated>
  </verify>
  <done>
    - `eslint-plugin-tenant-scope/` directory exists with rule + index + package.json.
    - `eslint.config.js` imports and registers the plugin; the rule is `error` on `src/lib/server/services/**`.
    - `package.json` carries the link: dep; `pnpm install` succeeded.
    - Manual lint run on a stub service file with `db.select().from(games).where(eq(games.id, gid))` (no userId) reports the rule violation; same query with `where(and(eq(games.userId, userId), eq(games.id, gid)))` does NOT report.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: RuleTester unit suite for the AST rule</name>
  <files>tests/unit/tenant-scope-eslint-rule.test.ts</files>
  <read_first>
    - eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js (the rule produced by Task 1; this test imports it directly)
    - .planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md §"ESLint AST tenant-scope rule (D-38)" lines 794–826 (RuleTester sketch — adapt to vitest by wrapping `tester.run` inside `describe`/`it`)
    - tests/unit/dto.test.ts (Phase 1 unit-test style — vitest describe/it, async/sync mix)
  </read_first>
  <behavior>
    Test cases:

    Valid (rule should NOT fire):
    1. `db.select().from(games).where(and(eq(games.userId, userId), eq(games.id, gid)))` — explicit userId filter.
    2. `db.select().from(user).where(eq(user.id, sessionUserId))` — Better Auth allowlisted table.
    3. `tx.update(events).set({deletedAt}).where(and(eq(events.userId, userId), eq(events.gameId, gameId)))` — tx variant works.
    4. `db.delete(apiKeysSteam).where(and(eq(apiKeysSteam.userId, userId), eq(apiKeysSteam.id, keyId)))` — delete variant.
    5. `db.select().from(subredditRules).where(eq(subredditRules.id, rid))` — Phase 5 allowlisted table.

    Invalid (rule MUST fire with messageId `missingUserIdFilter`):
    1. `db.select().from(games).where(eq(games.id, gid))` — missing userId.
    2. `db.select().from(events)` — no .where at all.
    3. `db.update(apiKeysSteam).set({}).where(eq(apiKeysSteam.id, keyId))` — update missing userId.
    4. `db.delete(trackedYoutubeVideos).where(eq(trackedYoutubeVideos.id, vid))` — delete missing userId.
    5. `db.select().from(youtubeChannels).where(eq(youtubeChannels.handleUrl, h))` — select with where but missing userId.
  </behavior>
  <action>
    Create `tests/unit/tenant-scope-eslint-rule.test.ts`:

    ```typescript
    import { describe, it } from "vitest";
    import { RuleTester } from "@typescript-eslint/rule-tester";
    import rule from "../../eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js";

    // Wire RuleTester to vitest's it/describe.
    RuleTester.afterAll = () => {};
    RuleTester.it = it;
    RuleTester.itOnly = it.only;
    RuleTester.describe = describe;

    const tester = new RuleTester({
      languageOptions: {
        parser: await import("@typescript-eslint/parser"),
      },
    });

    tester.run("no-unfiltered-tenant-query", rule, {
      valid: [
        // Has userId filter
        `db.select().from(games).where(and(eq(games.userId, userId), eq(games.id, gid)))`,
        // Allowlisted Better Auth table
        `db.select().from(user).where(eq(user.id, sessionUserId))`,
        // tx variant (transaction binding)
        `tx.update(events).set({deletedAt}).where(and(eq(events.userId, userId), eq(events.gameId, gameId)))`,
        // delete with userId
        `db.delete(apiKeysSteam).where(and(eq(apiKeysSteam.userId, userId), eq(apiKeysSteam.id, keyId)))`,
        // Phase 5 allowlisted table
        `db.select().from(subredditRules).where(eq(subredditRules.id, rid))`,
      ],
      invalid: [
        {
          code: `db.select().from(games).where(eq(games.id, gid))`,
          errors: [{ messageId: "missingUserIdFilter", data: { table: "games" } }],
        },
        {
          code: `db.select().from(events)`,
          errors: [{ messageId: "missingUserIdFilter", data: { table: "events" } }],
        },
        {
          code: `db.update(apiKeysSteam).set({label:'x'}).where(eq(apiKeysSteam.id, keyId))`,
          errors: [{ messageId: "missingUserIdFilter", data: { table: "apiKeysSteam" } }],
        },
        {
          code: `db.delete(trackedYoutubeVideos).where(eq(trackedYoutubeVideos.id, vid))`,
          errors: [{ messageId: "missingUserIdFilter", data: { table: "trackedYoutubeVideos" } }],
        },
        {
          code: `db.select().from(youtubeChannels).where(eq(youtubeChannels.handleUrl, h))`,
          errors: [{ messageId: "missingUserIdFilter", data: { table: "youtubeChannels" } }],
        },
      ],
    });
    ```

    Note: `@typescript-eslint/rule-tester` is a transitive dep via `@typescript-eslint/eslint-plugin@^8.12`; if pnpm complains about the import path, the planner must fall back to bundling RuleTester via the `@typescript-eslint/utils` package (`import { RuleTester } from "@typescript-eslint/utils/ts-eslint"`) — try this fallback if the primary import fails at type-check.
  </action>
  <verify>
    <automated>pnpm exec vitest run tests/unit/tenant-scope-eslint-rule.test.ts --reporter=verbose 2>&1 | tail -30</automated>
  </verify>
  <done>
    `pnpm exec vitest run tests/unit/tenant-scope-eslint-rule.test.ts` reports 10 passing assertions (5 valid + 5 invalid). No skipped, no flaky. The rule's `messageId: "missingUserIdFilter"` matches all 5 invalid cases. The rule plugin is now load-bearing and any later plan that drops a userId filter fails CI lint.
  </done>
</task>

</tasks>

<verification>
- `pnpm exec eslint src/` succeeds (Phase 1 service files all carry userId filters; if any Phase 1 query is missing the filter, the rule has caught a real bug — fix it in this same plan or surface in PR body as "Phase 1 leak found").
- `pnpm exec vitest run tests/unit/tenant-scope-eslint-rule.test.ts` is green.
- `grep -c "tenant-scope/no-unfiltered-tenant-query" eslint.config.js` >= 1.
- `cat package.json | grep -c "eslint-plugin-tenant-scope"` >= 1.
</verification>

<success_criteria>
- `eslint-plugin-tenant-scope/` exists as a local linked package with rule, index, and package.json.
- `eslint.config.js` registers the plugin and turns the rule on as `error` for `src/lib/server/services/**`.
- The rule catches `db.select().from(<tenant_table>)` / `db.update(<tenant_table>)` / `db.delete(<tenant_table>)` without a `.where()` containing `userId` — no false positives on Better Auth allowlisted tables (`user`, `session`, `account`, `verification`) or Phase 5 `subredditRules`.
- RuleTester unit suite is green (5 valid + 5 invalid).
- No new top-level deps; `@typescript-eslint/utils` and `@typescript-eslint/rule-tester` resolve via existing transitive deps.
</success_criteria>

<output>
After completion, create `.planning/phases/02-ingest-secrets-and-audit/02-02-SUMMARY.md` summarizing the plugin layout, the rule's TENANT_TABLES + ALLOWLIST sets, and any Phase 1 source-file lint violations the rule surfaced (if any).
</output>
