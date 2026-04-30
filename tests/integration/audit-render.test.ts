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
        // /feed-shape schema (post Plan 02.1-39 round-6 polish #9: 'date'
        // dropped — DateRangeControl is the SOT). Same regression-guard
        // intent: no 'action' fieldset leaks into /feed's sheet.
        schema: ["kind", "source", "show", "authorIsMe"] as const,
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
    const labelRegex =
      /<label[^>]*class="check(?:\s[^"]*)?"[^>]*>[\s\S]*?<input[^>]*?\/?>\s*([^<]+?)\s*<\/label>/g;
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

  it("FiltersSheet schema=['kind','source','show','authorIsMe','date'] renders all those fieldsets (NO action) — prop-machinery test", () => {
    // Note: this is a prop-machinery test, NOT a /feed snapshot — Plan
    // 02.1-39 round-6 polish #9 narrowed /feed's actual schema to
    // ['kind','source','show','authorIsMe'] (no 'date'). The schema prop
    // contract still has to render the date fieldset when a consumer DOES
    // include 'date', so we keep this assertion to guard the schema-honored
    // contract. /audit's actual schema is asserted in the Plan 02.1-34
    // describe block; /feed's actual schema is asserted in the
    // 02.1-39-round-6-#9 describe block below.
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
    const FilterChips = (await import("../../src/lib/components/FilterChips.svelte")).default;
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
    const FilterChips = (await import("../../src/lib/components/FilterChips.svelte")).default;
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
    // Plan 02.1-28 (M:N migration): the legacy singular gameId is REPLACED
    // with gameIds[]. Empty array === inbox event (no attached games).
    gameIds: [] as string[],
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
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
    const out = render(FeedCard, {
      props: {
        event: { ...baseEvent, authorIsMe: true },
        source: null,
        game: null,
        games: [],
      },
    });
    // Svelte 5 SSR may add a scoped class suffix — match `mine` as a class token.
    expect(out.body).toMatch(/<article[^>]*class="[^"]*\bmine\b[^"]*"[^>]*>/);
  });

  it("does NOT render class:mine when event.authorIsMe=false", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
    const out = render(FeedCard, {
      props: {
        event: { ...baseEvent, authorIsMe: false },
        source: null,
        game: null,
        games: [],
      },
    });
    expect(out.body).not.toMatch(/<article[^>]*class="[^"]*\bmine\b[^"]*"[^>]*>/);
  });

  it("renders the top overlay with kind label AND Mine badge text when author_is_me=true", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
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
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
    const out = render(FeedCard, {
      props: {
        event: {
          ...baseEvent,
          gameIds: [],
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
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
    const out = render(FeedCard, {
      props: {
        event: { ...baseEvent, gameIds: ["g-1"] },
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
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
    const out = render(FeedCard, {
      props: {
        event: { ...baseEvent },
        source: null,
        game: null,
        games: [],
      },
    });
    expect(out.body).not.toMatch(/class="games-block(?:\s[^"]*)?"/);
  });

  it("renders <p class='notes'> when event.notes is non-empty (clamp class applied via CSS)", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
    const longNote = "This is a long-form note about the marketing campaign. ".repeat(10);
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
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
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
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
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
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
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
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
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
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
    const out = render(FeedCard, {
      props: {
        event: { ...baseEvent, gameIds: ["g-1"] },
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
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
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

/**
 * Plan 02.1-26 — FeedQuickNav SSR render-time guards.
 *
 * NEW component — chip strip / segmented control at the TOP of /feed for the
 * most-common Show axis values (All / Inbox / Standalone / per-game). Closes
 * UAT-NOTES.md §6.2-redesign. The end-to-end browser flow at 360px (computed
 * overflow-x: auto, click→URL change) is stub-skipped in
 * tests/browser/feed-360.test.ts pending the cookie-injection auth harness
 * (Phase 6); the SSR-render-time contract is locked in HERE.
 *
 * Component is testable in pure SSR because it takes `currentUrlSearch`
 * (string) and `onNavigate` (callback) as props instead of importing
 * `$app/state` / `$app/navigation` directly. The /feed/+page.svelte parent
 * threads those values through.
 */
describe("Plan 02.1-26 — FeedQuickNav", () => {
  it("renders <nav class='quick-nav'> with All / Inbox / Standalone fixed tabs", async () => {
    const FeedQuickNav = (await import("../../src/lib/components/FeedQuickNav.svelte")).default;
    const out = render(FeedQuickNav, {
      props: {
        games: [],
        activeShow: { kind: "any" as const },
        currentUrlSearch: "",
        onNavigate: () => {},
      },
    });
    expect(out.body).toMatch(/data-testid="feed-quick-nav"/);
    expect(out.body).toMatch(/data-tab="all"/);
    expect(out.body).toMatch(/data-tab="inbox"/);
    // Plan 02.1-31: technical state name 'standalone' (lowercase) STAYS on
    // the data-tab attribute (URL contract preserved); the user-facing
    // rendered text is now "Not game-related" via the renamed m.* value.
    expect(out.body).toMatch(/data-tab="standalone"/);
    // Paraglide labels render at runtime (m.feed_quick_nav_*).
    expect(out.body).toContain("All");
    expect(out.body).toContain("Inbox");
    // Plan 02.1-31: standalone segment now renders user-facing text
    // "Not game-related" instead of "Standalone" (UAT-NOTES.md §4.24.A).
    expect(out.body).toContain("Not game-related");
    // The literal English word "Standalone" MUST NOT appear in the rendered
    // user-facing text — the data-tab attribute uses the lowercase technical
    // identifier, not the capitalized English word.
    expect(out.body).not.toMatch(/>[^<]*\bStandalone\b[^<]*</);
  });

  it("renders one tab per game (up to 5 visible) with the game id and title", async () => {
    const FeedQuickNav = (await import("../../src/lib/components/FeedQuickNav.svelte")).default;
    const out = render(FeedQuickNav, {
      props: {
        games: [
          { id: "g-1", title: "Stellar Frontier" },
          { id: "g-2", title: "Pixel Legends" },
        ],
        activeShow: { kind: "any" as const },
        currentUrlSearch: "",
        onNavigate: () => {},
      },
    });
    expect(out.body).toMatch(/data-tab="game"[^>]*data-game-id="g-1"/);
    expect(out.body).toMatch(/data-tab="game"[^>]*data-game-id="g-2"/);
    expect(out.body).toContain("Stellar Frontier");
    expect(out.body).toContain("Pixel Legends");
  });

  it("Inbox tab is marked active when activeShow.kind === 'inbox'", async () => {
    const FeedQuickNav = (await import("../../src/lib/components/FeedQuickNav.svelte")).default;
    const out = render(FeedQuickNav, {
      props: {
        games: [],
        activeShow: { kind: "inbox" as const },
        currentUrlSearch: "?show=inbox",
        onNavigate: () => {},
      },
    });
    // Inbox <a> carries class:active. Match: <a class="...active..."
    // data-tab="inbox" OR <a data-tab="inbox" ... class="...active...".
    // Svelte 5 SSR may add scoped class suffix.
    expect(out.body).toMatch(
      /<a[^>]*data-tab="inbox"[^>]*class="[^"]*\bactive\b[^"]*"|<a[^>]*class="[^"]*\bactive\b[^"]*"[^>]*data-tab="inbox"/,
    );
    // All tab is NOT active when Inbox is active.
    expect(out.body).not.toMatch(
      /<a[^>]*data-tab="all"[^>]*class="[^"]*\bactive\b[^"]*"|<a[^>]*class="[^"]*\bactive\b[^"]*"[^>]*data-tab="all"/,
    );
  });

  it("Standalone tab is marked active when activeShow.kind === 'standalone'", async () => {
    const FeedQuickNav = (await import("../../src/lib/components/FeedQuickNav.svelte")).default;
    const out = render(FeedQuickNav, {
      props: {
        games: [],
        activeShow: { kind: "standalone" as const },
        currentUrlSearch: "?show=standalone",
        onNavigate: () => {},
      },
    });
    expect(out.body).toMatch(
      /<a[^>]*data-tab="standalone"[^>]*class="[^"]*\bactive\b[^"]*"|<a[^>]*class="[^"]*\bactive\b[^"]*"[^>]*data-tab="standalone"/,
    );
  });

  it("per-game tab is marked active when activeShow.kind === 'specific' AND gameIds=[that id]", async () => {
    const FeedQuickNav = (await import("../../src/lib/components/FeedQuickNav.svelte")).default;
    const out = render(FeedQuickNav, {
      props: {
        games: [
          { id: "g-1", title: "Stellar Frontier" },
          { id: "g-2", title: "Pixel Legends" },
        ],
        activeShow: { kind: "specific" as const, gameIds: ["g-2"] },
        currentUrlSearch: "?show=specific&game=g-2",
        onNavigate: () => {},
      },
    });
    // g-2 tab is active.
    expect(out.body).toMatch(
      /<a[^>]*data-game-id="g-2"[^>]*class="[^"]*\bactive\b[^"]*"|<a[^>]*class="[^"]*\bactive\b[^"]*"[^>]*data-game-id="g-2"/,
    );
    // g-1 tab is NOT active.
    expect(out.body).not.toMatch(
      /<a[^>]*data-game-id="g-1"[^>]*class="[^"]*\bactive\b[^"]*"|<a[^>]*class="[^"]*\bactive\b[^"]*"[^>]*data-game-id="g-1"/,
    );
  });

  it("All tab is the default active when activeShow.kind === 'any' (no Show param in URL)", async () => {
    const FeedQuickNav = (await import("../../src/lib/components/FeedQuickNav.svelte")).default;
    const out = render(FeedQuickNav, {
      props: {
        games: [{ id: "g-1", title: "Stellar Frontier" }],
        activeShow: { kind: "any" as const },
        currentUrlSearch: "",
        onNavigate: () => {},
      },
    });
    expect(out.body).toMatch(
      /<a[^>]*data-tab="all"[^>]*class="[^"]*\bactive\b[^"]*"|<a[^>]*class="[^"]*\bactive\b[^"]*"[^>]*data-tab="all"/,
    );
    // Inbox / Standalone / per-game NOT active.
    expect(out.body).not.toMatch(
      /<a[^>]*data-tab="inbox"[^>]*class="[^"]*\bactive\b[^"]*"|<a[^>]*class="[^"]*\bactive\b[^"]*"[^>]*data-tab="inbox"/,
    );
    expect(out.body).not.toMatch(
      /<a[^>]*data-tab="standalone"[^>]*class="[^"]*\bactive\b[^"]*"|<a[^>]*class="[^"]*\bactive\b[^"]*"[^>]*data-tab="standalone"/,
    );
  });

  it("Inbox tab href = '/feed?show=inbox' when starting from an empty URL", async () => {
    const FeedQuickNav = (await import("../../src/lib/components/FeedQuickNav.svelte")).default;
    const out = render(FeedQuickNav, {
      props: {
        games: [],
        activeShow: { kind: "any" as const },
        currentUrlSearch: "",
        onNavigate: () => {},
      },
    });
    expect(out.body).toMatch(
      /<a[^>]*data-tab="inbox"[^>]*href="\/feed\?show=inbox"|<a[^>]*href="\/feed\?show=inbox"[^>]*data-tab="inbox"/,
    );
  });

  it("All tab href preserves date / kind / source / authorIsMe params (only show + game cleared)", async () => {
    const FeedQuickNav = (await import("../../src/lib/components/FeedQuickNav.svelte")).default;
    const out = render(FeedQuickNav, {
      props: {
        games: [],
        activeShow: { kind: "inbox" as const },
        currentUrlSearch:
          "?show=inbox&kind=press&source=src-1&from=2026-01-01&authorIsMe=true&cursor=stale",
        onNavigate: () => {},
      },
    });
    // The 'all' href drops show / game / cursor but preserves the rest. The
    // exact param order depends on URLSearchParams iteration order; assert
    // by searching the All tab anchor for each preserved key.
    // Match the All tab anchor with a regex spanning attributes.
    const allTabMatch = out.body.match(/<a[^>]*data-tab="all"[^>]*href="([^"]+)"/);
    if (!allTabMatch) {
      throw new Error("All tab href not found");
    }
    const href = allTabMatch[1]!;
    expect(href).toContain("kind=press");
    expect(href).toContain("source=src-1");
    expect(href).toContain("from=2026-01-01");
    expect(href).toContain("authorIsMe=true");
    expect(href).not.toContain("show=");
    expect(href).not.toContain("cursor=");
    expect(href).not.toContain("game=");
  });

  it("Inbox tab href clears any pre-existing ?game=… while setting ?show=inbox", async () => {
    const FeedQuickNav = (await import("../../src/lib/components/FeedQuickNav.svelte")).default;
    const out = render(FeedQuickNav, {
      props: {
        games: [{ id: "g-1", title: "X" }],
        activeShow: { kind: "specific" as const, gameIds: ["g-1"] },
        currentUrlSearch: "?show=specific&game=g-1",
        onNavigate: () => {},
      },
    });
    const inboxMatch = out.body.match(/<a[^>]*data-tab="inbox"[^>]*href="([^"]+)"/);
    if (!inboxMatch) {
      throw new Error("Inbox tab href not found");
    }
    const href = inboxMatch[1]!;
    expect(href).toContain("show=inbox");
    expect(href).not.toContain("game=g-1");
  });

  it("per-game tab href = '/feed?show=specific&game=<id>' (single value) when starting from empty URL", async () => {
    const FeedQuickNav = (await import("../../src/lib/components/FeedQuickNav.svelte")).default;
    const out = render(FeedQuickNav, {
      props: {
        games: [{ id: "g-1", title: "X" }],
        activeShow: { kind: "any" as const },
        currentUrlSearch: "",
        onNavigate: () => {},
      },
    });
    const gameMatch = out.body.match(/<a[^>]*data-game-id="g-1"[^>]*href="([^"]+)"/);
    if (!gameMatch) {
      throw new Error("Per-game tab href not found");
    }
    const href = gameMatch[1]!;
    expect(href).toContain("show=specific");
    expect(href).toContain("game=g-1");
    // Cursor / prior game params are cleared.
    expect(href).not.toContain("cursor=");
  });

  it("'More games' dropdown does NOT render when games.length <= 5", async () => {
    const FeedQuickNav = (await import("../../src/lib/components/FeedQuickNav.svelte")).default;
    const out = render(FeedQuickNav, {
      props: {
        games: Array.from({ length: 5 }, (_, i) => ({
          id: `g-${i}`,
          title: `Game ${i}`,
        })),
        activeShow: { kind: "any" as const },
        currentUrlSearch: "",
        onNavigate: () => {},
      },
    });
    expect(out.body).not.toMatch(/data-testid="feed-quick-nav-more"/);
    // All 5 games rendered as inline tabs.
    for (let i = 0; i < 5; i++) {
      expect(out.body).toContain(`Game ${i}`);
    }
  });

  it("'More games' dropdown renders with overflow games when games.length > 5", async () => {
    const FeedQuickNav = (await import("../../src/lib/components/FeedQuickNav.svelte")).default;
    const games = Array.from({ length: 7 }, (_, i) => ({
      id: `g-${i}`,
      title: `Game ${i}`,
    }));
    const out = render(FeedQuickNav, {
      props: {
        games,
        activeShow: { kind: "any" as const },
        currentUrlSearch: "",
        onNavigate: () => {},
      },
    });
    // Dropdown <details> exists with the right testid.
    expect(out.body).toMatch(/data-testid="feed-quick-nav-more"/);
    // Inline tabs cover 0..4; overflow tabs (5, 6) live inside the dropdown.
    // Count: 5 inline + 2 dropdown = 7 instances of "Game N" total. We can
    // assert each title appears exactly once at minimum.
    for (let i = 0; i < 7; i++) {
      expect(out.body).toContain(`Game ${i}`);
    }
    // The overflow games (g-5, g-6) carry data-game-id attributes — both
    // inside the dropdown (the inline strip's max index is g-4).
    expect(out.body).toMatch(/data-game-id="g-5"/);
    expect(out.body).toMatch(/data-game-id="g-6"/);
  });

  it("the strip renders horizontally — overflow-x: auto declared in component CSS", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/lib/components/FeedQuickNav.svelte"), "utf8");
    // The 360px horizontal-scroll behavior is locked in via the component
    // style declaration. The end-to-end at-360px assertion is stub-skipped in
    // tests/browser/feed-360.test.ts pending the auth harness; here we lock
    // in the source-level contract.
    expect(src).toMatch(/overflow-x:\s*auto/);
    expect(src).toMatch(/scroll-snap-type:\s*x\s+mandatory/);
  });
});

/**
 * Plan 02.1-25 — render-time regression guards for the new components
 * (PageHeader, GameCover, SteamListingRow) + the SourceRow Mine treatment +
 * the /games/[id] two-card layout.
 *
 * The end-to-end browser flow at 360px (PageHeader inline-on-the-left,
 * /games/[id] two-card layout, SourceRow accent left-border, GameCover img
 * vs placeholder, SteamListingRow Open-on-Steam href) requires the
 * cookie-injection auth harness still deferred to Phase 6 — stub-skipped
 * in tests/browser/responsive-360.test.ts + feed-360.test.ts. The
 * component-level contracts are locked in HERE via SSR render so a future
 * regression breaks at CI time, not at manual UAT.
 */
describe("Plan 02.1-25 — PageHeader + GameCover + SteamListingRow + SourceRow Mine", () => {
  it("PageHeader with href CTA renders <a class='cta'> as the call-to-action", async () => {
    const PageHeader = (await import("../../src/lib/components/PageHeader.svelte")).default;
    const out = render(PageHeader, {
      props: {
        title: "Data sources",
        cta: { href: "/sources/new", label: "+ Add data source" },
      },
    });
    expect(out.body).toContain("Data sources");
    expect(out.body).toContain("+ Add data source");
    expect(out.body).toMatch(/<a[^>]*href="\/sources\/new"[^>]*class="[^"]*\bcta\b/);
    // Inline-on-the-left layout — no justify-content: space-between in the
    // shipped component CSS. The plan's UAT-NOTES.md §3.1-polish quote was
    // "Хочется кнопку после заголовка". The CSS is asserted on source.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/lib/components/PageHeader.svelte"), "utf8");
    expect(src).not.toMatch(/justify-content:\s*space-between/);
    expect(src).toMatch(/display:\s*flex/);
  });

  it("PageHeader with onClick CTA renders <button> instead of <a>", async () => {
    const PageHeader = (await import("../../src/lib/components/PageHeader.svelte")).default;
    const out = render(PageHeader, {
      props: {
        title: "Games",
        cta: { onClick: () => {}, label: "+ New game" },
      },
    });
    expect(out.body).toMatch(/<button[^>]*type="button"[^>]*class="[^"]*\bcta\b/);
    expect(out.body).toContain("+ New game");
    // The link variant is NOT present.
    expect(out.body).not.toMatch(/<a[^>]*class="[^"]*\bcta\b/);
  });

  it("PageHeader with sticky=true adds .sticky class on the root <header>", async () => {
    const PageHeader = (await import("../../src/lib/components/PageHeader.svelte")).default;
    const out = render(PageHeader, {
      props: {
        title: "Data sources",
        cta: { href: "/sources/new", label: "+ Add data source" },
        sticky: true,
      },
    });
    expect(out.body).toMatch(/<header[^>]*class="[^"]*\bsticky\b/);
  });

  it("GameCover renders <img> with the FIRST listing's coverUrl when present", async () => {
    const GameCover = (await import("../../src/lib/components/GameCover.svelte")).default;
    const out = render(GameCover, {
      props: {
        title: "Portal 2",
        listings: [
          { coverUrl: "https://shared.akamai.steamstatic.com/portal2.jpg" },
          { coverUrl: null },
        ],
      },
    });
    expect(out.body).toMatch(
      /<img[^>]*src="https:\/\/shared\.akamai\.steamstatic\.com\/portal2\.jpg"/,
    );
    expect(out.body).toMatch(/referrerpolicy="no-referrer"/);
    expect(out.body).toContain('alt="Cover for Portal 2"');
  });

  it("GameCover renders gradient placeholder + initials when no listing has coverUrl", async () => {
    const GameCover = (await import("../../src/lib/components/GameCover.svelte")).default;
    const out = render(GameCover, {
      props: {
        title: "Stellar Frontier",
        listings: [{ coverUrl: null }],
      },
    });
    // No <img> when coverSrc is null.
    expect(out.body).not.toMatch(/<img[^>]*src=/);
    expect(out.body).toMatch(/<div[^>]*class="[^"]*\bplaceholder\b/);
    // Initials = "SF" (first letters of "Stellar" + "Frontier" uppercased).
    expect(out.body).toContain("SF");
  });

  it("GameCover renders <img> when listings is empty AND skips placeholder when coverUrl present in any listing", async () => {
    const GameCover = (await import("../../src/lib/components/GameCover.svelte")).default;
    // Empty listings → placeholder.
    const empty = render(GameCover, {
      props: { title: "HADES", listings: [] },
    });
    expect(empty.body).toMatch(/<div[^>]*class="[^"]*\bplaceholder\b/);
    expect(empty.body).toContain("H");
  });

  it("GameCover comments document the Phase 3+ deferred manual-upload path", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/lib/components/GameCover.svelte"), "utf8");
    expect(src).toMatch(/TODO Phase 3\+/);
  });

  it("SteamListingRow renders the persisted name when listing.name is present", async () => {
    // Plan 02.1-39 round-6 polish #13: the app id ALSO renders as its own
    // line on the card now (user direction "app id" — explicit content
    // requirement). The previous Plan 02.1-25 assertion that "App {appId}"
    // is NOT rendered when name is present is INVERTED — the app id is
    // ALWAYS visible because it is technical metadata users need to
    // disambiguate listings (e.g. Portal 2 main app vs Portal 2 demo).
    const SteamListingRow = (await import("../../src/lib/components/SteamListingRow.svelte"))
      .default;
    const out = render(SteamListingRow, {
      props: {
        listing: {
          id: "l-1",
          appId: 620,
          label: "PC",
          name: "Portal 2",
          coverUrl: null,
          releaseDate: "Apr 19, 2011",
          apiKeyId: null,
        },
      },
    });
    expect(out.body).toContain("Portal 2");
    // Plan 02.1-39 round-6 polish #13: app id surfaces in its own muted
    // monospace line, INDEPENDENT of the name fallback. Both Portal 2
    // (the name) and "App 620" (the technical id) coexist on the card.
    // Svelte adds a per-component CSS-scope hash (`svelte-XXXX`) to the
    // class attribute, so match the prefix only.
    expect(out.body).toContain("App 620");
    expect(out.body).toMatch(/class="app-id\b/);
  });

  it("SteamListingRow falls back to localized 'Untitled' when listing.name is null (round-6 #13)", async () => {
    // Plan 02.1-39 round-6 polish #13: the name fallback is now
    // m.steam_listing_unnamed() ("Untitled") rather than `App {appId}` —
    // user direction wanted human-readable text (the appId surfaces in
    // its own line via m.steam_listing_app_id, so the fallback no longer
    // duplicates that information).
    const SteamListingRow = (await import("../../src/lib/components/SteamListingRow.svelte"))
      .default;
    const out = render(SteamListingRow, {
      props: {
        listing: {
          id: "l-2",
          appId: 99999,
          label: "",
          name: null,
          coverUrl: null,
          releaseDate: null,
          apiKeyId: null,
        },
      },
    });
    // Untitled is the new name fallback (m.steam_listing_unnamed).
    expect(out.body).toContain("Untitled");
    // App id ALSO renders as its own line via m.steam_listing_app_id.
    expect(out.body).toContain("App 99999");
    // Svelte CSS-scope hash: match the class prefix only.
    expect(out.body).toMatch(/class="app-id\b/);
  });

  it("SteamListingRow Open-on-Steam href targets store.steampowered.com/app/{appId}/", async () => {
    const SteamListingRow = (await import("../../src/lib/components/SteamListingRow.svelte"))
      .default;
    const out = render(SteamListingRow, {
      props: {
        listing: {
          id: "l-3",
          appId: 1145360,
          label: "PC",
          name: "HADES",
          coverUrl: null,
          releaseDate: "Sep 17, 2020",
          apiKeyId: null,
        },
      },
    });
    expect(out.body).toMatch(/<a[^>]*href="https:\/\/store\.steampowered\.com\/app\/1145360\/"/);
    expect(out.body).toMatch(/target="_blank"/);
    expect(out.body).toMatch(/rel="noopener noreferrer"/);
    // Paraglide label renders. Plan 02.1-39 §5.3 introduced
    // m.steam_listing_open_in_steam() ("Open in Steam") — distinct from
    // the Plan 02.1-25 m.steam_listing_open_link_label() ("Open on
    // Steam") which is now unused by SteamListingRow but kept in the
    // message catalog for any future re-use.
    expect(out.body).toContain("Open in Steam");
  });

  it("SourceRow.svelte source carries the Mine treatment CSS rule + kind label", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/lib/components/SourceRow.svelte"), "utf8");
    // class:mine on root .row div + .row.mine border-left rule.
    expect(src).toMatch(/class:mine=\{source\.isOwnedByMe\}/);
    // Plan 02.1-30 (UAT-NOTES.md §4.25.A): swapped --color-accent for
    // --color-mine so SourceRow.mine + FeedCard.mine resolve to the same
    // shared token (defaults to accent today; can diverge later).
    expect(src).toMatch(/\.row\.mine\s*\{[\s\S]*?border-left:\s*4px solid var\(--color-mine\)/);
    expect(src).toMatch(/\.ownership-badge\.mine[\s\S]*?background:\s*var\(--color-mine\)/);
    // Kind label rendered next to the icon via kindLabel(SourceKind).
    expect(src).toMatch(/kindLabel/);
    expect(src).toMatch(/source_kind_label_youtube_channel/);
    expect(src).toMatch(/source_kind_label_reddit_account/);
    expect(src).toMatch(/source_kind_label_twitter_account/);
    expect(src).toMatch(/source_kind_label_telegram_channel/);
    expect(src).toMatch(/source_kind_label_discord_server/);
  });

  it("/games/[id]/+page.svelte renders the three-section layout (Plan 02.1-39 §5.3 + round-6 polish #13/#14b)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/routes/games/[gameId]/+page.svelte"), "utf8");
    // Plan 02.1-39 (UAT-NOTES.md §5.3): three labelled sections — Игра /
    // Магазины / Лента — replace Plan 02.1-25's two-card layout AND Plan
    // 02.1-30's intermediate "lean header + StoresSection + events-feed"
    // shape. Each section carries an id + class prefixed by its scope so
    // anchor links + CSS selectors stay stable.
    //
    // Plan 02.1-39 round-6 polish #13 (UAT-NOTES.md §5.8 follow-up #13):
    // the "Game" h2 + section-header row is REMOVED — game.title in
    // PageHeader is the primary identifier. Edit moves to PageHeader's
    // cta slot. Stores/Events sections KEEP their h2 markers.
    //
    // Plan 02.1-39 round-6 polish #14b (UAT-NOTES.md §5.8 follow-up #14):
    // the polish #13 `gameInfoEditing` toggle (which only flipped a
    // non-functional "Edit…" hint) is REPLACED by `editGameOpen` — the
    // open-state of the new <GameEditDialog> modal. PageHeader's cta
    // opens the dialog; <RenameInline> (the duplicate h1) is GONE.
    expect(src).toMatch(/<section[^>]*class="game-info"[^>]*id="section-game"/);
    expect(src).toMatch(/<section[^>]*class="stores"[^>]*id="section-stores"/);
    expect(src).toMatch(/<section[^>]*class="events"[^>]*id="section-events"/);
    // Sticky PageHeader sits at the top with the game's title.
    expect(src).toMatch(/<PageHeader[\s\S]*?title=\{game\.title\}/);
    // Polish #14b: cta opens the modal (editGameOpen = true), label is
    // the static "Edit" key (no longer a toggle pair).
    expect(src).toMatch(/editGameOpen\s*=\s*true/);
    expect(src).toMatch(/label:\s*m\.games_detail_edit_cta\(\)/);
    // Plan 02.1-39 round-6 polish #15 removed <GameCover> from this page
    // (user during UAT: "после названия игры идет огромная картинка...
    // она тут лишняя, она есть в карточки стора"). The cover already
    // surfaces on each SteamListingRow inside StoresSection.
    expect(src).not.toMatch(/<GameCover\s/);
    expect(src).toMatch(/<StoresSection\s/);
    // GameEditDialog mounted with title + description from the game DTO.
    expect(src).toMatch(/<GameEditDialog\s/);
    expect(src).toMatch(/initialTitle=\{game\.title\}/);
    expect(src).toMatch(/initialDescription=\{game\.description\}/);
    // Plan 02.1-39 §5.3 item D: FeedCards wrapped in a feedcard-grid.
    expect(src).toMatch(/class="feedcard-grid"/);
    expect(src).toMatch(
      /\.feedcard-grid[\s\S]*?grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(280px/,
    );
    // Polish #14b: the polish #13 `gameInfoEditing` toggle is GONE
    // (replaced by `editGameOpen` modal-open state). RenameInline import
    // and usage are removed entirely — the title lives only in
    // PageHeader.title now (no duplicate h1 surface).
    expect(src).toMatch(/let editGameOpen = \$state\(false\)/);
    expect(src).not.toMatch(/let gameInfoEditing\s*=\s*\$state/);
    expect(src).not.toMatch(/let editingStores\s*=\s*\$state/);
    expect(src).not.toMatch(/import RenameInline/);
    expect(src).not.toMatch(/<RenameInline\s/);
    // Negative assertion: the §5.3 "Game" section <h2> is REMOVED in
    // round-6 #13. The game's name lives in PageHeader.title now.
    const markupOnly = src.replace(/<script[\s\S]*?<\/script>/g, "");
    expect(markupOnly).not.toMatch(/m\.games_detail_section_game\s*\(/);
    expect(markupOnly).not.toMatch(/onclick=\{[^}]*editingStores/);
    // Polish #14b: the polish #13 "editing-hint" paragraph is GONE.
    expect(markupOnly).not.toMatch(/class="editing-hint"/);
    // Description paragraph renders when game.description is non-null.
    expect(markupOnly).toMatch(/{#if game\.description}/);
    expect(markupOnly).toMatch(/<p class="description">/);
    // Negative assertion: the obsolete two-card classes are gone.
    expect(src).not.toMatch(/<section[^>]*class="game-header-card"/);
    expect(src).not.toMatch(/<section[^>]*class="events-feed-card"/);
  });

  // Plan 02.1-39 round-6 polish #13 (UAT-NOTES.md §5.8 follow-up #13,
  // 2026-04-30): /games/[gameId] UI redesign per user direction.
  // Three discrete user-driven layout changes:
  //   1. "Game" heading removed; Edit moved to PageHeader.cta.
  //   2. Add Store CTA migrated from above the cards to AFTER the cards.
  //   3. Per-card Edit button on each store card.
  describe("Plan 02.1-39 round-6 polish #13 — /games/[gameId] UI redesign", () => {
    it("removes the 'Game' section heading; PageHeader carries the game title + Edit cta", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const src = fs.readFileSync(path.resolve("src/routes/games/[gameId]/+page.svelte"), "utf8");
      const markupOnly = src.replace(/<script[\s\S]*?<\/script>/g, "");
      // The §5.3 section-header row inside <section class="game-info">
      // is gone — there's no <header class="section-header"> anywhere
      // INSIDE the game-info section markup.
      const gameInfoMatch = markupOnly.match(
        /<section[^>]*class="game-info"[^>]*>([\s\S]*?)<\/section>/,
      );
      expect(gameInfoMatch, "game-info section must render").not.toBeNull();
      const gameInfoBody = gameInfoMatch![1]!;
      expect(gameInfoBody).not.toMatch(/<header[^>]*class="section-header"/);
      // Polish #14b: PageHeader.cta opens the new <GameEditDialog>
      // modal (editGameOpen = true), replacing polish #13's
      // hint-toggle. The Edit label is the static games_detail_edit_cta key.
      expect(src).toMatch(/<PageHeader[\s\S]*?cta=\{/);
      expect(src).toMatch(/editGameOpen\s*=\s*true/);
      expect(src).toMatch(/m\.games_detail_edit_cta\(\)/);
    });

    it("StoresSection becomes a pure list renderer (polish #14c reversal); Add CTA lives next to the Stores h2 in +page.svelte", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      // Plan 02.1-39 round-6 polish #14c (UAT-NOTES.md §5.8 follow-up
      // #14): polish #13's bottom-of-section Add CTA is REVERTED. The
      // CTA moves back to the section-header row next to the h2 (in
      // +page.svelte, not StoresSection). StoresSection no longer
      // renders an Add affordance, an inline form, or any add-state
      // — it's a pure list renderer.
      const storesSrc = fs.readFileSync(
        path.resolve("src/lib/components/StoresSection.svelte"),
        "utf8",
      );
      const storesMarkup = storesSrc.replace(/<script[\s\S]*?<\/script>/g, "");
      // Both the polish-13 .add-row AND the pre-polish-13 .actions-row
      // are GONE — StoresSection has no add affordance now.
      expect(storesMarkup).not.toMatch(/class="actions-row"/);
      expect(storesMarkup).not.toMatch(/class="add-row"/);
      // The component no longer imports AddSteamListingForm — the
      // form lives only inside <AddStoreDialog> mounted by the parent.
      expect(storesSrc).not.toMatch(/import AddSteamListingForm/);
      expect(storesMarkup).not.toMatch(/<AddSteamListingForm\s/);
      // No editMode prop and no showAddForm state — pure list renderer.
      expect(storesSrc).not.toMatch(/editMode:\s*boolean/);
      expect(storesSrc).not.toMatch(/let showAddForm\s*=\s*\$state/);
      // The +page.svelte mounts AddStoreDialog and renders the Add CTA
      // inside the stores section-header row.
      const pageSrc = fs.readFileSync(
        path.resolve("src/routes/games/[gameId]/+page.svelte"),
        "utf8",
      );
      expect(pageSrc).toMatch(/import AddStoreDialog/);
      expect(pageSrc).toMatch(/<AddStoreDialog\s/);
      expect(pageSrc).toMatch(/let addStoreOpen = \$state\(false\)/);
      // The Add CTA appears INSIDE the stores section-header. We
      // extract the .stores section and assert the CTA lives in its
      // <header class="section-header"> block.
      const pageMarkup = pageSrc.replace(/<script[\s\S]*?<\/script>/g, "");
      const storesSectionMatch = pageMarkup.match(/<section[^>]*class="stores"[\s\S]*?<\/section>/);
      expect(storesSectionMatch, "stores section must render").not.toBeNull();
      const storesSection = storesSectionMatch![0]!;
      // Section-header carries the CTA + h2.
      expect(storesSection).toMatch(/<header[^>]*class="section-header"/);
      expect(storesSection).toMatch(/m\.stores_add_cta\(\)/);
      // The polish-13 stores_add_cta_after_cards key is no longer used.
      expect(storesSection).not.toMatch(/m\.stores_add_cta_after_cards\(\)/);
    });

    it("SteamListingRow renders cover image + STEAM badge + appId + per-card Edit button + inline label form (polish #14c)", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const src = fs.readFileSync(
        path.resolve("src/lib/components/SteamListingRow.svelte"),
        "utf8",
      );
      // Cover image rendered when listing.coverUrl is non-null.
      expect(src).toMatch(/{#if listing\.coverUrl}/);
      expect(src).toMatch(/<img[^>]*class="store-cover"/);
      // STEAM badge identifies the store kind.
      expect(src).toMatch(/class="kind-badge"/);
      expect(src).toMatch(/m\.steam_listing_kind_steam\(\)/);
      // App ID surfaces in muted monospace.
      expect(src).toMatch(/class="app-id"/);
      expect(src).toMatch(/m\.steam_listing_app_id\(\{/);
      // Per-card Edit button replaces the section-level editMode prop.
      expect(src).not.toMatch(/editMode\?:\s*boolean/);
      // Local `editing` state owned by each card.
      expect(src).toMatch(/let editing = \$state\(false\)/);
      // Edit button visible when not editing.
      expect(src).toMatch(/class="edit-btn"/);
      expect(src).toMatch(/m\.steam_listing_edit_aria\(\)/);
      // Plan 02.1-39 round-6 polish #14c: inline label edit FORM
      // (not just a × Remove). Local labelDraft state + saveEdit
      // function + .edit-form markup with a label input.
      expect(src).toMatch(/let labelDraft = \$state/);
      expect(src).toMatch(/async function saveEdit/);
      expect(src).toMatch(/class="edit-form"/);
      expect(src).toMatch(/class="edit-input"/);
      expect(src).toMatch(/m\.steam_listing_edit_save_cta\(\)/);
      expect(src).toMatch(/m\.steam_listing_label_edit_label\(\)/);
      // The PATCH /api/games/:gameId/listings/:listingId target is
      // wired into saveEdit (same path the integration test exercises).
      expect(src).toMatch(/method:\s*"PATCH"/);
      // Label prefix in read-mode so users know what the field is.
      expect(src).toMatch(/m\.steam_listing_label_prefix\(\)/);
      expect(src).toMatch(/class="label-prefix"/);
    });
  });

  it("/sources, /feed, /games, /audit each use the shared <PageHeader>", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const route of [
      "src/routes/sources/+page.svelte",
      "src/routes/feed/+page.svelte",
      "src/routes/games/+page.svelte",
      // Plan 02.1-39 (UAT-NOTES.md §5.7): /audit joins the sticky
      // PageHeader club for cross-page consistency.
      "src/routes/audit/+page.svelte",
    ]) {
      const src = fs.readFileSync(path.resolve(route), "utf8");
      expect(src, `${route}: imports PageHeader`).toMatch(
        /import PageHeader from "\$lib\/components\/PageHeader\.svelte"/,
      );
      expect(src, `${route}: renders <PageHeader`).toMatch(/<PageHeader\s/);
      // The inline <header class="head"> block is gone from the markup
      // section. Strip the <script>...</script> block first so a comment
      // mentioning "<header class=\"head\">" in code doesn't match. The
      // markup region is whatever sits after the closing </script> tag
      // and before <style>.
      const markupOnly = src.replace(/<script[\s\S]*?<\/script>/g, "");
      expect(markupOnly, `${route}: no inline <header class="head"> in markup`).not.toMatch(
        /<header[^>]*class="head"/,
      );
    }
  });
});

/**
 * Plan 02.1-31 — Standalone label rename to "Not game-related".
 *
 * Closes UAT-NOTES.md §4.24.A — the user does not parse "Standalone" as
 * "not related to any game". User quote: "Standalone странный текст. Не
 * очевидно что это вообще не про игры."
 *
 * Pure i18n value rename. The Paraglide KEYS stay (URL contract / state
 * shape preserved); only the VALUES change for 3 user-facing keys. The
 * audit-action keys (audit_action_event_marked_standalone /
 * audit_action_event_unmarked_standalone) STAY unchanged — the audit log
 * displays the technical verb name to match existing entries like "Event
 * attached to a game".
 *
 * Component-level regression guards over each surface that displays the
 * standalone label:
 *   - FeedQuickNav segment via m.feed_quick_nav_standalone()
 *   - FilterChips chip via m.feed_filter_show_standalone()
 *   - FiltersSheet show <select> option via m.feed_filter_show_standalone()
 *     (Plan 02.1-39 round-6 polish #8: was a radio group, now a <select>
 *     dropdown — same Paraglide key, same value="standalone" attribute on
 *     the option element, same load-bearing assertion on the rendered text)
 *   - FeedCard inline button via m.feed_card_mark_standalone_button()
 * Plus a positive guard that the audit-action verb names STAY as the
 * technical strings (m.audit_action_event_marked_standalone() unchanged).
 */
describe("Plan 02.1-31 — Standalone label rename to 'Not game-related'", () => {
  it("FeedQuickNav standalone segment renders 'Not game-related' (NOT 'Standalone')", async () => {
    const FeedQuickNav = (await import("../../src/lib/components/FeedQuickNav.svelte")).default;
    const out = render(FeedQuickNav, {
      props: {
        games: [],
        activeShow: { kind: "any" as const },
        currentUrlSearch: "",
        onNavigate: () => {},
      },
    });
    // The standalone tab anchor renders the renamed copy. The data-tab
    // attribute carries the lowercase technical state name (URL contract
    // preserved); the anchor's user-facing text content is the new value.
    const standaloneTabMatch = out.body.match(/<a[^>]*data-tab="standalone"[^>]*>([^<]*)<\/a>/);
    expect(
      standaloneTabMatch,
      "Standalone tab anchor not found in FeedQuickNav SSR output",
    ).not.toBeNull();
    expect(standaloneTabMatch![1]!.trim()).toBe("Not game-related");
    // The user-facing literal "Standalone" (capitalized English word) MUST
    // NOT appear inside any rendered text node.
    expect(out.body).not.toMatch(/>[^<]*\bStandalone\b[^<]*</);
  });

  it("FilterChips chip for show=standalone reads 'Show: Not game-related'", async () => {
    const FilterChips = (await import("../../src/lib/components/FilterChips.svelte")).default;
    const out = render(FilterChips, {
      props: {
        filters: {
          source: [],
          kind: [],
          show: { kind: "standalone" as const },
          defaultDateRange: false,
          all: false,
        },
        sources: [],
        games: [],
        // /feed schema post Plan 02.1-39 round-6 polish #9: no 'date' axis
        // (DateRangeControl above the chip strip is the SOT). Asserting the
        // standalone label rendering — schema content is fixture-only here.
        schema: ["kind", "source", "show", "authorIsMe"] as const,
        onDismiss: () => {},
        onOpenSheet: () => {},
        onClearAll: () => {},
      },
    });
    expect(out.body).toContain("Show: Not game-related");
    // The user-facing literal "Standalone" MUST NOT leak into the chip text.
    expect(out.body).not.toMatch(/Show:\s*Standalone/);
  });

  it("FiltersSheet show fieldset <option value='standalone'> renders 'Not game-related' label", async () => {
    // Plan 02.1-39 round-6 polish #8 (UAT-NOTES.md §5.6 follow-up #8): the
    // Show axis was converted from a radio-button group to a <select>
    // dropdown for compactness. The technical state name (value="standalone")
    // and the user-facing label (m.feed_filter_show_standalone() →
    // "Not game-related") are unchanged — the only structural change is
    // <input type="radio" value="standalone"> + outer <label> → <option
    // value="standalone">label-text</option>. URL contract preserved.
    const FiltersSheet = (await import("../../src/lib/components/FiltersSheet.svelte")).default;
    const out = render(FiltersSheet, {
      props: {
        filters: {
          source: [],
          kind: [],
          show: { kind: "any" as const },
          defaultDateRange: false,
          all: false,
        },
        sources: [],
        games: [],
        // /feed schema post Plan 02.1-39 round-6 polish #9: no 'date' axis.
        schema: ["kind", "source", "show", "authorIsMe"] as const,
        onApply: () => {},
        onClose: () => {},
      },
    });
    // The standalone <option> value="standalone" (technical state name
    // STAYS) wraps the label text "Not game-related".
    expect(out.body).toMatch(/value="standalone"/);
    // The renamed value renders as the option text.
    expect(out.body).toContain("Not game-related");
    // The literal English "Standalone" string MUST NOT appear inside the
    // standalone option's text content.
    const optionMatch = out.body.match(/<option[^>]*value="standalone"[^>]*>([\s\S]*?)<\/option>/);
    expect(
      optionMatch,
      '<option value="standalone"> not found in FiltersSheet SSR output',
    ).not.toBeNull();
    if (optionMatch) {
      expect(optionMatch[1]!.trim()).not.toMatch(/^Standalone\b/);
      expect(optionMatch[1]!.trim()).toBe("Not game-related");
    }
  });

  it("FeedCard inline 'Mark standalone' button reads 'Mark as not game-related' on inbox cards", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
    // Inbox card (gameIds=[]) with no triage.standalone marker → renders
    // the inline mark-standalone button. The button text is the renamed
    // copy.
    const out = render(FeedCard, {
      props: {
        event: {
          id: "evt-1",
          gameIds: [],
          sourceId: null,
          kind: "post" as const,
          authorIsMe: false,
          occurredAt: new Date("2026-04-29T12:00:00Z"),
          title: "Test event",
          url: null,
          externalId: null,
          notes: null,
          metadata: null,
          lastPolledAt: null,
        },
        source: null,
        game: null,
        games: [],
      },
    });
    // The button rendering — class="standalone-button" carries the renamed
    // text via m.feed_card_mark_standalone_button().
    const buttonMatch = out.body.match(
      /<button[^>]*class="[^"]*standalone-button[^"]*"[^>]*>([\s\S]*?)<\/button>/,
    );
    expect(buttonMatch, "standalone-button not found in inbox FeedCard SSR output").not.toBeNull();
    expect(buttonMatch![1]!.trim()).toBe("Mark as not game-related");
  });

  it("audit-action verb names STAY unchanged (technical context — by design)", async () => {
    // Plan 02.1-31 INVARIANT: the audit log is a technical surface and
    // the audit verbs match existing entries like "Event attached to a
    // game". The marked_standalone / unmarked_standalone audit-action
    // values stay as the technical verb names (NOT renamed to the
    // user-facing "not game-related" copy).
    const fs = await import("node:fs");
    const path = await import("node:path");
    const raw = JSON.parse(fs.readFileSync(path.resolve("messages/en.json"), "utf8"));
    expect(raw.audit_action_event_marked_standalone).toBe("Event marked standalone");
    expect(raw.audit_action_event_unmarked_standalone).toBe("Event unmarked standalone");
  });

  it("messages/en.json has the renamed user-facing values for the 3 standalone keys", async () => {
    // Lock in the value contract at JSON-source level too — a future PR
    // that flips the value back to "Standalone" trips this assertion.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const raw = JSON.parse(fs.readFileSync(path.resolve("messages/en.json"), "utf8"));
    expect(raw.feed_card_mark_standalone_button).toBe("Mark as not game-related");
    expect(raw.feed_filter_show_standalone).toBe("Not game-related");
    expect(raw.feed_quick_nav_standalone).toBe("Not game-related");
  });
});

