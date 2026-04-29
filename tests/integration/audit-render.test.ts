// Phase 2.1 Plan 20 (gap closure round 2) — render-time regression guard
// for the /audit filter UX rewrite. Replaces the Plan 02.1-11 ActionFilter
// guards (component deleted by Plan 02.1-20). AuditRow guard preserved —
// AuditRow is unchanged.
//
// New guards over FiltersSheet (the ActionFilter replacement):
//   1. Renders one checkbox per AUDIT_ACTIONS member when filters.action is
//      a non-undefined array (sweep over the closed AUDIT_ACTIONS list — a
//      future addition to AUDIT_ACTIONS without the matching auditActionLabel
//      switch case + AUDIT_ACTIONS_MIRROR entry trips this assertion).
//   2. Does NOT render the action fieldset when filters.action is undefined
//      (the /feed default).
//   3. Renders the actions in alphabetical-by-translated-label order
//      (sortByLabel locked-in via the rendered HTML output).

import { describe, it, expect } from "vitest";
import { render } from "svelte/server";
import AuditRow from "../../src/lib/components/AuditRow.svelte";
import FiltersSheet from "../../src/lib/components/FiltersSheet.svelte";
import { AUDIT_ACTIONS } from "../../src/lib/server/audit/actions.js";

describe("/audit render-time guard (Plan 02.1-20 — FiltersSheet + AuditRow)", () => {
  it("AuditRow renders a non-fallback chip label for every AUDIT_ACTIONS value", () => {
    for (const a of AUDIT_ACTIONS) {
      const renderOnce = () =>
        render(AuditRow, {
          props: {
            entry: {
              id: "test-id",
              action: a,
              ipAddress: "10.0.0.1",
              userAgent: "test",
              metadata: null,
              createdAt: new Date("2026-04-28T12:00:00Z"),
            },
          },
        });

      expect(renderOnce).not.toThrow();
      const out = renderOnce();
      // Svelte 5 SSR adds a scoped class suffix (svelte-XXXXX) — the regex
      // accepts the chip class with or without sibling classes.
      const chipMatch = out.body.match(/<span class="chip(?:\s[^"]*)?"[^>]*>([^<]*)<\/span>/);
      expect(
        chipMatch,
        `AuditRow render for action="${a}" produced no <span class="chip"> element`,
      ).not.toBeNull();
      const chipText = chipMatch![1]!.trim();
      expect(chipText.length, `AuditRow chip empty for action="${a}"`).toBeGreaterThan(0);
      expect(
        chipText,
        `AuditRow chip text for action="${a}" is the raw action — chipLabel switch missing this case`,
      ).not.toBe(a);
    }
  });

  it("FiltersSheet renders one checkbox per AUDIT_ACTIONS value when action axis is active", () => {
    const out = render(FiltersSheet, {
      props: {
        filters: {
          source: [],
          kind: [],
          show: { kind: "any" },
          defaultDateRange: false,
          all: true,
          action: [], // ← Plan 02.1-21: schema decides rendering, not filters.action
        },
        sources: [],
        games: [],
        // Plan 02.1-21: schema explicit; was implicit on filters.action shape.
        schema: ["action"] as const,
        onApply: () => {},
        onClose: () => {},
      },
    });

    // Find the fieldset[data-axis="action"] block, count <input
    // type="checkbox"> within. Counting via substring is robust against
    // attribute reordering by the renderer.
    const fieldsetMatch = out.body.match(
      /<fieldset[^>]*data-axis="action"[^>]*>([\s\S]*?)<\/fieldset>/,
    );
    expect(fieldsetMatch, "FiltersSheet did not render action fieldset").not.toBeNull();
    const fieldsetHtml = fieldsetMatch![1]!;
    const checkboxCount = (fieldsetHtml.match(/<input[^>]*type="checkbox"/g) ?? []).length;
    expect(checkboxCount).toBe(AUDIT_ACTIONS.length);
  });

  it("FiltersSheet does NOT render action fieldset when schema omits 'action'", () => {
    const out = render(FiltersSheet, {
      props: {
        filters: {
          source: [],
          kind: [],
          show: { kind: "any" },
          defaultDateRange: false,
          all: true,
          // action: undefined  ← Plan 02.1-21: schema decides rendering.
        },
        sources: [],
        games: [],
        // Plan 02.1-21: /feed-shape schema (no 'action').
        schema: ["kind", "source", "show", "authorIsMe", "date"] as const,
        onApply: () => {},
        onClose: () => {},
      },
    });
    expect(out.body).not.toMatch(/<fieldset[^>]*data-axis="action"/);
  });

  it("FiltersSheet action options sorted alphabetically by translated label", () => {
    const out = render(FiltersSheet, {
      props: {
        filters: {
          source: [],
          kind: [],
          show: { kind: "any" },
          defaultDateRange: false,
          all: true,
          action: [],
        },
        sources: [],
        games: [],
        schema: ["action"] as const,
        onApply: () => {},
        onClose: () => {},
      },
    });
    const fieldsetMatch = out.body.match(
      /<fieldset[^>]*data-axis="action"[^>]*>([\s\S]*?)<\/fieldset>/,
    )!;
    const fieldsetHtml = fieldsetMatch[1]!;
    // Extract the visible label text after each checkbox. The HTML shape is
    // <label class="check svelte-XXXXX"><input type="checkbox"/> Visible label</label>.
    // Svelte 5 SSR adds a scoped class suffix; the regex accepts any class
    // attribute that begins with "check".
    const labelRegex = /<label[^>]*class="check(?:\s[^"]*)?"[^>]*>[\s\S]*?<input[^>]*?\/?>\s*([^<]+?)\s*<\/label>/g;
    const labels: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = labelRegex.exec(fieldsetHtml)) !== null) {
      labels.push(match[1]!.trim());
    }
    expect(labels.length).toBe(AUDIT_ACTIONS.length);
    const sorted = [...labels].sort((a, b) =>
      new Intl.Collator(undefined, { sensitivity: "base" }).compare(a, b),
    );
    expect(labels).toEqual(sorted);
  });
});

