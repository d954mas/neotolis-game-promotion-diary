// Telegram URL parsing — unit tests for parseSourceUrl / parsePostUrl.
//
// PLACEHOLDER (Phase 9 Plan 01 Wave 0). The skipped `it`s below enumerate the
// URL-parsing assertions from 09-RESEARCH.md §Data Path; the parseUrl
// implementation (host-check first, channel-handle extraction, post externalId
// = "<channel>/<id>") lands in Plan 02.
//
// Skipped suites pass vacuously so `pnpm test:unit` stays green in Wave 0.

import { describe, it } from "vitest";

describe.skip("telegram parseSourceUrl (filled in Plan 02)", () => {
  it.skip("accepts @channel and extracts the channel handle");
  it.skip("accepts t.me/channel");
  it.skip("accepts t.me/s/channel");
  it.skip("accepts a bare channel name");
  it.skip("rejects a foreign host (host-check FIRST -> null)");
});

describe.skip("telegram parsePostUrl (filled in Plan 02)", () => {
  it.skip(
    "parses t.me/<channel>/<id> into externalId='<channel>/<id>' (per-channel-sequential message id, RESEARCH Q3)",
  );
  it.skip("rejects a foreign host before any path parsing (host-check FIRST -> null)");
});