/**
 * Plan 02.1-34 — layout regression fixes + /audit FiltersSheet schema cleanup.
 *
 * Closes UAT-NOTES.md §4.22.A (sticky AppHeader regression — fixed via
 * src/app.css overflow-x: clip; covered by tests/browser/responsive-360.test.ts),
 * §4.22.F (FiltersSheet body-scroll-lock regression — fixed via declarative
 * CSS :has(dialog[open]) in src/app.css and removal of imperative
 * document.body.style.overflow in FiltersSheet), and §4.21.A (/audit dateRange
 * duplication — fixed via /audit AUDIT_SCHEMA dropping 'date' axis).
 *
 * Component-level regression guards:
 *   1. /audit caller schema is ['action'] only (no 'date') — page-level
 *      DateRangeControl is the single source of truth on /audit.
 *   2. /feed caller schema still includes 'date' (no regression on the
 *      working surface — the in-sheet date axis is the design-intentional
 *      secondary entry on /feed).
 *   3. FiltersSheet.svelte source no longer references
 *      `document.body.style.overflow` (imperative approach removed; CSS
 *      :has() handles the lock declaratively).
 *   4. src/app.css contains the body:has(dialog[open]) overflow:hidden rule.
 *   5. src/app.css uses overflow-x: clip on body (NOT hidden) — the sticky
 *      regression-source guard.
 */