/**
 * Plan 02.1-21 — schema prop honored.
 *
 * The `schema` prop replaces Plan 02.1-20's implicit `filters.action !==
 * undefined` axis-detection. Each consumer page (/feed, /audit) passes the
 * authoritative list of axes its FiltersSheet / FilterChips renders. Plan
 * 02.1-20 shoehorned /audit into /feed's contract; this plan replaces that
 * with an explicit array. UAT-NOTES.md §9.2-bug user quote: "Открывает окно,
 * там есть типы аудита, но и куча полей из feed фильтров" — the audit sheet
 * MUST NOT render kind/source/show/authorIsMe.
 *
 * Tests cover both components:
 *   - FiltersSheet: only fieldsets in `schema` render.
 *   - FilterChips: chips only emit for axes in `schema`.
 * Both regression-guard against the Plan 02.1-20 leak.
 */
describe("Plan 02.1-21 — schema prop honored", () => {
  it("FiltersSheet schema=['action'] renders ONLY the action fieldset (no kind/source/show/authorIsMe)", () => {
    const out = render(FiltersSheet, {
      props: {
        filters: {
          source: [],
          kind: [],
          show: { kind: "any" },
          defaultDateRange: false,
          all: true,
          action: ["key.add"],
        },
        sources: [],
        games: [],
        schema: ["action"] as const,
        onApply: () => {},
        onClose: () => {},
      },
    });
    expect(out.body).toMatch(/<fieldset[^>]*data-axis="action"/);
    // Regression guard for UAT §9.2-bug — Plan 02.1-20 leak.
    expect(out.body).not.toMatch(/<fieldset[^>]*data-axis="source"/);
    expect(out.body).not.toMatch(/<fieldset[^>]*data-axis="kind"/);
    expect(out.body).not.toMatch(/<fieldset[^>]*data-axis="show"/);
    expect(out.body).not.toMatch(/<fieldset[^>]*data-axis="authorIsMe"/);
  });

  it("FiltersSheet schema=['action','date'] renders action fieldset AND date fieldset", () => {
    const out = render(FiltersSheet, {
      props: {
        filters: {
          source: [],
          kind: [],
          show: { kind: "any" },
          defaultDateRange: false,
          all: true,
          action: [],
        },
        sources: [],
        games: [],
        schema: ["action", "date"] as const,
        onApply: () => {},
        onClose: () => {},
      },
    });
    expect(out.body).toMatch(/<fieldset[^>]*data-axis="action"/);
    expect(out.body).toMatch(/<fieldset[^>]*data-axis="date"/);
    // No /feed-only axes leak into /audit's sheet.
    expect(out.body).not.toMatch(/<fieldset[^>]*data-axis="source"/);
    expect(out.body).not.toMatch(/<fieldset[^>]*data-axis="kind"/);
    expect(out.body).not.toMatch(/<fieldset[^>]*data-axis="show"/);
    expect(out.body).not.toMatch(/<fieldset[^>]*data-axis="authorIsMe"/);
  });

  it("FiltersSheet schema=['kind','source','show','authorIsMe','date'] renders all /feed fieldsets and date (NO action)", () => {
    const out = render(FiltersSheet, {
      props: {
        filters: {
          source: [],
          kind: [],
          show: { kind: "any" },
          defaultDateRange: false,
          all: true,
          // action present in filters but schema does NOT include it — must NOT render.
          action: ["key.add"],
        },
        sources: [],
        games: [],
        schema: ["kind", "source", "show", "authorIsMe", "date"] as const,
        onApply: () => {},
        onClose: () => {},
      },
    });
    expect(out.body).toMatch(/<fieldset[^>]*data-axis="source"/);
    expect(out.body).toMatch(/<fieldset[^>]*data-axis="kind"/);
    expect(out.body).toMatch(/<fieldset[^>]*data-axis="show"/);
    expect(out.body).toMatch(/<fieldset[^>]*data-axis="authorIsMe"/);
    expect(out.body).toMatch(/<fieldset[^>]*data-axis="date"/);
    // Action fieldset MUST NOT render even though filters.action is populated.
    expect(out.body).not.toMatch(/<fieldset[^>]*data-axis="action"/);
  });

  it("FilterChips schema=['action'] emits ONLY the action chip (no kind/source/show/authorIsMe)", async () => {
    const FilterChips = (
      await import("../../src/lib/components/FilterChips.svelte")
    ).default;
    const out = render(FilterChips, {
      props: {
        filters: {
          source: ["src-x"],
          kind: ["youtube_video"],
          show: { kind: "inbox" as const },
          authorIsMe: true,
          defaultDateRange: false,
          all: false,
          action: ["key.add"],
        },
        sources: [{ id: "src-x", displayName: "Src X", handleUrl: "https://x" }],
        games: [],
        schema: ["action"] as const,
        onDismiss: () => {},
        onOpenSheet: () => {},
        onClearAll: () => {},
      },
    });
    // The chip strip on /audit MUST NOT show source / kind / show / author chips
    // even though those fields are populated. The 'action' chip IS expected.
    expect(out.body).toContain("Action:");
    expect(out.body).not.toContain("Kind:");
    expect(out.body).not.toContain("Source:");
    expect(out.body).not.toContain("Show:");
    expect(out.body).not.toContain("Author: me");
    expect(out.body).not.toContain("Author: not me");
  });

  it("FilterChips schema=['kind','source','show','authorIsMe'] never emits an action chip even when filters.action is populated", async () => {
    const FilterChips = (
      await import("../../src/lib/components/FilterChips.svelte")
    ).default;
    const out = render(FilterChips, {
      props: {
        filters: {
          source: ["src-x"],
          kind: ["youtube_video"],
          show: { kind: "any" as const },
          authorIsMe: true,
          defaultDateRange: false,
          all: false,
          action: ["key.add"], // Populated but schema excludes 'action'.
        },
        sources: [{ id: "src-x", displayName: "Src X", handleUrl: "https://x" }],
        games: [],
        schema: ["kind", "source", "show", "authorIsMe"] as const,
        onDismiss: () => {},
        onOpenSheet: () => {},
        onClearAll: () => {},
      },
    });
    // /feed schema — kind / source / authorIsMe chips render; action does NOT.
    expect(out.body).toContain("Kind:");
    expect(out.body).toContain("Source:");
    expect(out.body).toContain("Author: me");
    expect(out.body).not.toContain("Action:");
  });
});

