import { describe, it } from "vitest";
import { RuleTester } from "@typescript-eslint/utils/ts-eslint";
import tsParser from "@typescript-eslint/parser";
// Load rule from the local eslint-rules folder so this test pins to
// the source file (matching the tenant-scope rule test convention).
import rule from "../../eslint-rules/no-denormalized-write.js";

// Wire RuleTester to vitest's it/describe — same shim the tenant-scope
// test uses (see tests/unit/tenant-scope-eslint-rule.test.ts).
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

tester.run("no-denormalized-write", rule, {
  valid: [
    // Plain own-row column writes (no metadata segment) — fine.
    `row.title = "x";`,
    `row.channelTitle = "x";`,
    // Object literal write to a regular column field — fine.
    `({ title: "x" })`,
    // Intrinsic-to-URL identifier inside metadata is acceptable per
    // AGENTS.md OK-INTRINSIC exemption (subreddit slug, channelId).
    // The rule's stoplist does not flag these names; this is the
    // negative-coverage assertion.
    `({ metadata: { subreddit: "askreddit", channelId: "UC123" } })`,
    // Last_polled_at, refresh_at, status flags — own-row state.
    `({ metadata: { last_user_refresh_at: now, status: "ok" } })`,
    // Non-stoplist field in metadata — fine.
    `({ metadata: { externalUrl: "http://x" } })`,
  ],
  invalid: [
    // Direct assignment shape — row.metadata.channelTitle = "..."
    {
      code: `row.metadata.channelTitle = "Rick Astley";`,
      errors: [{ messageId: "likelyDenorm" }],
    },
    // Object-literal shape inside a metadata wrapper — the canonical
    // shape AddEventForm's comment warns against.
    {
      code: `({ metadata: { channelTitle: "Rick Astley" } })`,
      errors: [{ messageId: "likelyDenorm" }],
    },
    // displayName variant.
    {
      code: `({ metadata: { displayName: "@rickastley" } })`,
      errors: [{ messageId: "likelyDenorm" }],
    },
    // Generic Title-suffixed field name.
    {
      code: `({ metadata: { gameTitle: "Half-Life 3" } })`,
      errors: [{ messageId: "likelyDenorm" }],
    },
  ],
});
