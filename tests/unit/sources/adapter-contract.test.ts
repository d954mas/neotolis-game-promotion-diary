import { describe, it, expectTypeOf } from "vitest";
import type {
  DataSourceAdapter,
  ParsedSourceUrl,
  AdapterUserQuotaCap,
  ObservabilityAuth,
  SourceKind,
} from "$lib/sources/adapter.js";

// Phase 03.1 plan 01-01: contract widenings for the Reddit adapter (DV-RDT-7).
//
//  1. `ParsedSourceUrl` — new exported type. Drives /sources/new auto-detect
//     when one input shape maps to multiple SourceKinds (Reddit:
//     reddit.com/user/X → reddit_account; reddit.com/r/X → reddit_subreddit).
//  2. `DataSourceAdapter.parseSourceUrl?(input)` — optional method; YouTube
//     adapter intentionally does NOT implement it (canonicalizeOnCreate
//     handles its single-SourceKind case).
//  3. `AdapterUserQuotaCap` — three new optional fields for Reddit's
//     two-axis sliding-window cap (1 source-action / 5 min + 25 post-refreshes
//     / 5 min).
//  4. `ObservabilityAuth.kind` — adds the `"public-json-no-auth"` literal
//     for adapters that hit unauthenticated `.json` endpoints (Reddit DV-RDT-7).
//
// All widenings are ADDITIVE. The YouTube adapter does NOT need a source
// change — these tests double as the non-breaking-change guard. If
// `pnpm typecheck` fails after editing adapter.ts, the widenings broke
// the existing surface.
describe("Phase 03.1 contract widenings", () => {
  it("ParsedSourceUrl shape is { kind: SourceKind; handle: string; externalUrl: string }", () => {
    expectTypeOf<ParsedSourceUrl>().toEqualTypeOf<{
      kind: SourceKind;
      handle: string;
      externalUrl: string;
    }>();
  });

  it("parseSourceUrl is optional on DataSourceAdapter", () => {
    type WithoutParse = Omit<DataSourceAdapter, "parseSourceUrl">;
    expectTypeOf<DataSourceAdapter["parseSourceUrl"]>().toEqualTypeOf<
      ((input: string) => ParsedSourceUrl | null) | undefined
    >();
    // WithoutParse must still be a valid adapter shape (legacy YouTube path).
    const _unused: WithoutParse = {} as DataSourceAdapter;
    void _unused;
  });

  it("AdapterUserQuotaCap accepts Reddit two-axis fields alongside YouTube fields", () => {
    const _youtube: AdapterUserQuotaCap = { requestsPerDay: 1000, eventsPerDay: 200 };
    const _reddit: AdapterUserQuotaCap = {
      sourceActionsPerWindow: 1,
      postRefreshesPerWindow: 25,
      windowMinutes: 5,
    };
    const _both: AdapterUserQuotaCap = {
      requestsPerDay: 50,
      sourceActionsPerWindow: 1,
      windowMinutes: 5,
    };
    const _empty: AdapterUserQuotaCap = {};
    void _youtube;
    void _reddit;
    void _both;
    void _empty;
  });

  it("ObservabilityAuth.kind accepts public-json-no-auth", () => {
    const _auth: ObservabilityAuth = {
      kind: "public-json-no-auth",
      requiresUserSetup: false,
      isOperatorConfigured: true,
    };
    void _auth;
  });
});
