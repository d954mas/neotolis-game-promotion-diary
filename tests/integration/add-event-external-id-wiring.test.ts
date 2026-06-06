import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Add-Event externalId wiring guard (issue #69).
//
// The media id resolved by POST /api/events/preview-url must round-trip through
// the form → POST /api/events → createEvent so an Instagram post saves under its
// media id (the snapshot/feed-enrichment cache key), NOT the URL shortcode. The
// service contract is already covered by instagram-paste-preview.test.ts — but
// the bug that actually shipped (#69) was the FORM discarding the previewed
// externalId, which no service test could catch because it calls createEvent
// with the externalId directly. These source-text assertions guard that
// cross-file wiring (the same idiom audit-render.test.ts uses for component
// wiring it can't drive headless). Each would FAIL on the pre-fix code.

const read = (p: string): string => fs.readFileSync(path.resolve(p), "utf8");

describe("Add-Event externalId wiring (issue #69)", () => {
  it("AddEventForm captures the preview externalId and forwards it on save", () => {
    const src = read("src/lib/components/add-event/AddEventForm.svelte");
    expect(src, "AddEventPayload / preview response declare externalId").toMatch(
      /externalId\?:\s*string\s*\|\s*null/,
    );
    expect(src, "fetchUrlMetadata captures externalId from the preview response").toMatch(
      /fetchedExternalId\s*=\s*data\.externalId/,
    );
    expect(src, "submit() forwards externalId in the onSave payload").toMatch(
      /externalId:\s*fetchedExternalId/,
    );
  });

  it("the create route schema accepts externalId (Zod strips unknown keys otherwise)", () => {
    const src = read("src/lib/server/http/routes/events.ts");
    expect(src, "createEventSchema accepts externalId").toMatch(/externalId:\s*z\.string\(\)/);
  });

  it("both /api/events POST consumers forward payload.externalId", () => {
    for (const route of ["src/routes/feed/+page.svelte", "src/routes/events/new/+page.svelte"]) {
      const src = read(route);
      expect(src, `${route} forwards externalId in the POST body`).toMatch(
        /externalId:\s*payload\.externalId/,
      );
    }
  });
});