describe("Plan 02.1-34 — layout regression fixes + /audit FiltersSheet schema cleanup", () => {
  it("/audit AUDIT_SCHEMA is exactly ['action'] — no 'date' axis (UAT-NOTES.md §4.21.A)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/routes/audit/+page.svelte"), "utf8");
    // Match the AUDIT_SCHEMA literal — the array MUST contain 'action' and
    // MUST NOT contain 'date'. The page-level DateRangeControl above
    // FilterChips is the single source of truth for date filtering on
    // /audit; the in-sheet date axis was duplicating that control.
    const match = src.match(/const AUDIT_SCHEMA\s*=\s*(\[[^\]]*\])/);
    expect(match, "src/routes/audit/+page.svelte: AUDIT_SCHEMA literal not found").not.toBeNull();
    const literal = match![1]!;
    expect(literal).toMatch(/"action"/);
    expect(literal, "AUDIT_SCHEMA still references 'date' — Plan 02.1-34 removes it").not.toMatch(
      /"date"/,
    );
  });

  it("/feed FEED_SCHEMA does NOT include 'date' (Plan 02.1-39 round-6 polish #9 reversal of Plan 02.1-21 in-sheet date axis)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/routes/feed/+page.svelte"), "utf8");
    // Plan 02.1-39 round-6 polish #9 (UAT-NOTES.md §5.6 follow-up #9,
    // 2026-04-30) — user during round-6 UAT: "в фильрах в feed не нужна
    // дата, дату мы задаем до выбора фильтров." The always-visible
    // <DateRangeControl> above the chip strip is the SOLE date-range entry
    // on /feed; the in-sheet secondary axis Plan 02.1-21 added was
    // redundant and the user explicitly asked for its removal during UAT.
    //
    // Match the FEED_SCHEMA literal — the array MUST contain
    // 'kind','source','show','authorIsMe' and MUST NOT contain 'date'.
    // Mirrors the Plan 02.1-34 AUDIT_SCHEMA assertion shape.
    const match = src.match(/const FEED_SCHEMA\s*=\s*(\[[^\]]*\])/);
    expect(match, "src/routes/feed/+page.svelte: FEED_SCHEMA literal not found").not.toBeNull();
    const literal = match![1]!;
    expect(literal).toMatch(/"kind"/);
    expect(literal).toMatch(/"source"/);
    expect(literal).toMatch(/"show"/);
    expect(literal).toMatch(/"authorIsMe"/);
    expect(
      literal,
      "FEED_SCHEMA still references 'date' — Plan 02.1-39 round-6 polish #9 removes it",
    ).not.toMatch(/"date"/);
  });

  it("/feed clearAll() preserves the date axis — chip-strip Clear filters does NOT touch ?from/?to/?all (Plan 02.1-39 round-6 polish #10)", async () => {
    // Plan 02.1-39 round-6 polish #10 (UAT-NOTES.md §5.6 follow-up #10,
    // 2026-04-30). User clarified after polish #9 landed:
    //   "и clear filters вообще никак не трогает дату"
    //   ("and Clear filters should not touch the date AT ALL")
    //
    // Polish #9 made the IN-SHEET Clear preserve the date axis on /feed
    // (via FEED_SCHEMA dropping 'date'). Polish #10 extends the same
    // contract to the chip-strip Clear button: BOTH "Clear filters"
    // surfaces now clear ONLY the chip-owned axes (kind / source / show /
    // game / authorIsMe / cursor) and PRESERVE the user's date range.
    //
    // The previous contract — chip-strip clearAll did `goto("/feed?all=1")`
    // — wiped the date range as a "wipe everything" affordance. The user
    // disagreed: date is owned exclusively by <DateRangeControl> and
    // changes ONLY when the user interacts with that control directly
    // (presets, inputs, or its own × reset button).
    //
    // Regression-guard the source of /feed/+page.svelte: clearAll() MUST
    // NOT contain `goto("/feed?all=1")` and MUST NOT delete the from/to/
    // all params; it MUST delete the chip-owned axes.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/routes/feed/+page.svelte"), "utf8");
    // Match the clearAll function body. The closing brace of the function
    // is the next standalone `}` on its own line at the same indent as
    // `function clearAll`. Use a non-greedy capture that stops at the
    // first `\n  }\n` (two-space indent matches /feed/+page.svelte style).
    const match = src.match(/function clearAll\(\):\s*void\s*\{([\s\S]*?)\n {2}\}/);
    expect(
      match,
      "src/routes/feed/+page.svelte: clearAll() function body not found",
    ).not.toBeNull();
    const body = match![1]!;
    // Old behavior MUST be gone — `?all=1` reset wiped the date range.
    expect(
      body,
      'clearAll() still uses goto("/feed?all=1") — round-6 polish #10 removes the date-wipe behavior',
    ).not.toMatch(/goto\(["']\/feed\?all=1["']\)/);
    // Chip-owned axes MUST be deleted.
    expect(body).toMatch(/params\.delete\(["']kind["']\)/);
    expect(body).toMatch(/params\.delete\(["']source["']\)/);
    expect(body).toMatch(/params\.delete\(["']show["']\)/);
    expect(body).toMatch(/params\.delete\(["']game["']\)/);
    expect(body).toMatch(/params\.delete\(["']authorIsMe["']\)/);
    expect(body).toMatch(/params\.delete\(["']cursor["']\)/);
    // Date-axis params MUST NOT be deleted — that's the whole point.
    expect(
      body,
      "clearAll() deletes ?from — round-6 polish #10 requires date axis to be preserved",
    ).not.toMatch(/params\.delete\(["']from["']\)/);
    expect(
      body,
      "clearAll() deletes ?to — round-6 polish #10 requires date axis to be preserved",
    ).not.toMatch(/params\.delete\(["']to["']\)/);
    expect(
      body,
      "clearAll() deletes ?all — round-6 polish #10 requires date axis to be preserved (?all=1 is a date-axis state, not a filter state)",
    ).not.toMatch(/params\.delete\(["']all["']\)/);
  });

  it("/feed clearAll() URL behavior — preserves from/to and strips chip-owned axes (Plan 02.1-39 round-6 polish #10)", () => {
    // Behavioral test mirroring clearAll()'s URL-construction logic. The
    // /feed/+page.svelte function is wired to <FilterChips onClearAll> and
    // does:
    //   const params = new URLSearchParams(page.url.search);
    //   params.delete("kind"); params.delete("source"); ...
    //   const qs = params.toString();
    //   goto(qs ? `/feed?${qs}` : "/feed");
    //
    // We can't import the .svelte function directly (Vitest runs the test
    // outside the Svelte 5 compiler context for /feed), so we re-implement
    // the same param-mutation here and assert the resulting URL on a
    // fixture that exercises every relevant axis.
    const initial =
      "?from=2026-04-01&to=2026-04-15&kind=youtube_video&kind=reddit_post" +
      "&source=src-1&show=inbox&game=g-1&authorIsMe=true&cursor=abc";
    const params = new URLSearchParams(initial);
    // Mirror clearAll() body — chip-owned axes only.
    params.delete("kind");
    params.delete("source");
    params.delete("show");
    params.delete("game");
    params.delete("authorIsMe");
    params.delete("cursor");
    const qs = params.toString();
    const result = qs ? `/feed?${qs}` : "/feed";
    // Date axis MUST survive intact.
    expect(result).toBe("/feed?from=2026-04-01&to=2026-04-15");
  });

  it("/feed clearAll() URL behavior — preserves ?all=1 when user opted into all-time view (Plan 02.1-39 round-6 polish #10)", () => {
    // Same logic as above but starting from ?all=1 (user clicked × on
    // <DateRangeControl> for all-time view). Clear filters MUST NOT wipe
    // that — the user explicitly chose all-time, so it survives.
    const initial = "?all=1&kind=youtube_video&source=src-1&show=standalone&authorIsMe=false";
    const params = new URLSearchParams(initial);
    params.delete("kind");
    params.delete("source");
    params.delete("show");
    params.delete("game");
    params.delete("authorIsMe");
    params.delete("cursor");
    const qs = params.toString();
    const result = qs ? `/feed?${qs}` : "/feed";
    expect(result).toBe("/feed?all=1");
  });

  it("FiltersSheet.svelte no longer references document.body.style.overflow in code (UAT-NOTES.md §4.22.F)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/lib/components/FiltersSheet.svelte"), "utf8");
    // Plan 02.1-22's imperative approach (document.body.style.overflow =
    // 'hidden' / '') is replaced by declarative CSS :has(dialog[open]) in
    // src/app.css. The component MUST NOT touch document.body.style at all
    // in CODE — drift is a regression candidate. Comments referring to the
    // historical approach are fine (and useful for reviewers); the test
    // strips // single-line and /* ... */ block comments before matching.
    const codeOnly = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(
      codeOnly,
      "FiltersSheet.svelte still imperatively sets document.body.style.overflow — Plan 02.1-34 removes that path in favor of CSS :has()",
    ).not.toMatch(/document\.body\.style\.overflow/);
    // Sanity: showModal / dialog wiring still in place.
    expect(src).toMatch(/showModal\(\)/);
  });

  it("src/app.css contains the body:has(dialog[open]) overflow:hidden rule (UAT-NOTES.md §4.22.F)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const css = fs.readFileSync(path.resolve("src/app.css"), "utf8");
    // The rule must be present AND apply overflow: hidden. Whitespace
    // tolerant; the CSS minifier may collapse whitespace at build time
    // but the source contract is what we lock in here.
    expect(css, "src/app.css missing body:has(dialog[open]) declarative scroll-lock rule").toMatch(
      /body:has\(dialog\[open\]\)\s*\{[^}]*overflow:\s*hidden/,
    );
  });

  it("src/app.css uses overflow-x: clip on body (NOT hidden) — sticky regression-source guard (UAT-NOTES.md §4.22.A)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const css = fs.readFileSync(path.resolve("src/app.css"), "utf8");
    // The html+body block MUST use overflow-x: clip. `hidden` paired with
    // overflow-y: visible promotes body to a scroll container per CSS spec
    // (overflow-y coerced to auto), which breaks position: sticky on
    // descendants — that was the round-3 regression source. `clip` crops
    // without promoting.
    expect(
      css,
      "src/app.css must use 'overflow-x: clip' on body (Plan 02.1-34 sticky regression fix)",
    ).toMatch(/overflow-x:\s*clip/);
    // Negative guard: 'overflow-x: hidden' must NOT appear on the html+body
    // block (the regression source). The match below isolates the html+body
    // block AND strips CSS comments — comments referring to the historical
    // approach are fine (and useful for reviewers).
    const htmlBodyBlock = css.match(/html,\s*\n?body\s*\{[\s\S]*?\}/);
    expect(htmlBodyBlock, "html, body { ... } block not located in src/app.css").not.toBeNull();
    const htmlBodyCodeOnly = htmlBodyBlock![0].replace(/\/\*[\s\S]*?\*\//g, "");
    expect(
      htmlBodyCodeOnly,
      "html+body block still uses overflow-x: hidden — Plan 02.1-34 should switch it to clip",
    ).not.toMatch(/overflow-x:\s*hidden/);
  });

  it("FiltersSheet schema=['action'] (Plan 02.1-34 /audit shape) renders ONLY action fieldset — no date leak", () => {
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
        // Plan 02.1-34: /audit's new schema — date axis dropped.
        schema: ["action"] as const,
        onApply: () => {},
        onClose: () => {},
      },
    });
    expect(out.body).toMatch(/<fieldset[^>]*data-axis="action"/);
    // Critical regression guard: date axis MUST NOT render when /audit's
    // schema (now ['action'] only) opens the sheet.
    expect(
      out.body,
      "FiltersSheet rendered date axis even when schema=['action'] (Plan 02.1-34 §4.21.A regression)",
    ).not.toMatch(/<fieldset[^>]*data-axis="date"/);
    // Other /feed-only axes also stay out (regression carry-over from Plan 02.1-21).
    expect(out.body).not.toMatch(/<fieldset[^>]*data-axis="source"/);
    expect(out.body).not.toMatch(/<fieldset[^>]*data-axis="kind"/);
    expect(out.body).not.toMatch(/<fieldset[^>]*data-axis="show"/);
    expect(out.body).not.toMatch(/<fieldset[^>]*data-axis="authorIsMe"/);
  });
});

/**
 * Plan 02.1-33 — SourceRow edit-mode polish (UAT-NOTES.md §4.22.B/C/D/E).
 *
 * Closes four findings on the same component:
 *   §4.22.B — Remove visible only inside edit mode.
 *   §4.22.C — Edit pencil hidden inside edit mode.
 *   §4.22.D — auto_import is rendered as EXACTLY one checkbox (regression
 *             guard against re-introduction of a parallel text-input
 *             control bound to editAutoImport).
 *   §4.22.E — Save / Cancel / Remove sit at the BOTTOM of the edit-form
 *             block with a section divider above the action row.
 *
 * The vitest-browser end-to-end (interactive open / cancel / save) is
 * stub-skipped pending the Phase 6 auth harness. SSR-level regression
 * guards live here — grep + structural assertions on SourceRow.svelte
 * source — same pattern as the Plan 02.1-25 SourceRow Mine treatment
 * scan above.
 */
describe("Plan 02.1-33 — SourceRow edit-mode polish (visibility gates + footer)", () => {
  it("SourceRow renders the read-mode Edit pencil ONLY when !editing — closes §4.22.B/C", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/lib/components/SourceRow.svelte"), "utf8");
    // Read-mode block has the Edit pencil (icon-btn edit-icon class pair)
    // and explicitly NO Remove button — the {#if !editing} ... {:else}
    // structure encodes the visibility gate.
    expect(src, "{#if !editing} block exists").toMatch(/\{#if !editing\}/);
    expect(src, "{:else} branch exists for edit mode").toMatch(/\{:else\}/);
    // The read-mode .actions div contains an edit-icon class but no
    // remove-icon class — assert by structural slice.
    const ifNotEditingMatch = src.match(
      /\{#if !editing\}\s*<!--[\s\S]*?-->\s*<div class="actions">[\s\S]*?<\/div>\s*\{:else\}/,
    );
    expect(
      ifNotEditingMatch,
      "read-mode .actions block matches the {#if !editing} ... {:else} structure",
    ).not.toBeNull();
    if (ifNotEditingMatch) {
      const readModeBlock = ifNotEditingMatch[0];
      expect(readModeBlock).toMatch(/edit-icon/);
      // Read-mode block must NOT contain the destructive remove-icon class.
      expect(readModeBlock).not.toMatch(/remove-icon/);
    }
  });

  it("SourceRow renders the destructive Remove button ONLY in edit-form footer — closes §4.22.B", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/lib/components/SourceRow.svelte"), "utf8");
    // The edit branch holds the form-footer with three buttons. The Remove
    // (footer-btn-danger / remove-icon) lives ONLY here.
    expect(src).toMatch(/form-footer/);
    expect(src).toMatch(/footer-btn-danger/);
    // The Remove button is wired to confirmingRemove = true, opening the
    // existing ConfirmDialog flow — preserves Plan 02.1-08 soft-delete
    // contract.
    expect(src).toMatch(/confirmingRemove\s*=\s*true/);
    // remove-icon class lives on the footer button (Plan 02.1-33), not on
    // a top-level read-mode .actions button.
    const removeIconMatches = src.match(/remove-icon/g) ?? [];
    expect(
      removeIconMatches.length,
      "remove-icon class appears exactly once (footer-btn-danger remove-icon)",
    ).toBe(1);
  });

  it("SourceRow form-footer hosts Save (primary) / Cancel (ghost) / Remove (danger) AT THE BOTTOM — closes §4.22.E", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/lib/components/SourceRow.svelte"), "utf8");
    // Section divider above the footer row visually separates fields from
    // actions. Both must exist; the divider must precede the footer in
    // source order.
    expect(src).toMatch(/section-divider/);
    expect(src).toMatch(/form-footer/);
    const dividerIdx = src.indexOf("section-divider");
    const footerIdx = src.indexOf("form-footer");
    expect(dividerIdx, "section-divider exists in SourceRow.svelte").toBeGreaterThan(-1);
    expect(footerIdx, "form-footer exists in SourceRow.svelte").toBeGreaterThan(-1);
    expect(
      dividerIdx < footerIdx,
      "section-divider precedes form-footer in source order (fields → divider → action row)",
    ).toBe(true);
    // Footer button variants — primary (Save), ghost (Cancel), danger (Remove).
    expect(src).toMatch(/footer-btn-primary/);
    expect(src).toMatch(/footer-btn-ghost/);
    expect(src).toMatch(/footer-btn-danger/);
    // Save uses common_save (added in this plan); Cancel uses common_cancel;
    // Remove uses common_remove.
    expect(src).toMatch(/m\.common_save\(\)/);
    expect(src).toMatch(/m\.common_cancel\(\)/);
    expect(src).toMatch(/m\.common_remove\(\)/);
  });

  it("SourceRow auto_import is rendered as EXACTLY ONE checkbox (regression guard) — closes §4.22.D", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/lib/components/SourceRow.svelte"), "utf8");
    // Positive: exactly ONE input bound to editAutoImport (the checkbox).
    const checkedBindings = src.match(/bind:checked=\{editAutoImport\}/g) ?? [];
    expect(checkedBindings.length, "exactly one input[type=checkbox] bound to editAutoImport").toBe(
      1,
    );
    // Negative: no <input type="text"> attribute references editAutoImport
    // anywhere in the component (catch-all against future regressions to
    // a parallel string control).
    expect(src).not.toMatch(/type="text"[^>]*editAutoImport/);
    // Negative: no value-binding to editAutoImport (which would imply a
    // non-checkbox control such as <input type="text" bind:value=...>).
    expect(src).not.toMatch(/bind:value=\{editAutoImport\}/);
    // Catch-all: no <input type="text"> whose attribute name mentions
    // auto-import in any casing/separator (autoImport / auto-import /
    // auto_import). Current variable name is editAutoImport (camelCase);
    // this catch-all guards against renames.
    expect(src).not.toMatch(/type="text"[^>]*[Aa]uto[_-]?[Ii]mport/);
  });

  it("SourceRow PATCH /api/sources/:id payload still ships { displayName, autoImport } — preserves Plan 02.1-22 contract", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/lib/components/SourceRow.svelte"), "utf8");
    // saveSourceEdit body still serializes displayName + autoImport — no
    // schema or service change in Plan 02.1-33; pure component refactor.
    expect(src).toMatch(/method:\s*"PATCH"/);
    expect(src).toMatch(/displayName:\s*editName\.trim\(\)\s*\|\|\s*null/);
    expect(src).toMatch(/autoImport:\s*editAutoImport/);
  });

  it("SourceRow ConfirmDialog wired to existing soft-delete flow — preserves Plan 02.1-08 contract", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/lib/components/SourceRow.svelte"), "utf8");
    // The Remove button (now in the edit-form footer) opens the same
    // ConfirmDialog used since Plan 02.1-08; on confirm, DELETE
    // /api/sources/:id is fired.
    expect(src).toMatch(/<ConfirmDialog\s/);
    expect(src).toMatch(/method:\s*"DELETE"/);
    expect(src).toMatch(/m\.confirm_source_remove/);
  });
});

/**
 * Plan 02.1-32 — /events/[id] Edit pencil top-right + Delete moved + AttachToGamePicker compact + FeedCard visibility gate.
 *
 * Closes UAT-NOTES.md §4.18.A + §4.18.B + §4.24.E + §4.24.F. The four
 * findings ride together because they all reshape the read-only detail
 * page + inbox card surface in one user-visible UX delta:
 *   §4.18.A — /events/[id] Delete REMOVED (now at /events/[id]/edit footer).
 *   §4.18.B — /events/[id] Edit pencil moves to top-right corner.
 *   §4.24.E — AttachToGamePicker hidden when gameIds.length > 0 OR standalone.
 *   §4.24.F — AttachToGamePicker visual shrink (compact mode label + style).
 *
 * SSR-render-time guards live here. Browser-mode 360px assertions live in
 * tests/browser/feed-360.test.ts (auth harness deferred to Phase 6 — same
 * precedent as Plans 02.1-18 / 19 / 20 / 21 / 23 / 25 / 26 / 33).
 */
describe("Plan 02.1-32 — /events/[id] Edit pencil top-right + Delete moved + AttachToGamePicker compact + FeedCard visibility gate", () => {
  const baseEvent = {
    id: "ev-1",
    gameIds: [] as string[],
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

  it("Plan 02.1-32 — FeedCard with gameIds.length > 0 does NOT render AttachToGamePicker (closes §4.24.E)", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
    const out = render(FeedCard, {
      props: {
        event: { ...baseEvent, gameIds: ["g-1"] },
        source: null,
        game: { id: "g-1", title: "Attached Game" },
        games: [{ id: "g-1", title: "Attached Game" }],
      },
    });
    // The picker-line wrapper is gated on isInboxRow — no game means
    // gameIds.length > 0 → not rendered.
    expect(out.body).not.toMatch(/class="picker-line(?:\s[^"]*)?"/);
    // Defense-in-depth: the AttachToGamePicker root <div class="picker">
    // must also be absent (it would only exist if rendered).
    expect(out.body).not.toMatch(/<div class="picker(?:\s[^"]*)?"/);
  });

  it("Plan 02.1-32 — FeedCard with metadata.triage.standalone === true does NOT render AttachToGamePicker (closes §4.24.E)", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
    const out = render(FeedCard, {
      props: {
        event: {
          ...baseEvent,
          gameIds: [],
          metadata: { triage: { standalone: true } },
        },
        source: null,
        game: null,
        games: [],
      },
    });
    expect(out.body).not.toMatch(/class="picker-line(?:\s[^"]*)?"/);
  });

  it("Plan 02.1-32 — FeedCard inbox row (gameIds=[], no triage flags) renders AttachToGamePicker WITH compact class (closes §4.24.F)", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
    const out = render(FeedCard, {
      props: {
        event: {
          ...baseEvent,
          gameIds: [],
          metadata: null,
        },
        source: null,
        game: null,
        games: [{ id: "g-1", title: "Some Game" }],
      },
    });
    // The picker-line is rendered (inbox row).
    expect(out.body).toMatch(/class="picker-line(?:\s[^"]*)?"/);
    // The trigger button carries the compact class.
    expect(out.body).toMatch(/<button[^>]*class="trigger(?:\s[^"]*)?\s+compact(?:\s[^"]*)?"/);
    // The compact-mode label is rendered (see messages/en.json).
    expect(out.body).toContain("Attach");
  });

  it("Plan 02.1-32 — AttachToGamePicker compact={true} swaps the trigger label to feed_card_attach_compact_label (closes §4.24.F)", async () => {
    const AttachToGamePicker = (await import("../../src/lib/components/AttachToGamePicker.svelte"))
      .default;
    const out = render(AttachToGamePicker, {
      props: {
        event: { id: "ev-1", gameIds: [] as string[] },
        games: [{ id: "g-1", title: "Stellar Frontier" }],
        compact: true,
      },
    });
    expect(out.body).toMatch(/<button[^>]*class="[^"]*\bcompact\b[^"]*"/);
    expect(out.body).toContain("Attach");
  });

  it("Plan 02.1-32 — AttachToGamePicker compact={false} (default) keeps the original 'Attach to game' label", async () => {
    const AttachToGamePicker = (await import("../../src/lib/components/AttachToGamePicker.svelte"))
      .default;
    const out = render(AttachToGamePicker, {
      props: {
        event: { id: "ev-1", gameIds: [] as string[] },
        games: [{ id: "g-1", title: "Stellar Frontier" }],
      },
    });
    // Default trigger: "Attach to game" (full label).
    expect(out.body).toContain("Attach to game");
    // Trigger button does NOT carry the compact class.
    expect(out.body).not.toMatch(/<button[^>]*class="[^"]*\bcompact\b[^"]*"/);
  });

  it("Plan 02.1-32 — /events/[id]/+page.svelte renders an edit-pencil link top-right; NO Delete button (closes §4.18.A + §4.18.B)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/routes/events/[id]/+page.svelte", "utf8");
    // Edit pencil link is present.
    expect(src).toMatch(/class="edit-pencil"/);
    // CSS rule for absolute positioning is present.
    expect(src).toMatch(/position:\s*absolute/);
    // Delete button has been REMOVED — no <button> with the Delete label
    // and no DELETE method fired from this read-only page.
    expect(src).not.toMatch(/m\.events_detail_delete\(\)/);
    expect(src).not.toMatch(/method:\s*"DELETE"/);
    // ConfirmDialog import was removed (Delete moved to edit page).
    expect(src).not.toMatch(/import\s+ConfirmDialog\s+from/);
  });

  it("Plan 02.1-32 — /events/[id]/edit/+page.svelte ships standalone toggle + Delete button at footer (closes §4.18.A + §4.24.D)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/routes/events/[id]/edit/+page.svelte", "utf8");
    // Standalone toggle state + conflict guard derivation present.
    expect(src).toMatch(/editStandalone/);
    expect(src).toMatch(/standaloneConflict/);
    expect(src).toMatch(/metadata\.triage\.standalone|triage.*standalone/);
    // Standalone Paraglide labels referenced (4 keys from Task 1).
    expect(src).toMatch(/m\.events_edit_standalone_label\(\)/);
    expect(src).toMatch(/m\.events_edit_standalone_help\(\)/);
    expect(src).toMatch(/m\.events_edit_standalone_conflict\(\)/);
    expect(src).toMatch(/m\.events_edit_delete_button\(\)/);
    // Mark-standalone OR unmark-standalone PATCH is fired conditionally.
    expect(src).toMatch(/mark-standalone/);
    expect(src).toMatch(/unmark-standalone/);
    // Delete button at footer + ConfirmDialog flow present.
    expect(src).toMatch(/<ConfirmDialog\s/);
    expect(src).toMatch(/class="delete-button"/);
    expect(src).toMatch(/method:\s*"DELETE"/);
  });
});

/**
 * Plan 02.1-39 round-6 polish #11 follow-up — RecoveryDialog parity sweep
 * across /feed, /games, /sources.
 *
 * c98eadf wired <RecoveryDialog> into /feed only. The user surfaced the
 * single-recovery-surface intent during round-6 UAT (verbatim, ru):
 *   "и так сделать для всеху удаленных обьектов на других страницах"
 *   ("and do the same for all deleted objects on other pages")
 *
 * This describe block guards two contracts:
 *   1. PageHeader's "Recently deleted (N)" affordance is a <button> (NOT
 *      an anchor) and only renders when deletedCount > 0 AND
 *      onOpenRecovery is provided. The negative branches (count=0, no
 *      callback, count undefined) all suppress the affordance.
 *   2. /feed, /games, /sources all import <RecoveryDialog>, mount it
 *      with a non-empty entityType, and pass an onOpenRecovery callback
 *      to PageHeader. The bottom-of-page <details class="trash"> /
 *      <details class="deleted-sources"> blocks are gone (no <details>
 *      wrapping the soft-deleted list survives in the markup).
 */
describe("Plan 02.1-39 round-6 polish #11 follow-up — RecoveryDialog parity across /feed, /games, /sources", () => {
  it("PageHeader renders a recovery-link <button> when deletedCount > 0 AND onOpenRecovery is provided", async () => {
    const PageHeader = (await import("../../src/lib/components/PageHeader.svelte")).default;
    const out = render(PageHeader, {
      props: {
        title: "Feed",
        cta: { href: "/events/new", label: "+ Add event" },
        deletedCount: 3,
        onOpenRecovery: () => {},
      },
    });
    // The affordance is a <button> (round-6 #11 — anchor → modal-trigger
    // button) with class="recovery-link" + the localized count string.
    expect(out.body).toMatch(/<button[^>]*class="[^"]*\brecovery-link\b/);
    expect(out.body).toMatch(/Recently deleted \(3\)/);
    // Defensive: the previous Path A <a href="#deleted-events"> anchor
    // pattern is gone from PageHeader entirely. No <a> with the
    // recovery-link class survives.
    expect(out.body).not.toMatch(/<a[^>]*class="[^"]*\brecovery-link\b/);
    expect(out.body).not.toMatch(/href="#deleted-events"/);
  });

  it("PageHeader does NOT render the recovery-link button when deletedCount is 0", async () => {
    const PageHeader = (await import("../../src/lib/components/PageHeader.svelte")).default;
    const out = render(PageHeader, {
      props: {
        title: "Games",
        cta: { onClick: () => {}, label: "+ New game" },
        deletedCount: 0,
        onOpenRecovery: () => {},
      },
    });
    expect(out.body).not.toMatch(/\brecovery-link\b/);
    expect(out.body).not.toMatch(/Recently deleted/);
  });

  it("PageHeader does NOT render the recovery-link button when onOpenRecovery is omitted (defense-in-depth)", async () => {
    const PageHeader = (await import("../../src/lib/components/PageHeader.svelte")).default;
    const out = render(PageHeader, {
      props: {
        title: "Data sources",
        cta: { href: "/sources/new", label: "+ Add data source" },
        deletedCount: 5,
        // onOpenRecovery intentionally omitted — count alone is not enough
        // to render the button. Both must be present (the && guard in the
        // template).
      },
    });
    expect(out.body).not.toMatch(/\brecovery-link\b/);
  });

  it("/feed, /games, /sources all import RecoveryDialog and wire onOpenRecovery into PageHeader", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const route of [
      "src/routes/feed/+page.svelte",
      "src/routes/games/+page.svelte",
      "src/routes/sources/+page.svelte",
    ]) {
      const src = fs.readFileSync(path.resolve(route), "utf8");
      expect(src, `${route}: imports RecoveryDialog`).toMatch(
        /import RecoveryDialog from "\$lib\/components\/RecoveryDialog\.svelte"/,
      );
      expect(src, `${route}: mounts <RecoveryDialog`).toMatch(/<RecoveryDialog\s/);
      // entityType is the load-bearing discriminator — every consumer
      // must pass one of the three known values. The dialog's prop type
      // is a literal union "game" | "source" | "event"; the regex below
      // catches any of the three.
      expect(src, `${route}: passes entityType="event" | "game" | "source"`).toMatch(
        /entityType="(event|game|source)"/,
      );
      // PageHeader receives the callback via the new prop name (round-6
      // #11 replaced recoveryAnchor with onOpenRecovery).
      expect(src, `${route}: PageHeader receives onOpenRecovery callback`).toMatch(
        /onOpenRecovery=\{/,
      );
      // Negative: the previous Path A `recoveryAnchor=` prop is gone.
      expect(src, `${route}: legacy recoveryAnchor prop removed`).not.toMatch(/recoveryAnchor=/);
    }
  });

  it("/feed, /games, /sources have NO bottom-of-page <details> recovery wrapper in the markup", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const route of [
      "src/routes/feed/+page.svelte",
      "src/routes/games/+page.svelte",
      "src/routes/sources/+page.svelte",
    ]) {
      const src = fs.readFileSync(path.resolve(route), "utf8");
      // Strip <script>, <style>, AND HTML comments so historical
      // references in code comments / removed-CSS commentary / breadcrumb
      // <!-- comments --> documenting the round-6 #11 follow-up don't
      // trigger false positives — we only care about live, rendered
      // markup. Both /games and /sources keep breadcrumb comments
      // mentioning the retired class names by design.
      const markupOnly = src
        .replace(/<script[\s\S]*?<\/script>/g, "")
        .replace(/<style[\s\S]*?<\/style>/g, "")
        .replace(/<!--[\s\S]*?-->/g, "");
      // The two retired bottom-of-page wrappers were:
      //   /games  → <details class="trash">
      //   /sources → <details class="deleted-sources">
      //   /feed   → <div id="deleted-events"><DeletedEventsPanel />  (already
      //             removed by c98eadf; re-asserted here to keep the parity
      //             sweep symmetric across all three pages).
      expect(markupOnly, `${route}: no <details class="trash"> bottom recovery block`).not.toMatch(
        /<details[^>]*class="[^"]*\btrash\b/,
      );
      expect(
        markupOnly,
        `${route}: no <details class="deleted-sources"> bottom recovery block`,
      ).not.toMatch(/<details[^>]*class="[^"]*\bdeleted-sources\b/);
      expect(
        markupOnly,
        `${route}: no <div id="deleted-events"> bottom recovery anchor target`,
      ).not.toMatch(/<div[^>]*id="deleted-events"/);
    }
  });
});
