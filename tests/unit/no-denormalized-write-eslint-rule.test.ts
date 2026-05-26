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
    // B-10: audit forensic snapshot — by AGENTS.md design the audit_log
    // is INSERT-only and IS allowed to snapshot display names at the
    // time of the action (the row's purpose is "what was true at the
    // time"). \`event_title\` is the snake_case event-title snapshot;
    // SUSPICIOUS_NAME_RE only matches camelCase Title at end-of-string
    // (and bare \`title\` / \`name\` whole-name). Verifies the rule
    // doesn't false-positive on audit snapshots.
    `writeAudit({ metadata: { event_title: "snapshot of event title at action time" } })`,
    // B-10: intrinsic channel-side identifier. \`uploads_playlist_id\` is
    // not renameable (YouTube assigns it; it's part of the channel
    // record key) and lives inside metadata alongside other intrinsic
    // fields. Verifies the rule scopes to display-name shapes only.
    `({ metadata: { uploads_playlist_id: "UU_abc123" } })`,
    // B-10: own-row timestamp inside metadata — last_user_refresh_at,
    // last_polled_at and similar are own-row state, not denorms. Covered
    // alongside the snake_case audit fields above but kept separate so
    // a future maintainer adding a new own-row metadata timestamp has
    // a clear precedent for adding it here.
    `({ metadata: { last_user_refresh_at: new Date().toISOString() } })`,
    // B-10: subreddit slug is intrinsic to the canonical Reddit URL
    // (/r/<sub>); Reddit forbids rename. Already covered above next to
    // channelId; restated as a standalone case so the OK-INTRINSIC
    // category is visible to a reader skimming the test.
    `({ metadata: { subreddit: "IndieGaming" } })`,
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