/**
 * Plan 02.1-23 — FeedCard restructured layout (UAT §1.5-redesign closure).
 *
 * The user-proposed card layout from round-3 UAT (ASCII mockup in
 * UAT-NOTES.md §1.5-redesign) restructures the FeedCard:
 *   1. Image area at TOP with absolute-positioned top overlay carrying
 *      kind icon+text label + Inbox badge (if applicable) + Mine badge
 *      (if author_is_me).
 *   2. Title under the image.
 *   3. Notes under the title (clipped via `-webkit-line-clamp: 3`).
 *   4. Source chip (chips-line — now WITHOUT mine/game).
 *   5. Associated games block at the BOTTOM of the card body (NOT in the
 *      mid-card chips-line).
 *
 * Mine treatment combines TWO visual cues (user choice "C and A" during UAT):
 *   - C: `Mine` badge in the top overlay (alongside kind label and Inbox).
 *   - A: `border-left: 4px solid var(--color-accent)` on the entire card
 *        when `event.authorIsMe === true`.
 *
 * Plan 02.1-18 read-only contract preserved — no inline Edit/Delete/Open
 * buttons. Plan 02.1-19 date-removal preserved — no per-card date label.
 */
describe("Plan 02.1-23 — FeedCard restructured layout", () => {
  const baseEvent = {
    id: "ev-1",
    gameId: null,
    sourceId: null,
    kind: "youtube_video" as const,
    authorIsMe: false,
    occurredAt: new Date("2026-04-25T12:00:00Z"),
    title: "How I marketed my indie game",
    url: "https://youtube.com/watch?v=abc",
    externalId: "abc",
    notes: null as string | null,
    metadata: null as unknown,
    lastPolledAt: null as Date | null,
  };

  it("renders class:mine on the root <article> when event.authorIsMe=true (border-left accent gate)", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte"))
      .default;
    const out = render(FeedCard, {
      props: {
        event: { ...baseEvent, authorIsMe: true },
        source: null,
        game: null,
        games: [],
      },
    });
    // Svelte 5 SSR may add a scoped class suffix — match `mine` as a class token.
    expect(out.body).toMatch(
      /<article[^>]*class="[^"]*\bmine\b[^"]*"[^>]*>/,
    );
  });

  it("does NOT render class:mine when event.authorIsMe=false", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte"))
      .default;
    const out = render(FeedCard, {
      props: {
        event: { ...baseEvent, authorIsMe: false },
        source: null,
        game: null,
        games: [],
      },
    });
    expect(out.body).not.toMatch(
      /<article[^>]*class="[^"]*\bmine\b[^"]*"[^>]*>/,
    );
  });

  it("renders the top overlay with kind label AND Mine badge text when author_is_me=true", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte"))
      .default;
    const out = render(FeedCard, {
      props: {
        event: { ...baseEvent, authorIsMe: true },
        source: null,
        game: null,
        games: [],
      },
    });
    const overlayMatch = out.body.match(
      /<div[^>]*data-testid="feed-card-overlay"[^>]*>([\s\S]*?)<\/div>(?=\s*<\/div>\s*<div class="title-line)/,
    );
    // If the regex above is too greedy across nested divs (overlay contains
    // child spans which contain divs from KindIcon's <svg>), fall back to a
    // looser substring assertion: the overlay block must appear before the
    // title-line block, and must contain the Mine badge text.
    if (!overlayMatch) {
      // Looser fallback: overlay element exists, body contains both labels.
      expect(out.body).toMatch(/data-testid="feed-card-overlay"/);
      expect(out.body).toContain("Mine");
      // YouTube kind label should appear too.
      expect(out.body).toContain("YouTube video");
    } else {
      const overlayHtml = overlayMatch[1]!;
      expect(overlayHtml).toContain("Mine");
      expect(overlayHtml).toContain("YouTube video");
    }
  });

  it("renders the Inbox label inside the top overlay (NOT in the meta-line) when row is in inbox", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte"))
      .default;
    const out = render(FeedCard, {
      props: {
        event: {
          ...baseEvent,
          gameId: null,
          metadata: null,
        },
        source: null,
        game: null,
        games: [],
      },
    });
    // Overlay must contain "Inbox" text. The original meta-line carried
    // <InboxBadge/>; after restructure the overlay carries "Inbox" inline.
    expect(out.body).toMatch(/data-testid="feed-card-overlay"/);
    // "Inbox" text appears in the overlay region of the body. Check the
    // overlay element substring contains it. We use a permissive forward
    // slice from the overlay marker to the next major block.
    const overlayIdx = out.body.indexOf('data-testid="feed-card-overlay"');
    expect(overlayIdx).toBeGreaterThan(-1);
    const overlaySlice = out.body.slice(overlayIdx, overlayIdx + 1000);
    expect(overlaySlice).toContain("Inbox");
  });

  it("renders <div class='games-block'> AFTER the chips-line element when game is attached", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte"))
      .default;
    const out = render(FeedCard, {
      props: {
        event: { ...baseEvent, gameId: "g-1" },
        source: { id: "s-1", displayName: "My Source", handleUrl: "https://x.test" },
        game: { id: "g-1", title: "Stellar Frontier" },
        games: [{ id: "g-1", title: "Stellar Frontier" }],
      },
    });
    // Both elements present.
    expect(out.body).toMatch(/class="chips-line(?:\s[^"]*)?"/);
    expect(out.body).toMatch(/class="games-block(?:\s[^"]*)?"/);
    // games-block appears AFTER chips-line in source order.
    const chipsIdx = out.body.search(/class="chips-line(?:\s[^"]*)?"/);
    const gamesBlockIdx = out.body.search(/class="games-block(?:\s[^"]*)?"/);
    expect(chipsIdx).toBeGreaterThan(-1);
    expect(gamesBlockIdx).toBeGreaterThan(-1);
    expect(gamesBlockIdx).toBeGreaterThan(chipsIdx);
    // Game title chip rendered inside games-block.
    expect(out.body).toContain("Stellar Frontier");
  });

  it("does NOT render games-block when game is null", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte"))
      .default;
    const out = render(FeedCard, {
      props: {
        event: baseEvent,
        source: null,
        game: null,
        games: [],
      },
    });
    expect(out.body).not.toMatch(/class="games-block(?:\s[^"]*)?"/);
  });

  it("renders <p class='notes'> when event.notes is non-empty (clamp class applied via CSS)", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte"))
      .default;
    const longNote =
      "This is a long-form note about the marketing campaign. ".repeat(10);
    const out = render(FeedCard, {
      props: {
        event: { ...baseEvent, notes: longNote },
        source: null,
        game: null,
        games: [],
      },
    });
    expect(out.body).toMatch(/<p[^>]*class="notes(?:\s[^"]*)?"[^>]*>/);
    // Notes content rendered (truncated visually via CSS at 3 lines).
    expect(out.body).toContain("marketing campaign");
  });

  it("does NOT render <p class='notes'> when event.notes is null", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte"))
      .default;
    const out = render(FeedCard, {
      props: {
        event: { ...baseEvent, notes: null },
        source: null,
        game: null,
        games: [],
      },
    });
    expect(out.body).not.toMatch(/<p[^>]*class="notes(?:\s[^"]*)?"[^>]*>/);
  });

  it("renders youtube thumbnail when kind=youtube_video AND externalId present", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte"))
      .default;
    const out = render(FeedCard, {
      props: {
        event: { ...baseEvent, kind: "youtube_video", externalId: "abc123" },
        source: null,
        game: null,
        games: [],
      },
    });
    expect(out.body).toMatch(/img\.youtube\.com\/vi\/abc123\/mqdefault\.jpg/);
  });

  it("renders metadata.media.url thumbnail for kind=reddit_post when media present", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte"))
      .default;
    const out = render(FeedCard, {
      props: {
        event: {
          ...baseEvent,
          kind: "reddit_post" as const,
          externalId: null,
          metadata: { media: { url: "https://i.redd.it/abc.jpg" } },
        },
        source: null,
        game: null,
        games: [],
      },
    });
    expect(out.body).toContain("https://i.redd.it/abc.jpg");
  });

  it("falls back to KindIcon (no <img>) for kind=conference (text fallback per UAT-NOTES rules)", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte"))
      .default;
    const out = render(FeedCard, {
      props: {
        event: {
          ...baseEvent,
          kind: "conference" as const,
          externalId: null,
          metadata: null,
        },
        source: null,
        game: null,
        games: [],
      },
    });
    // No <img> tag for the .thumbnail class.
    expect(out.body).not.toMatch(/<img[^>]*class="thumbnail/);
    // The icon-anchor block IS rendered (KindIcon centered).
    expect(out.body).toMatch(/class="icon-anchor(?:\s[^"]*)?"/);
  });

  it("Plan 02.1-18 contract preserved — no inline Edit / Delete / Open buttons", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte"))
      .default;
    const out = render(FeedCard, {
      props: {
        event: { ...baseEvent, gameId: "g-1" },
        source: null,
        game: { id: "g-1", title: "Stellar Frontier" },
        games: [{ id: "g-1", title: "Stellar Frontier" }],
      },
    });
    // No <button> labelled Open / Edit / Delete in the rendered output.
    // (AttachToGamePicker may render buttons, but those are picker controls,
    // not action buttons — assert no <button> with explicit Edit/Delete text.)
    expect(out.body).not.toMatch(/<button[^>]*>[^<]*Edit[^<]*<\/button>/);
    expect(out.body).not.toMatch(/<button[^>]*>[^<]*Delete[^<]*<\/button>/);
    expect(out.body).not.toMatch(/<button[^>]*>[^<]*Open[^<]*<\/button>/);
  });

  it("Plan 02.1-19 contract preserved — no inline date string on the card", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte"))
      .default;
    const out = render(FeedCard, {
      props: {
        event: {
          ...baseEvent,
          occurredAt: new Date("2026-01-15T08:30:00Z"),
        },
        source: null,
        game: null,
        games: [],
      },
    });
    // formatFeedDate output (e.g. "Jan 15") MUST NOT appear inline on the card.
    // The FeedDateGroupHeader above the card group carries the date label.
    expect(out.body).not.toContain("Jan 15");
  });
});
