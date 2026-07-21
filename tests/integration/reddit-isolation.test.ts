// Wave-0 scaffold — flipped live by Plan 12-03. HIGH-RISK behavior (B): the
// D-08 isolation gate. Named it.skip placeholders; no logic yet.
import { describe, it } from "vitest";

describe("reddit isolation gate (D-08 kill-switch — Phase 12)", () => {
  it.skip(
    "[12-03] SCRAPECREATORS_API_KEY set + REDDIT_IMPORT_ENABLED unset ⇒ getSocialProvider('reddit') === null",
  );
  it.skip(
    "[12-03] property: with reddit gated OFF, getSocialProvider('instagram') !== null (IG unaffected)",
  );
  it.skip(
    "[12-03] enumerate flag × key combinations: only REDDIT_IMPORT_ENABLED='true' + provider + key enables reddit",
  );
  it.skip("[12-03] REDDIT_IMPORT_ENABLED='false' (string) does NOT enable (no coercion trap)");
});
