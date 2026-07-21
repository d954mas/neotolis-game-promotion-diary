// The D-08 ISOLATION GATE — the HIGH-RISK behavior (B) of Phase 12, flipped live
// by Plan 12-03. Reddit REUSES the shared SCRAPECREATORS_API_KEY (the same key
// that enables IG + TikTok), so the whole point of D-08 is that the shared key
// can NEVER auto-enable Reddit: REDDIT_IMPORT_ENABLED is an INDEPENDENT AND-term
// checked FIRST. This property test is the T-12-03-E mitigation + success
// criterion #2.
//
// No DB, no HTTP — pure provider-selection over env combinations.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "$lib/server/config/env.js";
import { getSocialProvider } from "$lib/sources/social-provider-registry.js";

type MutableEnv = {
  REDDIT_IMPORT_ENABLED: "true" | "false";
  REDDIT_PROVIDER: "scrapecreators" | "";
  SCRAPECREATORS_API_KEY: string;
  INSTAGRAM_PROVIDER: string;
};
const envMut = env as unknown as MutableEnv;

let original: MutableEnv;

beforeEach(() => {
  original = {
    REDDIT_IMPORT_ENABLED: envMut.REDDIT_IMPORT_ENABLED,
    REDDIT_PROVIDER: envMut.REDDIT_PROVIDER,
    SCRAPECREATORS_API_KEY: envMut.SCRAPECREATORS_API_KEY,
    INSTAGRAM_PROVIDER: envMut.INSTAGRAM_PROVIDER,
  };
});

afterEach(() => {
  envMut.REDDIT_IMPORT_ENABLED = original.REDDIT_IMPORT_ENABLED;
  envMut.REDDIT_PROVIDER = original.REDDIT_PROVIDER;
  envMut.SCRAPECREATORS_API_KEY = original.SCRAPECREATORS_API_KEY;
  envMut.INSTAGRAM_PROVIDER = original.INSTAGRAM_PROVIDER;
});

describe("reddit isolation gate (D-08 kill-switch — Phase 12)", () => {
  it("[12-03] SCRAPECREATORS_API_KEY set + REDDIT_IMPORT_ENABLED unset ⇒ getSocialProvider('reddit') === null", () => {
    envMut.SCRAPECREATORS_API_KEY = "sk-shared-key";
    envMut.REDDIT_PROVIDER = "scrapecreators";
    envMut.REDDIT_IMPORT_ENABLED = "false"; // the safe default — kill-switch OFF

    // The shared key is present AND a provider is selected, yet Reddit stays OFF
    // because the independent kill-switch is not flipped. THIS is D-08.
    expect(getSocialProvider("reddit")).toBeNull();
  });

  it("[12-03] property: with reddit gated OFF, getSocialProvider('instagram') !== null (IG unaffected)", () => {
    envMut.SCRAPECREATORS_API_KEY = "sk-shared-key";
    envMut.INSTAGRAM_PROVIDER = "scrapecreators";
    envMut.REDDIT_PROVIDER = "scrapecreators";
    envMut.REDDIT_IMPORT_ENABLED = "false";

    // Platform-independence: the Reddit kill-switch does not touch IG selection.
    expect(getSocialProvider("reddit")).toBeNull();
    expect(getSocialProvider("instagram")).not.toBeNull();
  });

  it("[12-03] enumerate flag × key combinations: only REDDIT_IMPORT_ENABLED='true' + provider + key enables reddit", () => {
    const flags = ["true", "false"] as const;
    const providers = ["scrapecreators", ""] as const;
    const keys = ["sk-shared-key", ""];

    for (const flag of flags) {
      for (const provider of providers) {
        for (const key of keys) {
          envMut.REDDIT_IMPORT_ENABLED = flag;
          envMut.REDDIT_PROVIDER = provider;
          envMut.SCRAPECREATORS_API_KEY = key;

          const enabled = flag === "true" && provider === "scrapecreators" && key !== "";
          const resolved = getSocialProvider("reddit");
          if (enabled) {
            expect(resolved).not.toBeNull();
          } else {
            expect(resolved).toBeNull();
          }
        }
      }
    }
  });

  it("[12-03] REDDIT_IMPORT_ENABLED='false' (string) does NOT enable (no coercion trap)", () => {
    envMut.SCRAPECREATORS_API_KEY = "sk-shared-key";
    envMut.REDDIT_PROVIDER = "scrapecreators";
    envMut.REDDIT_IMPORT_ENABLED = "false"; // literal string "false", NOT boolean

    // The gate is an exact `=== "true"` string check, so the string "false" (and
    // any non-"true" value) reads as OFF — no truthy-string coercion trap.
    expect(getSocialProvider("reddit")).toBeNull();
  });
});
