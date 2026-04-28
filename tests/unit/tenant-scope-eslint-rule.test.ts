import { describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/utils/ts-eslint";
import tsParser from "@typescript-eslint/parser";
// Importing the rule from the linked plugin via relative path so this test
// stays load-bearing on the source file rather than the published surface.
import rule from "../../eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js";

// Wire RuleTester to vitest's it/describe so failures surface as ordinary
// test failures instead of throwing out of the suite. `afterAll` is a hook
// only the standalone `@typescript-eslint/rule-tester` package looks for; the
// deprecated re-export from `@typescript-eslint/utils/ts-eslint` ignores it,
// but assigning a no-op is harmless and keeps both APIs compatible.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(RuleTester as any).afterAll = () => {};
RuleTester.it = it as unknown as typeof RuleTester.it;
RuleTester.itOnly = it.only as unknown as typeof RuleTester.itOnly;
RuleTester.describe = describe as unknown as typeof RuleTester.describe;

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any);

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
    // Phase 2.1 dataSources select with userId filter
    `db.select().from(dataSources).where(and(eq(dataSources.userId, userId), eq(dataSources.id, sid)))`,
    // Phase 2.1 dataSources update with userId filter (mirrors Phase 2 single-loop chain walker)
    `tx.update(dataSources).set({autoImport:true}).where(and(eq(dataSources.userId, userId), eq(dataSources.id, sid)))`,
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
    // Phase 2.1: dataSources select without userId filter trips the rule.
    {
      code: `db.select().from(dataSources).where(eq(dataSources.id, sid))`,
      errors: [{ messageId: "missingUserIdFilter", data: { table: "dataSources" } }],
    },
    // Phase 2.1: dataSources update form without userId filter trips the rule
    // (mirrors Phase 2 fix to the single-loop chain walker).
    {
      code: `tx.update(dataSources).set({autoImport:true}).where(eq(dataSources.id, sid))`,
      errors: [{ messageId: "missingUserIdFilter", data: { table: "dataSources" } }],
    },
  ],
});
