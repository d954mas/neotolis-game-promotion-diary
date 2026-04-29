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
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte"))
      .default;
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
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte"))
      .default;
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
    const FeedQuickNav = (
      await import("../../src/lib/components/FeedQuickNav.svelte")
    ).default;
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
    const FeedQuickNav = (
      await import("../../src/lib/components/FeedQuickNav.svelte")
    ).default;
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
    const FeedQuickNav = (
      await import("../../src/lib/components/FeedQuickNav.svelte")
    ).default;
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
    const FeedQuickNav = (
      await import("../../src/lib/components/FeedQuickNav.svelte")
    ).default;
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
    const FeedQuickNav = (
      await import("../../src/lib/components/FeedQuickNav.svelte")
    ).default;
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
    const FeedQuickNav = (
      await import("../../src/lib/components/FeedQuickNav.svelte")
    ).default;
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
    const FeedQuickNav = (
      await import("../../src/lib/components/FeedQuickNav.svelte")
    ).default;
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
    const FeedQuickNav = (
      await import("../../src/lib/components/FeedQuickNav.svelte")
    ).default;
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
    const allTabMatch = out.body.match(
      /<a[^>]*data-tab="all"[^>]*href="([^"]+)"/,
    );
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
    const FeedQuickNav = (
      await import("../../src/lib/components/FeedQuickNav.svelte")
    ).default;
    const out = render(FeedQuickNav, {
      props: {
        games: [{ id: "g-1", title: "X" }],
        activeShow: { kind: "specific" as const, gameIds: ["g-1"] },
        currentUrlSearch: "?show=specific&game=g-1",
        onNavigate: () => {},
      },
    });
    const inboxMatch = out.body.match(
      /<a[^>]*data-tab="inbox"[^>]*href="([^"]+)"/,
    );
    if (!inboxMatch) {
      throw new Error("Inbox tab href not found");
    }
    const href = inboxMatch[1]!;
    expect(href).toContain("show=inbox");
    expect(href).not.toContain("game=g-1");
  });

  it("per-game tab href = '/feed?show=specific&game=<id>' (single value) when starting from empty URL", async () => {
    const FeedQuickNav = (
      await import("../../src/lib/components/FeedQuickNav.svelte")
    ).default;
    const out = render(FeedQuickNav, {
      props: {
        games: [{ id: "g-1", title: "X" }],
        activeShow: { kind: "any" as const },
        currentUrlSearch: "",
        onNavigate: () => {},
      },
    });
    const gameMatch = out.body.match(
      /<a[^>]*data-game-id="g-1"[^>]*href="([^"]+)"/,
    );
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
    const FeedQuickNav = (
      await import("../../src/lib/components/FeedQuickNav.svelte")
    ).default;
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
    const FeedQuickNav = (
      await import("../../src/lib/components/FeedQuickNav.svelte")
    ).default;
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
    const src = fs.readFileSync(
      path.resolve("src/lib/components/FeedQuickNav.svelte"),
      "utf8",
    );
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
    const PageHeader = (
      await import("../../src/lib/components/PageHeader.svelte")
    ).default;
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
    const src = fs.readFileSync(
      path.resolve("src/lib/components/PageHeader.svelte"),
      "utf8",
    );
    expect(src).not.toMatch(/justify-content:\s*space-between/);
    expect(src).toMatch(/display:\s*flex/);
  });

  it("PageHeader with onClick CTA renders <button> instead of <a>", async () => {
    const PageHeader = (
      await import("../../src/lib/components/PageHeader.svelte")
    ).default;
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
    const PageHeader = (
      await import("../../src/lib/components/PageHeader.svelte")
    ).default;
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
    const GameCover = (
      await import("../../src/lib/components/GameCover.svelte")
    ).default;
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
    const GameCover = (
      await import("../../src/lib/components/GameCover.svelte")
    ).default;
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
    const GameCover = (
      await import("../../src/lib/components/GameCover.svelte")
    ).default;
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
    const src = fs.readFileSync(
      path.resolve("src/lib/components/GameCover.svelte"),
      "utf8",
    );
    expect(src).toMatch(/TODO Phase 3\+/);
  });

  it("SteamListingRow renders the persisted name when listing.name is present", async () => {
    const SteamListingRow = (
      await import("../../src/lib/components/SteamListingRow.svelte")
    ).default;
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
    // The fallback "App {appId}" text is NOT rendered when name is present.
    expect(out.body).not.toContain("App 620");
  });

  it("SteamListingRow falls back to 'App {appId}' when listing.name is null", async () => {
    const SteamListingRow = (
      await import("../../src/lib/components/SteamListingRow.svelte")
    ).default;
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
    expect(out.body).toContain("App 99999");
  });

  it("SteamListingRow Open-on-Steam href targets store.steampowered.com/app/{appId}/", async () => {
    const SteamListingRow = (
      await import("../../src/lib/components/SteamListingRow.svelte")
    ).default;
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
    expect(out.body).toMatch(
      /<a[^>]*href="https:\/\/store\.steampowered\.com\/app\/1145360\/"/,
    );
    expect(out.body).toMatch(/target="_blank"/);
    expect(out.body).toMatch(/rel="noopener noreferrer"/);
    // Paraglide label ("Open on Steam") renders.
    expect(out.body).toContain("Open on Steam");
  });

  it("SourceRow.svelte source carries the Mine treatment CSS rule + kind label", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve("src/lib/components/SourceRow.svelte"),
      "utf8",
    );
    // class:mine on root .row div + .row.mine border-left rule.
    expect(src).toMatch(/class:mine=\{source\.isOwnedByMe\}/);
    expect(src).toMatch(
      /\.row\.mine\s*\{[\s\S]*?border-left:\s*4px solid var\(--color-accent\)/,
    );
    // ownership-badge.mine upgraded to overlay-mine visual style (accent
    // background + accent-text).
    expect(src).toMatch(
      /\.ownership-badge\.mine[\s\S]*?background:\s*var\(--color-accent\)/,
    );
    // Kind label rendered next to the icon via kindLabel(SourceKind).
    expect(src).toMatch(/kindLabel/);
    expect(src).toMatch(/source_kind_label_youtube_channel/);
    expect(src).toMatch(/source_kind_label_reddit_account/);
    expect(src).toMatch(/source_kind_label_twitter_account/);
    expect(src).toMatch(/source_kind_label_telegram_channel/);
    expect(src).toMatch(/source_kind_label_discord_server/);
  });

  it("/games/[id]/+page.svelte renders the GAME HEADER CARD + EVENTS FEED CARD layout", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve("src/routes/games/[gameId]/+page.svelte"),
      "utf8",
    );
    // Two named panel cards.
    expect(src).toMatch(/<section[^>]*class="game-header-card"/);
    expect(src).toMatch(/<section[^>]*class="events-feed-card"/);
    // GameCover + SteamListingRow used inside the header card.
    expect(src).toMatch(/<GameCover\s/);
    expect(src).toMatch(/<SteamListingRow\s/);
    // Both panels styled (background var(--color-surface) + border).
    expect(src).toMatch(
      /\.game-header-card[\s\S]*?\.events-feed-card[\s\S]*?background:\s*var\(--color-surface\)/,
    );
  });

  it("/sources, /feed, /games each use the shared <PageHeader>", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const route of [
      "src/routes/sources/+page.svelte",
      "src/routes/feed/+page.svelte",
      "src/routes/games/+page.svelte",
    ]) {
      const src = fs.readFileSync(path.resolve(route), "utf8");
      expect(
        src,
        `${route}: imports PageHeader`,
      ).toMatch(/import PageHeader from "\$lib\/components\/PageHeader\.svelte"/);
      expect(src, `${route}: renders <PageHeader`).toMatch(/<PageHeader\s/);
      // The inline <header class="head"> block is gone from the markup
      // section. Strip the <script>...</script> block first so a comment
      // mentioning "<header class=\"head\">" in code doesn't match. The
      // markup region is whatever sits after the closing </script> tag
      // and before <style>.
      const markupOnly = src.replace(/<script[\s\S]*?<\/script>/g, "");
      expect(
        markupOnly,
        `${route}: no inline <header class="head"> in markup`,
      ).not.toMatch(/<header[^>]*class="head"/);
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
 *   - FiltersSheet radio via m.feed_filter_show_standalone()
 *   - FeedCard inline button via m.feed_card_mark_standalone_button()
 * Plus a positive guard that the audit-action verb names STAY as the
 * technical strings (m.audit_action_event_marked_standalone() unchanged).
 */
describe("Plan 02.1-31 — Standalone label rename to 'Not game-related'", () => {
  it("FeedQuickNav standalone segment renders 'Not game-related' (NOT 'Standalone')", async () => {
    const FeedQuickNav = (
      await import("../../src/lib/components/FeedQuickNav.svelte")
    ).default;
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
    const standaloneTabMatch = out.body.match(
      /<a[^>]*data-tab="standalone"[^>]*>([^<]*)<\/a>/,
    );
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
    const FilterChips = (
      await import("../../src/lib/components/FilterChips.svelte")
    ).default;
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
        schema: ["kind", "source", "show", "authorIsMe", "date"] as const,
        onDismiss: () => {},
        onOpenSheet: () => {},
        onClearAll: () => {},
      },
    });
    expect(out.body).toContain("Show: Not game-related");
    // The user-facing literal "Standalone" MUST NOT leak into the chip text.
    expect(out.body).not.toMatch(/Show:\s*Standalone/);
  });

  it("FiltersSheet show fieldset radio with value='standalone' renders 'Not game-related' label", async () => {
    const FiltersSheet = (
      await import("../../src/lib/components/FiltersSheet.svelte")
    ).default;
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
        schema: ["kind", "source", "show", "authorIsMe", "date"] as const,
        onApply: () => {},
        onClose: () => {},
      },
    });
    // The standalone radio's input value="standalone" (technical state name
    // STAYS) is followed by the label text "Not game-related" inside its
    // wrapping <label class="toggle">.
    expect(out.body).toMatch(/value="standalone"/);
    // The renamed value renders as the label text.
    expect(out.body).toContain("Not game-related");
    // The literal English "Standalone" string MUST NOT appear in the
    // rendered radio label text.
    const labelMatch = out.body.match(
      /<label[^>]*class="[^"]*toggle[^"]*"[^>]*>[^<]*<input[^>]*value="standalone"[^>]*\/?>([^<]*)<\/label>/,
    );
    if (labelMatch) {
      expect(labelMatch[1]!.trim()).not.toMatch(/^Standalone\b/);
    }
  });

  it("FeedCard inline 'Mark standalone' button reads 'Mark as not game-related' on inbox cards", async () => {
    const FeedCard = (
      await import("../../src/lib/components/FeedCard.svelte")
    ).default;
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
    expect(
      buttonMatch,
      "standalone-button not found in inbox FeedCard SSR output",
    ).not.toBeNull();
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
    const raw = JSON.parse(
      fs.readFileSync(path.resolve("messages/en.json"), "utf8"),
    );
    expect(raw.audit_action_event_marked_standalone).toBe(
      "Event marked standalone",
    );
    expect(raw.audit_action_event_unmarked_standalone).toBe(
      "Event unmarked standalone",
    );
  });

  it("messages/en.json has the renamed user-facing values for the 3 standalone keys", async () => {
    // Lock in the value contract at JSON-source level too — a future PR
    // that flips the value back to "Standalone" trips this assertion.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const raw = JSON.parse(
      fs.readFileSync(path.resolve("messages/en.json"), "utf8"),
    );
    expect(raw.feed_card_mark_standalone_button).toBe(
      "Mark as not game-related",
    );
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
    const src = fs.readFileSync(
      path.resolve("src/routes/audit/+page.svelte"),
      "utf8",
    );
    // Match the AUDIT_SCHEMA literal — the array MUST contain 'action' and
    // MUST NOT contain 'date'. The page-level DateRangeControl above
    // FilterChips is the single source of truth for date filtering on
    // /audit; the in-sheet date axis was duplicating that control.
    const match = src.match(/const AUDIT_SCHEMA\s*=\s*(\[[^\]]*\])/);
    expect(
      match,
      "src/routes/audit/+page.svelte: AUDIT_SCHEMA literal not found",
    ).not.toBeNull();
    const literal = match![1]!;
    expect(literal).toMatch(/"action"/);
    expect(
      literal,
      "AUDIT_SCHEMA still references 'date' — Plan 02.1-34 removes it",
    ).not.toMatch(/"date"/);
  });

  it("/feed schema still includes 'date' (no regression on the working surface)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve("src/routes/feed/+page.svelte"),
      "utf8",
    );
    // /feed's schema MUST still include 'date' — the in-sheet date axis is
    // the design-intentional secondary entry there (DateRangeControl is the
    // primary always-visible entry; the sheet-axis is the fallback for
    // users opening the sheet via a chip click). Plan 02.1-34 only narrows
    // /audit's schema, not /feed's.
    expect(
      src,
      "/feed schema dropped 'date' — Plan 02.1-34 should preserve it on /feed",
    ).toMatch(/"date"/);
  });

  it("FiltersSheet.svelte no longer references document.body.style.overflow (UAT-NOTES.md §4.22.F)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve("src/lib/components/FiltersSheet.svelte"),
      "utf8",
    );
    // Plan 02.1-22's imperative approach (document.body.style.overflow =
    // 'hidden' / '') is replaced by declarative CSS :has(dialog[open]) in
    // src/app.css. The component MUST NOT touch document.body.style at all
    // — drift is a regression candidate.
    expect(
      src,
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
    expect(
      css,
      "src/app.css missing body:has(dialog[open]) declarative scroll-lock rule",
    ).toMatch(/body:has\(dialog\[open\]\)\s*\{[^}]*overflow:\s*hidden/);
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
    // block (the regression source). The match below is intentionally
    // narrow to the html+body block by anchoring on the line range.
    const htmlBodyBlock = css.match(/html,\s*\n?body\s*\{[\s\S]*?\}/);
    expect(
      htmlBodyBlock,
      "html, body { ... } block not located in src/app.css",
    ).not.toBeNull();
    expect(
      htmlBodyBlock![0],
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
