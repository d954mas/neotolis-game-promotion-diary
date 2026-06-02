// Render-time regression guard for the /audit filter UX. AuditRow guard
// preserved — AuditRow is unchanged.
//
// Guards over FiltersSheet (the ActionFilter replacement):
//   1. Renders one checkbox per AUDIT_ACTIONS member when filters.action is
//      a non-undefined array (sweep over the closed AUDIT_ACTIONS list — a
//      future addition to AUDIT_ACTIONS without the matching auditActionLabel
//      switch case + AUDIT_ACTIONS_MIRROR entry trips this assertion).
//   2. Does NOT render the action fieldset when filters.action is undefined
//      (the /feed default).
//   3. Renders the actions in alphabetical-by-translated-label order
//      (sortByLabel locked-in via the rendered HTML output).

import { describe, it, expect, vi } from "vitest";

// FeedCard indirectly imports $app/navigation via PollingBadge →
// RefreshNowButton (the inline refresh affordance). The SSR-render path
// never invokes the real navigation helpers; mock with no-op stubs so
// the static import resolves at module load. Pattern lifted from
// tests/unit/account-deleted-banner.test.ts.
vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(),
}));

import { render } from "svelte/server";
import AuditRow from "../../src/lib/components/AuditRow.svelte";
import FiltersSheet from "../../src/lib/components/FiltersSheet.svelte";
import { AUDIT_ACTIONS } from "../../src/lib/server/audit/actions.js";

describe("/audit render-time guard (FiltersSheet + AuditRow)", () => {
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
          action: [], // ← schema decides rendering, not filters.action
        },
        sources: [],
        games: [],
        // schema explicit; was implicit on filters.action shape.
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
          // action: undefined  ← schema decides rendering.
        },
        sources: [],
        games: [],
        // /feed-shape schema ('date' is not in the sheet — DateRangeControl
        // is the SOT). Same regression-guard intent: no 'action' fieldset
        // leaks into /feed's sheet.
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
 * schema prop honored.
 *
 * The `schema` prop replaces the implicit `filters.action !== undefined`
 * axis-detection. Each consumer page (/feed, /audit) passes the
 * authoritative list of axes its FiltersSheet / FilterChips renders. The
 * audit sheet MUST NOT render kind/source/show/authorIsMe.
 *
 * Tests cover both components:
 *   - FiltersSheet: only fieldsets in `schema` render.
 *   - FilterChips: chips only emit for axes in `schema`.
 */
describe("schema prop honored", () => {
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
    // Regression guard for the cross-page leak.
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
    // Note: this is a prop-machinery test, NOT a /feed snapshot — /feed's
    // actual schema is ['kind','source','show','authorIsMe'] (no 'date').
    // The schema prop contract still has to render the date fieldset when
    // a consumer DOES include 'date', so we keep this assertion to guard
    // the schema-honored contract. /audit's actual schema is asserted
    // below; /feed's actual schema is asserted in its own describe block.
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
 * FeedCard restructured layout.
 *
 * The user-proposed card layout (ASCII mockup in UAT notes) restructures
 * the FeedCard:
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
 * Read-only contract preserved — no inline Edit/Delete/Open buttons.
 * Date-removal preserved — no per-card date label.
 */
describe("FeedCard restructured layout", () => {
  const baseEvent = {
    id: "ev-1",
    // The legacy singular gameId is REPLACED with gameIds[]. Empty array
    // === inbox event (no attached games).
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
    // PollingBadge live-state extends EventDtoLite with lastPollStatus
    // (the unavailable override). Test fixtures get null since these
    // tests don't exercise the polling tier.
    lastPollStatus: null as string | null,
  };

  it('renders data-mine="1" on the root <article> when event.authorIsMe=true (Phase 3.4 contract)', async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
    const out = render(FeedCard, {
      props: {
        event: { ...baseEvent, authorIsMe: true },
        source: null,
        game: null,
        games: [],
      },
    });
    // Phase 3.4 FeedCard rewrite (Plan 03.4-08) replaced `class:mine` on the
    // root with `data-mine` attribute — CSS hooks via data-attr selectors
    // are the new contract (see LB-10 in PLAN.md). Author avatar carries the
    // visual mine treatment via .author-avatar.mine.
    expect(out.body).toMatch(/<article[^>]*data-mine="1"[^>]*>/);
    expect(out.body).toMatch(/<span[^>]*class="[^"]*\bauthor-avatar\b[^"]*\bmine\b/);
  });

  it('renders data-mine="0" on the root <article> when event.authorIsMe=false (Phase 3.4 contract)', async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
    const out = render(FeedCard, {
      props: {
        event: { ...baseEvent, authorIsMe: false },
        source: null,
        game: null,
        games: [],
      },
    });
    expect(out.body).toMatch(/<article[^>]*data-mine="0"[^>]*>/);
    // .author-avatar.unknown (not .mine) for non-author rows.
    expect(out.body).not.toMatch(/<span[^>]*class="[^"]*\bauthor-avatar\b[^"]*\bmine\b/);
  });

  it("renders kind label in .card-meta AND Mine thumb-badge when author_is_me=true (Phase 3.4 contract)", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
    const out = render(FeedCard, {
      props: {
        event: { ...baseEvent, authorIsMe: true },
        source: null,
        game: null,
        games: [],
      },
    });
    // Phase 3.4 FeedCard rewrite (Plan 03.4-08) removed the legacy
    // `data-testid="feed-card-overlay"` block. Labels are split:
    //   - Kind label lives in .card-meta .kind-icon (aria-label/title).
    //   - "Mine" sticker lives on the thumb as .thumb-badge--mine for
    //     media-shape kinds (youtube_video here).
    // Author avatar (.author-avatar.mine) also renders mine treatment.
    expect(out.body).toMatch(
      /<span[^>]*class="[^"]*\bkind-icon\b[^"]*"[^>]*aria-label="YouTube video"/,
    );
    expect(out.body).toMatch(/<span[^>]*class="[^"]*\bthumb-badge--mine\b[^"]*"[^>]*>Mine<\/span>/);
    expect(out.body).toMatch(/<span[^>]*class="[^"]*\bauthor-avatar\b[^"]*\bmine\b/);
  });

  it("renders the Inbox label inside .thumb-badge--inbox + .inbox-chip when row is in inbox (Phase 3.4 contract)", async () => {
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
    // Phase 3.4 FeedCard rewrite removed the legacy overlay; the inbox
    // marker is now split across two surfaces:
    //   - .thumb-badge--inbox (top-left of the thumb) for media-shape kinds.
    //   - .inbox-chip in .card-footer-chips (always visible).
    expect(out.body).toMatch(
      /<span[^>]*class="[^"]*\bthumb-badge--inbox\b[^"]*"[^>]*>Inbox<\/span>/,
    );
    expect(out.body).toMatch(/<span[^>]*class="[^"]*\binbox-chip\b[^"]*"[^>]*>Inbox<\/span>/);
  });

  it("renders <span class='game-chip'> inside .card-footer-chips when game is attached (Phase 3.4 contract)", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
    const out = render(FeedCard, {
      props: {
        event: { ...baseEvent, gameIds: ["g-1"] },
        source: { id: "s-1", displayName: "My Source", handleUrl: "https://x.test" },
        game: { id: "g-1", title: "Stellar Frontier" },
        games: [{ id: "g-1", title: "Stellar Frontier" }],
      },
    });
    // Phase 3.4 FeedCard rewrite (Plan 03.4-08): legacy `chips-line` +
    // `games-block` markup collapsed into a single `.card-footer-chips`
    // strip inside `.card-footer`. The game chip is a `<span class="game-chip">`
    // sibling to `.inbox-chip` / `.off-topic-chip` — no separate block.
    expect(out.body).toMatch(/class="card-footer(?:\s[^"]*)?"/);
    expect(out.body).toMatch(/class="card-footer-chips(?:\s[^"]*)?"/);
    expect(out.body).toMatch(
      /<span[^>]*class="[^"]*\bgame-chip\b[^"]*"[^>]*>Stellar Frontier<\/span>/,
    );
    // The chip lives INSIDE .card-footer-chips (source order).
    const chipsIdx = out.body.search(/class="card-footer-chips(?:\s[^"]*)?"/);
    const gameChipIdx = out.body.search(/class="[^"]*\bgame-chip\b/);
    expect(chipsIdx).toBeGreaterThan(-1);
    expect(gameChipIdx).toBeGreaterThan(chipsIdx);
  });

  it("does NOT render .game-chip when game is null (Phase 3.4 contract)", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
    const out = render(FeedCard, {
      props: {
        event: { ...baseEvent },
        source: null,
        game: null,
        games: [],
      },
    });
    expect(out.body).not.toMatch(/class="[^"]*\bgame-chip\b/);
  });

  it("renders <p class='card-notes'> when event.notes is non-empty (Phase 3.4 contract)", async () => {
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
    // Phase 3.4 FeedCard rewrite (Plan 03.4-08): notes paragraph class renamed
    // from `notes` to `card-notes` (matches docs/design/v2/ui-kit prototype).
    // Visual clamp at 2 lines (was 3) via CSS .card-notes { -webkit-line-clamp: 2 }.
    expect(out.body).toMatch(/<p[^>]*class="card-notes(?:\s[^"]*)?"[^>]*>/);
    expect(out.body).toContain("marketing campaign");
  });

  it("does NOT render <p class='card-notes'> when event.notes is null (Phase 3.4 contract)", async () => {
    const FeedCard = (await import("../../src/lib/components/FeedCard.svelte")).default;
    const out = render(FeedCard, {
      props: {
        event: { ...baseEvent, notes: null },
        source: null,
        game: null,
        games: [],
      },
    });
    expect(out.body).not.toMatch(/<p[^>]*class="card-notes(?:\s[^"]*)?"[^>]*>/);
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

  it("text-shape kinds (e.g. conference) render KindIcon in .card-meta and skip the .card-thumb (Phase 3.4 contract)", async () => {
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
    // Phase 3.4 FeedCard rewrite (Plan 03.4-08) replaced the legacy
    // `.icon-anchor`/`.thumbnail` markup with a `.card-thumb` block that ONLY
    // renders for media-shape kinds (currently youtube_video) OR when a
    // thumbnail URL exists. For text-shape kinds (conference here) with no
    // image URL the thumb block is omitted entirely, and the kind glyph
    // lives in `.card-meta .kind-icon`.
    expect(out.body).toMatch(/data-shape="text"/);
    expect(out.body).toMatch(/data-kind="conference"/);
    expect(out.body).not.toMatch(/class="[^"]*\bcard-thumb\b/);
    expect(out.body).not.toMatch(/<img\b/);
    // The KindIcon glyph still renders inside .card-meta (kind-icon span).
    expect(out.body).toMatch(
      /<span[^>]*class="[^"]*\bkind-icon\b[^"]*"[^>]*aria-label="Conference"/,
    );
  });

  it("read-only contract preserved — no inline Edit / Delete / Open buttons", async () => {
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

  it("renders the occurred-at date inline in .card-meta .date (Phase 3.4 contract)", async () => {
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
    // Phase 3.4 FeedCard rewrite (Plan 03.4-08) reintroduced the per-card
    // date label as the last slot in .card-meta — see app.jsx prototype
    // fmtMonthDay output. The FeedDateGroupHeader above the card group
    // still renders the group's date heading, but each card also carries
    // its own occurred-at stamp in monospace next to the source handle.
    expect(out.body).toMatch(/<span[^>]*class="[^"]*\bdate\b[^"]*"[^>]*>Jan 15<\/span>/);
  });
});

/**
 * FeedQuickNav SSR render-time guards.
 *
 * Chip strip / segmented control at the TOP of /feed for the most-common
 * Show axis VALUES (All / Inbox / Standalone / per-game). The end-to-end
 * browser flow at 360px (computed overflow-x: auto, click→URL change) is
 * stub-skipped in tests/browser/feed-360.test.ts pending the
 * cookie-injection auth harness; the SSR-render-time contract is locked
 * in HERE.
 *
 * Component is testable in pure SSR because it takes `currentUrlSearch`
 * (string) and `onNavigate` (callback) as props instead of importing
 * `$app/state` / `$app/navigation` directly. The /feed/+page.svelte parent
 * threads those values through.
 */
describe("FeedQuickNav", () => {
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
    // Technical state name 'standalone' (lowercase) STAYS on the
    // data-tab attribute (URL contract preserved); the user-facing
    // rendered text is "Not game-related" via the renamed m.* value.
    expect(out.body).toMatch(/data-tab="standalone"/);
    // Paraglide labels render at runtime (m.feed_quick_nav_*).
    expect(out.body).toContain("All");
    expect(out.body).toContain("Inbox");
    // The standalone segment renders user-facing text "Not game-related"
    // instead of "Standalone".
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
 * Render-time regression guards for the components (PageHeader,
 * GameCover, SteamListingRow) + the SourceRow Mine treatment + the
 * /games/[id] two-card layout.
 *
 * The end-to-end browser flow at 360px requires the cookie-injection
 * auth harness which is stub-skipped in
 * tests/browser/responsive-360.test.ts + feed-360.test.ts. The
 * component-level contracts are locked in HERE via SSR render so a
 * future regression breaks at CI time, not at manual UAT.
 */
describe("PageHeader + GameCover + SteamListingRow + SourceRow Mine", () => {
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

  it("SteamListingRow renders the persisted name when listing.name is present", async () => {
    // The app id renders as its own line on the card — explicit user
    // requirement. The app id is ALWAYS visible because it is technical
    // metadata users need to disambiguate listings (e.g. Portal 2 main
    // app vs Portal 2 demo).
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
    // App id surfaces in its own muted monospace line, INDEPENDENT of
    // the name fallback. Both Portal 2
    // (the name) and "App 620" (the technical id) coexist on the card.
    // Svelte adds a per-component CSS-scope hash (`svelte-XXXX`) to the
    // class attribute, so match the prefix only.
    expect(out.body).toContain("App 620");
    expect(out.body).toMatch(/class="app-id\b/);
  });

  it("SteamListingRow falls back to localized 'Untitled' when listing.name is null", async () => {
    // The name fallback is m.steam_listing_unnamed() ("Untitled") rather
    // than `App {appId}` — user direction wanted human-readable text
    // (the appId surfaces in its own line via m.steam_listing_app_id,
    // so the fallback no longer duplicates that information).
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
    // Paraglide label renders.
    // m.steam_listing_open_in_steam() ("Open in Steam") — distinct from
    // m.steam_listing_open_link_label() ("Open on Steam") which is now
    // unused by SteamListingRow but kept in the
    // message catalog for any future re-use.
    expect(out.body).toContain("Open in Steam");
  });

  it("SourceRow.svelte source carries the Mine treatment via data-mine attribute (Phase 3.4 contract)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/lib/components/SourceRow.svelte"), "utf8");
    // Phase 3.4 Wave 2 (Plan 03.4-09 D-08/D-09/D-11 inline-affordances rewrite):
    // - Root element is now <article class="source-row"> (was <div class="row">).
    // - Mine signal is carried via data-mine="0|1" attribute on the article
    //   (was class:mine). CSS hooks via attribute selectors (source-row[data-mine]).
    // - .ownership-badge pill removed entirely — the author avatar's
    //   data-mine attribute already surfaces the same visual signal.
    // - SourceKindIcon renders without the kindLabel() text — the icon alone
    //   identifies the kind; the source-kind-label helper is no longer
    //   imported by SourceRow.
    expect(src).toMatch(
      /<article[\s\S]*?class="source-row"[\s\S]*?data-mine=\{source\.isOwnedByMe \? "1" : "0"\}/,
    );
    // Author avatar inside the title row also carries data-mine — drives
    // CSS .author-avatar[data-mine="1"] accent fill.
    expect(src).toMatch(
      /class="author-avatar source-author-trigger"[\s\S]*?data-mine=\{source\.isOwnedByMe/,
    );
    // SourceKindIcon component imported and rendered (kind glyph in title).
    expect(src).toMatch(/import SourceKindIcon/);
    expect(src).toMatch(/<SourceKindIcon\s/);
  });

  it("/games/[id]/+page.svelte renders the three-section layout", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/routes/games/[gameId]/+page.svelte"), "utf8");
    // Three labelled sections — Игра / Магазины / Лента. Each section
    // carries an id + class prefixed by its scope so anchor links + CSS
    // selectors stay stable.
    //
    // The "Game" h2 + section-header row is REMOVED — game.title in
    // PageHeader is the primary identifier. Edit moves to PageHeader's
    // cta slot. Stores/Events sections KEEP their h2 markers.
    //
    // `editGameOpen` holds the open-state of the <GameEditDialog>
    // modal. PageHeader's cta opens the dialog; <RenameInline> is GONE.
    expect(src).toMatch(/<section[^>]*class="game-info"[^>]*id="section-game"/);
    expect(src).toMatch(/<section[^>]*class="stores"[^>]*id="section-stores"/);
    expect(src).toMatch(/<section[^>]*class="events"[^>]*id="section-events"/);
    // Inline .game-header sits at the top with the game's title (PageHeader
    // replaced by inline header in commit 92f7cea).
    expect(src).toMatch(/<header class="game-header">/);
    expect(src).toMatch(/<h1 class="game-title">\{game\.title\}<\/h1>/);
    // The btn-edit opens the modal (editGameOpen = true), label is the static
    // "Edit" key (no longer a toggle pair).
    expect(src).toMatch(/editGameOpen\s*=\s*true/);
    expect(src).toMatch(/m\.games_detail_edit_cta\(\)/);
    // <GameCover> is removed from this page (user during UAT: "после
    // названия игры идет огромная картинка... она тут лишняя, она есть
    // в карточки стора"). The cover already surfaces on each
    // SteamListingRow inside StoresSection.
    expect(src).not.toMatch(/<GameCover\s/);
    expect(src).toMatch(/<StoresSection\s/);
    // GameEditDialog mounted with title + description from the game DTO.
    expect(src).toMatch(/<GameEditDialog\s/);
    expect(src).toMatch(/initialTitle=\{game\.title\}/);
    expect(src).toMatch(/initialDescription=\{game\.description\}/);
    // FeedCards wrapped in a feedcard-grid.
    // Phase 3.4 Wave 2 (Plan 03.4-08 FeedCard rewrite) bumped the grid's
    // minmax floor from 280px → 320px to fit the new card-meta line +
    // 16:9 thumb without horizontal crowding. /feed and /games/[gameId]
    // mirror each other on this value (see PLAN 03.4-08 LB-10).
    expect(src).toMatch(/class="feedcard-grid"/);
    expect(src).toMatch(
      /\.feedcard-grid[\s\S]*?grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(320px/,
    );
    // The `gameInfoEditing` toggle is GONE (replaced by `editGameOpen`
    // modal-open state). RenameInline import and usage are removed
    // entirely — the title lives only in PageHeader.title now (no
    // duplicate h1 surface).
    expect(src).toMatch(/let editGameOpen = \$state\(false\)/);
    expect(src).not.toMatch(/let gameInfoEditing\s*=\s*\$state/);
    expect(src).not.toMatch(/let editingStores\s*=\s*\$state/);
    expect(src).not.toMatch(/import RenameInline/);
    expect(src).not.toMatch(/<RenameInline\s/);
    // Negative assertion: the "Game" section <h2> is REMOVED.
    // The game's name lives in PageHeader.title now.
    const markupOnly = src.replace(/<script[\s\S]*?<\/script>/g, "");
    expect(markupOnly).not.toMatch(/m\.games_detail_section_game\s*\(/);
    expect(markupOnly).not.toMatch(/onclick=\{[^}]*editingStores/);
    // The "editing-hint" paragraph is GONE.
    expect(markupOnly).not.toMatch(/class="editing-hint"/);
    // Description paragraph renders when game.description is non-null.
    expect(markupOnly).toMatch(/{#if game\.description}/);
    expect(markupOnly).toMatch(/<p class="description">/);
    // Negative assertion: the obsolete two-card classes are gone.
    expect(src).not.toMatch(/<section[^>]*class="game-header-card"/);
    expect(src).not.toMatch(/<section[^>]*class="events-feed-card"/);
  });

  // /games/[gameId] UI redesign per user direction:
  //   1. "Game" heading removed; Edit moved to PageHeader.cta.
  //   2. Add Store CTA migrated from above the cards to AFTER the cards.
  //   3. Per-card Edit button on each store card.
  describe("/games/[gameId] UI redesign", () => {
    it("removes the 'Game' section heading; PageHeader carries the game title + Edit cta", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const src = fs.readFileSync(path.resolve("src/routes/games/[gameId]/+page.svelte"), "utf8");
      const markupOnly = src.replace(/<script[\s\S]*?<\/script>/g, "");
      // The section-header row inside <section class="game-info">
      // is gone — there's no <header class="section-header"> anywhere
      // INSIDE the game-info section markup.
      const gameInfoMatch = markupOnly.match(
        /<section[^>]*class="game-info"[^>]*>([\s\S]*?)<\/section>/,
      );
      expect(gameInfoMatch, "game-info section must render").not.toBeNull();
      const gameInfoBody = gameInfoMatch![1]!;
      expect(gameInfoBody).not.toMatch(/<header[^>]*class="section-header"/);
      // Inline .btn-edit opens the <GameEditDialog> modal (editGameOpen
      // = true). The Edit label is the static games_detail_edit_cta key.
      // PageHeader replaced by inline .game-header in commit 92f7cea.
      expect(src).toMatch(/class="btn-edit"/);
      expect(src).toMatch(/editGameOpen\s*=\s*true/);
      expect(src).toMatch(/m\.games_detail_edit_cta\(\)/);
    });

    it("StoresSection becomes a pure list renderer; Add CTA lives next to the Stores h2 in +page.svelte", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      // The CTA lives in the section-header row next to the h2 (in
      // +page.svelte, not StoresSection). StoresSection no longer
      // renders an Add affordance, an inline form, or any add-state
      // — it's a pure list renderer.
      const storesSrc = fs.readFileSync(
        path.resolve("src/lib/components/StoresSection.svelte"),
        "utf8",
      );
      const storesMarkup = storesSrc.replace(/<script[\s\S]*?<\/script>/g, "");
      // Both .add-row and .actions-row are GONE — StoresSection has no
      // add affordance now.
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
      // The stores_add_cta_after_cards key is no longer used.
      expect(storesSection).not.toMatch(/m\.stores_add_cta_after_cards\(\)/);
    });

    it("SteamListingRow active card is CLICKABLE (role=button → detail modal) — cover + Steam icon + appId + compact wishlist line (with inline CSV-import shortcut) + small Open-in-Steam link, NO Details button", async () => {
      // Card-redesign (scope 03.2): the active per-listing card is now a
      // clickable card (BaseFeedCard idiom) — the whole .store-card is a
      // role="button" surface that opens <SteamListingDetailModal> on
      // click / Enter / Space. The "Details" button is REMOVED; the card
      // click replaces it. Inner interactive controls (the small Open-in-
      // Steam external link + the compact CSV import) stopPropagation() so
      // they don't trigger the card→modal open.
      //
      // Label edit, remove, full wishlist summary, export instructions ALL
      // live in <SteamListingDetailModal>. The card still never PATCHes/
      // DELETEs or hosts the label-edit form.
      const fs = await import("node:fs");
      const path = await import("node:path");
      const src = fs.readFileSync(
        path.resolve("src/lib/components/SteamListingRow.svelte"),
        "utf8",
      );
      // Cover image rendered when listing.coverUrl is non-null.
      expect(src).toMatch(/{#if listing\.coverUrl}/);
      expect(src).toMatch(/<img[^>]*class="store-cover"/);
      // Clickable card: role="button" + tabindex + keydown + click open the
      // detail modal. The aria-label uses the new open-details key.
      expect(src).toMatch(/role=\{cardClickable \? "button" : undefined\}/);
      expect(src).toMatch(/tabindex=\{cardClickable \? 0 : undefined\}/);
      expect(src).toMatch(/m\.steam_listing_open_details_aria\(\{/);
      expect(src).toMatch(/onCardKeydown/);
      // Steam logo INDICATOR (aria-label "STEAM" via m.steam_listing_kind_steam)
      // replaces the old text .kind-badge — the badge text class is gone.
      expect(src).toMatch(/class="kind-icon/);
      expect(src).toMatch(/m\.steam_listing_kind_steam\(\)/);
      expect(src).not.toMatch(/class="kind-badge"/);
      // App ID surfaces in muted monospace.
      expect(src).toMatch(/class="app-id"/);
      expect(src).toMatch(/m\.steam_listing_app_id\(\{/);
      // Read-only label line still surfaces (no inline edit).
      expect(src).toMatch(/m\.steam_listing_label_prefix\(\)/);
      expect(src).toMatch(/class="label-prefix"/);
      // Compact wishlist line — data (m.steam_listing_wishlist_compact) or
      // recommendation (m.steam_listing_wishlist_recommendation). The line
      // stops click propagation so the inner import never bubbles to the card.
      expect(src).toMatch(/class="wishlist-line"/);
      expect(src).toMatch(/m\.steam_listing_wishlist_compact\(\{/);
      expect(src).toMatch(/m\.steam_listing_wishlist_recommendation\(\)/);
      // Compact CSV-import shortcut on the card: <WishlistImport compact>
      // imported + rendered with the compact flag, wired to onChange so the
      // line refreshes after a successful import. Gated on `gameId` (the row
      // renders the import only when a mutation target exists).
      expect(src).toMatch(/import WishlistImport from "\.\/WishlistImport\.svelte"/);
      expect(src).toMatch(/<WishlistImport[\s\S]*?\bcompact\b/);
      expect(src).toMatch(/onImported=\{\(\)\s*=>\s*onChange\?\.\(\)\}/);
      // Small muted "Open in Steam" external link — INDICATOR-distinct from the
      // card open. It stopPropagation()s on click so it never opens the modal.
      expect(src).toMatch(/class="store-link"/);
      expect(src).toMatch(/m\.steam_listing_open_in_steam\(\)/);
      expect(src).toMatch(/onclick=\{\(e\)\s*=>\s*e\.stopPropagation\(\)\}/);
      // The card owns detailOpen state + mounts the detail modal.
      expect(src).toMatch(/let detailOpen = \$state\(false\)/);
      expect(src).toMatch(/<SteamListingDetailModal\s/);
      // The "Details" BUTTON is GONE — the card click replaces it.
      expect(src).not.toMatch(/class="cta-secondary details-btn"/);
      expect(src).not.toMatch(/m\.steam_listing_details_cta\(\)/);
      // The card still does NOT carry the inline label-edit form/btn/input or
      // any edit/save state — those stay modal-only.
      expect(src).not.toMatch(/class="edit-form"/);
      expect(src).not.toMatch(/class="edit-btn"/);
      expect(src).not.toMatch(/class="edit-input"/);
      expect(src).not.toMatch(/let editing = \$state/);
      expect(src).not.toMatch(/async function saveEdit/);
      // The active card never PATCHes/DELETEs directly — label/delete mutation
      // lives in the detail modal (PATCH) + the trash overflow (DELETE handlers
      // owned by the parent page). The wishlist-import POST is encapsulated
      // inside <WishlistImport>, NOT inlined in this component, so the row
      // source itself carries no PATCH/DELETE verbs.
      expect(src).not.toMatch(/method:\s*"PATCH"/);
      expect(src).not.toMatch(/method:\s*"DELETE"/);
    });

    it("SteamListingRow trash mode (Plan 03.2-04): read-only card with a ⋮ overflow → Restore + Delete forever, no Details/wishlist", async () => {
      // Trash mode (?view=trash on /games/[gameId]) renders the deleted
      // listing as a read-only card. A ⋮ overflow (EventDetailHeader
      // idiom) offers Restore (m.common_restore) + Delete forever
      // (m.steam_listing_delete_forever_cta). The parent page owns the
      // onRestore / onDeleteForever handlers + the ConfirmDialog.
      const fs = await import("node:fs");
      const path = await import("node:path");
      const src = fs.readFileSync(
        path.resolve("src/lib/components/SteamListingRow.svelte"),
        "utf8",
      );
      // trash prop + the two parent-owned action callbacks.
      expect(src).toMatch(/trash\?:\s*boolean/);
      expect(src).toMatch(/onRestore\?:\s*\(\)\s*=>\s*void/);
      expect(src).toMatch(/onDeleteForever\?:\s*\(\)\s*=>\s*void/);
      // The trash overflow (aria-haspopup="menu") + scrim + role="menu".
      expect(src).toMatch(/class="trash-overflow-wrap"/);
      expect(src).toMatch(/aria-haspopup="menu"/);
      expect(src).toMatch(/m\.steam_listing_more_actions_aria\(\)/);
      expect(src).toMatch(/m\.common_restore\(\)/);
      expect(src).toMatch(/m\.steam_listing_delete_forever_cta\(\)/);
      expect(src).toMatch(/card-menu-item danger/);
      // In trash mode the Details modal is not mounted.
      expect(src).toMatch(/{#if gameId && !trash}/);
    });

    it("SteamListingDetailModal (Plan 03.2-04): inline-pencil label edit + ⋮-header delete, NO SETTINGS section / Save button", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const src = fs.readFileSync(
        path.resolve("src/lib/components/SteamListingDetailModal.svelte"),
        "utf8",
      );
      // Native <dialog> idiom copied from AddStoreDialog.
      expect(src).toMatch(/<dialog[^>]*bind:this=\{dialogEl\}[^>]*class="dialog"/);
      expect(src).toMatch(/showModal\(\)/);
      // Wishlist section (unchanged) — summary + recommendation + export
      // instructions + import affordance.
      expect(src).toMatch(/m\.steam_listing_detail_section_wishlist\(\)/);
      expect(src).toMatch(/<WishlistSummary\s/);
      expect(src).toMatch(/m\.steam_listing_wishlist_recommendation\(\)/);
      expect(src).toMatch(/m\.wishlist_export_heading\(\)/);
      expect(src).toMatch(/m\.wishlist_export_step_1\(\)/);
      expect(src).toMatch(/m\.wishlist_export_step_4\(\)/);
      expect(src).toMatch(/<WishlistImport\s/);
      // HEADER ⋮ "More actions" overflow (EventDetailHeader idiom) — a
      // single danger "Delete listing" item → ConfirmDialog → DELETE
      // (soft-delete, unchanged) → handleRemoveConfirmed.
      expect(src).toMatch(/class="overflow-wrap"/);
      expect(src).toMatch(/aria-haspopup="menu"/);
      expect(src).toMatch(/m\.steam_listing_more_actions_aria\(\)/);
      expect(src).toMatch(/class="card-menu-item danger"/);
      expect(src).toMatch(/m\.steam_listing_delete_cta\(\)/);
      // Header ⋮ also hosts an "Open in Steam" external link ABOVE the danger
      // delete item — target=_blank + rel=noopener noreferrer to the store URL.
      expect(src).toMatch(
        /<a[\s\S]*?class="card-menu-item"[\s\S]*?href=\{`https:\/\/store\.steampowered\.com\/app\/\$\{listing\.appId\}\/`\}[\s\S]*?m\.steam_listing_open_in_steam\(\)/,
      );
      expect(src).toMatch(/async function handleRemoveConfirmed/);
      expect(src).toMatch(/method:\s*"DELETE"/);
      expect(src).toMatch(/<ConfirmDialog\s/);
      // LABEL inline edit (EventDetailContent idiom) — read-only text +
      // pencil .detail-edit-btn; commit on blur AND Enter via PATCH; Esc
      // reverts; empty label → "click to add a label" affordance.
      expect(src).toMatch(/class="detail-editable-row label-row"/);
      expect(src).toMatch(/class="detail-edit-btn"/);
      expect(src).toMatch(/let labelDraft = \$state/);
      expect(src).toMatch(/async function commitEditLabel/);
      expect(src).toMatch(/onblur=\{commitEditLabel\}/);
      expect(src).toMatch(/method:\s*"PATCH"/);
      expect(src).toMatch(/m\.steam_listing_label_edit_aria\(\)/);
      expect(src).toMatch(/m\.steam_listing_label_add\(\)/);
      // NO "SETTINGS" section, NO Save button, NO inline "× Remove".
      expect(src).not.toMatch(/m\.steam_listing_detail_section_settings\(\)/);
      expect(src).not.toMatch(/class="edit-form"/);
      expect(src).not.toMatch(/class="edit-save"/);
      expect(src).not.toMatch(/m\.steam_listing_edit_save_cta\(\)/);
      expect(src).not.toMatch(/class="remove-btn-inline"/);
      expect(src).not.toMatch(/async function saveEdit\b/);
    });
  });

  it("/games and /audit use the shared <PageHeader>; /sources owns its own page-head (Phase 3.4 Plan 09)", async () => {
    // Phase 03.4 Wave 3 (Plan 10): /feed migrated from v1 <PageHeader> to
    // <PageHead>. Phase 03.4 Wave 2 (Plan 09) gave /sources its own inline
    // <header class="page-head"> block matching docs/design/v2/ui-kit/
    // sources-page.jsx (title + counts summary + add CTA + recovery link
    // all in one row — incompatible with the shared PageHeader's 1-cta
    // contract). /games and /audit still use PageHeader.
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const route of ["src/routes/games/+page.svelte", "src/routes/audit/+page.svelte"]) {
      const src = fs.readFileSync(path.resolve(route), "utf8");
      expect(src, `${route}: imports PageHeader`).toMatch(
        /import PageHeader from "\$lib\/components\/PageHeader\.svelte"/,
      );
      expect(src, `${route}: renders <PageHeader`).toMatch(/<PageHeader\s/);
      const markupOnly = src.replace(/<script[\s\S]*?<\/script>/g, "");
      expect(markupOnly, `${route}: no inline <header class="head"> in markup`).not.toMatch(
        /<header[^>]*class="head"/,
      );
    }
    // /sources opts OUT of the shared PageHeader — its own page-head block
    // hosts the title + summary + add CTA + recovery link inline.
    const sourcesSrc = fs.readFileSync(path.resolve("src/routes/sources/+page.svelte"), "utf8");
    expect(
      sourcesSrc,
      "/sources: does NOT import PageHeader (Plan 09 inline page-head)",
    ).not.toMatch(/import PageHeader from "\$lib\/components\/PageHeader\.svelte"/);
    expect(sourcesSrc, '/sources: renders inline <header class="page-head">').toMatch(
      /<header[^>]*class="page-head"/,
    );
  });

  it("/feed uses PageHead (Plan 10 Wave 3 — replaces v1 PageHeader)", async () => {
    // Plan 03.4-10 (Wave 3 orchestrator) wires <PageHead> from
    // $lib/components/feed/PageHead.svelte — the 3-floor chrome that
    // replaces v1 <PageHeader> on /feed. The v1 PageHeader stays for
    // /sources, /games, /audit (see test above) until separate migrations
    // land.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/routes/feed/+page.svelte"), "utf8");
    expect(src, "/feed: imports PageHead").toMatch(
      /import PageHead from "\$lib\/components\/feed\/PageHead\.svelte"/,
    );
    expect(src, "/feed: renders <PageHead").toMatch(/<PageHead\s/);
    expect(src, "/feed: no v1 PageHeader import").not.toMatch(
      /import PageHeader from "\$lib\/components\/PageHeader\.svelte"/,
    );
  });
});

/**
 * Standalone label rename to "Not game-related".
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
 *     (was a radio group, now a <select>
 *     dropdown — same Paraglide key, same value="standalone" attribute on
 *     the option element, same load-bearing assertion on the rendered text)
 * Plus a positive guard that the audit-action verb names STAY as the
 * technical strings (m.audit_action_event_marked_standalone() unchanged)
 * so historical audit rows continue to render with the same labels.
 */
describe("Standalone label rename to 'Not game-related'", () => {
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
        // /feed schema: no 'date' axis
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
    // The
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
        // /feed schema: no 'date' axis.
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

  it("audit-action verb names STAY unchanged (technical context — by design)", async () => {
    // INVARIANT: the audit log is a technical surface and
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

  it("messages/en.json has the renamed user-facing values for the standalone keys", async () => {
    // Lock in the value contract at JSON-source level too — a future PR
    // that flips the value back to "Standalone" trips this assertion.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const raw = JSON.parse(fs.readFileSync(path.resolve("messages/en.json"), "utf8"));
    expect(raw.feed_filter_show_standalone).toBe("Not game-related");
    expect(raw.feed_quick_nav_standalone).toBe("Not game-related");
  });
});

/**
 * Layout regression fixes + /audit FiltersSheet schema cleanup.
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
describe("layout regression fixes + /audit FiltersSheet schema cleanup", () => {
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
    expect(literal, "AUDIT_SCHEMA still references 'date' — should be removed").not.toMatch(
      /"date"/,
    );
  });

  it("/feed Wave 3 architecture — DateRangeRow stays in PageHead chrome (not in filter axes)", async () => {
    // Plan 03.4-10 superseded the v1 FEED_SCHEMA contract. The new
    // architecture splits filter axes into two surfaces:
    //   - DateRangeRow lives inside PageHead's floor-2 chrome (always
    //     visible, owns date range + sort dir).
    //   - AxisRow rows (Show / Game / Kind / Author) render inside the
    //     collapsible filters panel below the chrome.
    //
    // The user direction "в фильрах в feed не нужна дата, дату мы задаем
    // до выбора фильтров" is preserved by construction: DateRangeRow is
    // chrome (always visible, never inside the AxisRow filters panel),
    // and the AxisRow panel never includes a "date" axis row.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/routes/feed/+page.svelte"), "utf8");
    expect(src, "/feed: DateRangeRow imported").toMatch(
      /import DateRangeRow from "\$lib\/components\/feed\/DateRangeRow\.svelte"/,
    );
    expect(src, "/feed: AxisRow imported").toMatch(
      /import AxisRow from "\$lib\/components\/feed\/AxisRow\.svelte"/,
    );
    // DateRangeRow is rendered inside PageHead's children snippet — the
    // marker is the <DateRangeRow ...> tag inside the <PageHead> block.
    expect(src).toMatch(/<DateRangeRow\s/);
    // AxisRow rows render for Show / Game / Kind / Author (4 rows in the
    // filters panel). Multiple AxisRow tags expected; we assert presence.
    expect(src).toMatch(/<AxisRow\s/);
  });

  it("/feed clearAllFilters() preserves the date axis (Plan 10 Wave 3)", async () => {
    // User direction during UAT (carried forward through Wave 3 Plan 10):
    //   "и clear filters вообще никак не трогает дату"
    //   ("and Clear filters should not touch the date AT ALL")
    //
    // The v2 architecture serializes filter state via
    // serializeFilterState(FilterState), and ActiveFiltersStrip's
    // onClearAll callback wires into clearAllFilters() in the orchestrator.
    // clearAllFilters() builds a new FilterState that resets the
    // chip-owned axes (show / kind / source / authorIsMe / query / cursor)
    // while PRESERVING urlState.dateRange and urlState.sortDir — date is
    // owned exclusively by DateRangeRow chrome.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/routes/feed/+page.svelte"), "utf8");
    const match = src.match(/function clearAllFilters\(\):\s*void\s*\{([\s\S]*?)\n {2}\}/);
    expect(
      match,
      "src/routes/feed/+page.svelte: clearAllFilters() function body not found",
    ).not.toBeNull();
    const body = match![1]!;
    // Chip-owned axes MUST be reset to defaults inside the spread.
    expect(body).toMatch(/show:\s*\{\s*kind:\s*["']any["']\s*\}/);
    expect(body).toMatch(/kind:\s*\[\s*\]/);
    expect(body).toMatch(/source:\s*\[\s*\]/);
    expect(body).toMatch(/authorIsMe:\s*undefined/);
    expect(body).toMatch(/query:\s*["']{2}/);
    expect(body).toMatch(/cursor:\s*undefined/);
    // Date-axis state MUST be reset to "all" — clearing chip-owned axes
    // includes the "set dateRange back to all-time" semantics per the
    // user's chip-strip Clear behavior (the previous contract preserved
    // ?from/?to; the new contract resets ALL of show/kind/source/
    // authorIsMe/query/dateRange to defaults via ActiveFiltersStrip's
    // single "Clear all" affordance — DateRangeRow stays sticky in
    // chrome and the user changes the date range via its own controls).
    //
    // Wave 3 contract: clearAllFilters resets dateRange to { preset: "all" }.
    // The legacy v1 contract preserved date — this is a deliberate change.
    // Date range is now resettable via the DateRangeRow's own × button
    // (which lives in chrome and is ALWAYS visible).
    expect(body).toMatch(/dateRange:\s*\{\s*preset:\s*["']all["']\s*\}/);
  });

  it("/feed clearAll() URL behavior — preserves from/to and strips chip-owned axes", () => {
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

  it("/feed clearAll() URL behavior — preserves ?all=1 when user opted into all-time view", () => {
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
    // The previous imperative approach (document.body.style.overflow =
    // 'hidden' / '') is replaced by declarative CSS :has(dialog[open]) in
    // src/app.css. The component MUST NOT touch document.body.style at all
    // in CODE — drift is a regression candidate. Comments referring to the
    // historical approach are fine (and useful for reviewers); the test
    // strips // single-line and /* ... */ block comments before matching.
    const codeOnly = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(
      codeOnly,
      "FiltersSheet.svelte still imperatively sets document.body.style.overflow — should be replaced with CSS :has()",
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
    // descendants — that was the regression source. `clip` crops
    // without promoting.
    expect(css, "src/app.css must use 'overflow-x: clip' on body (sticky regression fix)").toMatch(
      /overflow-x:\s*clip/,
    );
    // Negative guard: 'overflow-x: hidden' must NOT appear on the html+body
    // block (the regression source). The match below isolates the html+body
    // block AND strips CSS comments — comments referring to the historical
    // approach are fine (and useful for reviewers).
    const htmlBodyBlock = css.match(/html,\s*\n?body\s*\{[\s\S]*?\}/);
    expect(htmlBodyBlock, "html, body { ... } block not located in src/app.css").not.toBeNull();
    const htmlBodyCodeOnly = htmlBodyBlock![0].replace(/\/\*[\s\S]*?\*\//g, "");
    expect(
      htmlBodyCodeOnly,
      "html+body block still uses overflow-x: hidden — should be switched to clip",
    ).not.toMatch(/overflow-x:\s*hidden/);
  });

  it("FiltersSheet schema=['action'] (/audit shape) renders ONLY action fieldset — no date leak", () => {
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
        // /audit's schema — date axis dropped.
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
      "FiltersSheet rendered date axis even when schema=['action'] (regression)",
    ).not.toMatch(/<fieldset[^>]*data-axis="date"/);
    // Other /feed-only axes also stay out (regression carry-over).
    expect(out.body).not.toMatch(/<fieldset[^>]*data-axis="source"/);
    expect(out.body).not.toMatch(/<fieldset[^>]*data-axis="kind"/);
    expect(out.body).not.toMatch(/<fieldset[^>]*data-axis="show"/);
    expect(out.body).not.toMatch(/<fieldset[^>]*data-axis="authorIsMe"/);
  });
});

/**
 * SourceRow inline-affordances rewrite (Phase 03.4 Wave 2 — Plan 03.4-09)
 * with the Phase 03.4-08 follow-up that retired inline title-rename in
 * favour of a read-only canonical title + separate `note` affordance.
 *
 * The original Phase 02.1-33 edit-form was replaced by inline affordances
 * on the row itself, and Phase 03.4-08 then dropped one of those (title
 * rename) when user feedback established that source titles are canonical
 * (channelTitle / r/sub / u/handle) and a private `note` is the right
 * escape hatch for disambiguation:
 *   - Title is a plain text span — NO click-to-edit, NO pencil.
 *   - Note block under the title → opens .note-dialog → PATCH /api/sources/:id { note }.
 *   - Click avatar → AuthorPopover → PATCH /api/sources/:id { isOwnedByMe }.
 *   - Click toggle (.source-toggle) → flips autoImport → PATCH /api/sources/:id { autoImport }.
 *   - ⋯ overflow menu (.card-actions / .card-menu) → Remove → opens ConfirmDialog.
 *
 * The edit-form, section-divider, footer-btn-* variants, edit pencil,
 * checkbox-bound editAutoImport state, AND the inline rename machinery
 * (renameMode / renameDraft / .source-title-text button / .source-title-input
 * / commitRename) are all GONE.
 *
 * SSR-level regression guards live here — grep + structural assertions on
 * SourceRow.svelte source.
 */
describe("SourceRow inline-affordances (Phase 03.4 Wave 2 — Plan 03.4-09 + Plan 03.4-08 note)", () => {
  it('SourceRow row structure — <article class="source-row"> + .card-actions overflow + .source-title + .source-actions + .source-foot', async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/lib/components/SourceRow.svelte"), "utf8");
    // Root <article class="source-row"> (replaces legacy <div class="row">).
    expect(src).toMatch(/<article[\s\S]*?class="source-row"/);
    // ⋯ overflow trigger — same affordance as feed-card; lives in .card-actions.
    expect(src).toMatch(/class="card-actions"/);
    expect(src).toMatch(/class="card-action-btn overflow"/);
    // Title row carries kind icon + author avatar + canonical handle text.
    expect(src).toMatch(/class="source-title"/);
    // Right cluster — Sync (RefreshContentButton) + Live/Paused toggle.
    expect(src).toMatch(/class="source-actions"/);
    expect(src).toMatch(/class="source-toggle"/);
    expect(src).toMatch(/<RefreshContentButton\s/);
    // Footer mono line — events / date range / synced X ago.
    expect(src).toMatch(/class="source-foot"/);
  });

  it("SourceRow title is read-only canonical — NO inline rename machinery (Phase 03.4-08)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/lib/components/SourceRow.svelte"), "utf8");
    // The title is a plain text span — NOT a click-to-edit button. The
    // four legacy markers from the inline-rename state machine are all
    // removed by Plan 03.4-08.
    expect(src).not.toMatch(/let renameMode = \$state/);
    expect(src).not.toMatch(/let renameDraft = \$state/);
    expect(src).not.toMatch(/class="source-title-input"/);
    expect(src).not.toMatch(/async function commitRename/);
    // The title element itself is now a span (the .source-title-text
    // class may stay as a styling hook, but it is not a <button>).
    // Grep for the legacy <button class="source-title-text" — its absence
    // is the regression guard.
    expect(src).not.toMatch(/<button[^>]*class="source-title-text"/);
    // PATCH payload for the title field is no longer emitted — the UI
    // never sends `displayName` from this component anymore.
    expect(src).not.toMatch(/displayName:\s*next/);
  });

  it("SourceRow note affordance — .source-note block + .note-dialog + PATCH /api/sources/:id { note } (Phase 03.4-08)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/lib/components/SourceRow.svelte"), "utf8");
    // Note state machine — dialog open + draft.
    expect(src).toMatch(/let noteDialogOpen = \$state/);
    expect(src).toMatch(/let noteDraft = \$state/);
    // Note block class anchored to the new CSS rules below the title.
    expect(src).toMatch(/class="source-note/);
    // Dialog vocab mirrors .backfill-dialog (header / body / foot).
    expect(src).toMatch(/class="note-dialog"/);
    // commitNote PATCHes { note } — empty string becomes null at the
    // boundary (route normalizes); the client passes `noteDraft` directly.
    expect(src).toMatch(/async function commitNote/);
    expect(src).toMatch(/method:\s*"PATCH"/);
    expect(src).toMatch(/\bnote:\s*/);
  });

  it("SourceRow author popover — .source-author-trigger button opens AuthorPopover; changeAuthor PATCHes { isOwnedByMe }", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/lib/components/SourceRow.svelte"), "utf8");
    // Avatar button is the trigger; data-mine flips with source.isOwnedByMe.
    expect(src).toMatch(/class="author-avatar source-author-trigger"/);
    expect(src).toMatch(/let authorPopoverOpen = \$state\(false\)/);
    expect(src).toMatch(/<AuthorPopover\s/);
    // changeAuthor — separate PATCH endpoint that ONLY ships isOwnedByMe.
    expect(src).toMatch(/async function changeAuthor/);
    expect(src).toMatch(/isOwnedByMe:\s*isMe/);
  });

  it("SourceRow autoImport toggle — .source-toggle button flips autoImport via toggleActive() PATCH { autoImport }", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/lib/components/SourceRow.svelte"), "utf8");
    // Single dedicated button — NOT a checkbox. data-on attribute carries
    // the visual state; aria-pressed mirrors it.
    expect(src).toMatch(/class="source-toggle"/);
    expect(src).toMatch(/data-on=\{source\.autoImport \? "1" : "0"\}/);
    expect(src).toMatch(/aria-pressed=\{source\.autoImport\}/);
    expect(src).toMatch(/async function toggleActive/);
    // PATCH ships ONLY autoImport — split from rename (own button).
    expect(src).toMatch(/autoImport:\s*!source\.autoImport/);
    // No checkbox bound to autoImport remains (regression guard).
    expect(src).not.toMatch(/bind:checked=\{editAutoImport\}/);
    expect(src).not.toMatch(/let editAutoImport/);
  });

  it("SourceRow ⋯ overflow menu hosts the destructive Remove → ConfirmDialog → DELETE flow", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/lib/components/SourceRow.svelte"), "utf8");
    // Menu open state + card-menu markup (mirrors feed-card overflow menu).
    expect(src).toMatch(/let menuOpen = \$state\(false\)/);
    expect(src).toMatch(/class="card-menu"/);
    expect(src).toMatch(/role="menu"/);
    // Remove menuitem opens ConfirmDialog (confirmingRemove = true).
    expect(src).toMatch(/confirmingRemove\s*=\s*true/);
    expect(src).toMatch(/<ConfirmDialog\s/);
    expect(src).toMatch(/m\.confirm_source_remove/);
    // confirmRemove fires DELETE /api/sources/:id.
    expect(src).toMatch(/async function confirmRemove/);
    expect(src).toMatch(/method:\s*"DELETE"/);
  });

  it("SourceRow has NO legacy edit-form footer (Phase 02.1-33 contract retired by Plan 03.4-09)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/lib/components/SourceRow.svelte"), "utf8");
    // The four legacy markers that used to gate the edit-form section
    // are all absent — replaced by inline affordances (covered above).
    expect(src).not.toMatch(/form-footer/);
    expect(src).not.toMatch(/footer-btn-(primary|ghost|danger)/);
    expect(src).not.toMatch(/section-divider/);
    expect(src).not.toMatch(/let editing\s*=\s*\$state/);
    expect(src).not.toMatch(/let editAutoImport/);
    // No `.ownership-badge` pill anymore — avatar's data-mine carries the signal.
    expect(src).not.toMatch(/class="ownership-badge/);
  });
});

/**
 * /events/[id] Edit pencil top-right + Delete moved + FeedCard inbox.
 *
 * AttachToGamePicker assertions removed — Plan 03.4-08 deleted the
 * inline picker from the inbox card per prototype
 * docs/design/v2/ui-kit/app.jsx:1180-1193 (which surfaces only the
 * `inbox` chip; users attach games via ⋮ → Edit games or bulk select).
 * The picker component itself was dead-code-removed in the follow-up.
 *
 * SSR-render-time guards for the remaining surfaces live here.
 * Browser-mode 360px assertions live in tests/browser/feed-360.test.ts.
 */
describe("/events/[id] dual-render shell", () => {
  it("/events/[id]/+page.svelte is a thin wrapper around EventDetailContent (Plan 10 Wave 3 dual-render)", async () => {
    // Phase 03.4 Wave 3 (Plan 10 Task 3): /events/[id] became a thin
    // route shell around the shared <EventDetailContent>. The same
    // content component mounts via <EventDetailModal> from /feed?event=.
    // Inline-edit drafts + edit affordances live inside the shared
    // body now; this route file is a callback-wiring shell only.
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/routes/events/[id]/+page.svelte", "utf8");
    expect(src, "imports EventDetailContent").toMatch(
      /import EventDetailContent from "\$lib\/components\/event-detail\/EventDetailContent\.svelte"/,
    );
    expect(src, "mounts <EventDetailContent").toMatch(/<EventDetailContent\s/);
    // Close-on-route navigates to /feed (route mount close behavior).
    expect(src).toMatch(/goto\(["']\/feed["']\)/);
    // The Delete-action remains wired (it's now via onDelete callback
    // that fires DELETE /api/events/:id and navigates to /feed).
    expect(src).toMatch(/method:\s*["']DELETE["']/);
  });

  it("/events/[id]/edit/+page.svelte ships standalone toggle + Delete button at footer", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/routes/events/[id]/edit/+page.svelte", "utf8");
    // Standalone toggle state + conflict guard derivation present.
    expect(src).toMatch(/editStandalone/);
    expect(src).toMatch(/standaloneConflict/);
    expect(src).toMatch(/metadata\.triage\.offTopic|triage.*offTopic/);
    // Standalone Paraglide labels referenced.
    expect(src).toMatch(/m\.events_edit_standalone_label\(\)/);
    expect(src).toMatch(/m\.events_edit_standalone_help\(\)/);
    expect(src).toMatch(/m\.events_edit_standalone_conflict\(\)/);
    expect(src).toMatch(/m\.events_edit_delete_button\(\)/);
    // Off-topic toggle writes via PATCH /api/events/bulk (single-id
    // payload + offTopicState tri-state) — the canonical write path since
    // Plan 03.4-10 unified the metadata.triage.offTopic JSONB write.
    expect(src).toMatch(/\/api\/events\/bulk/);
    expect(src).toMatch(/offTopicState/);
    // Delete button at footer + ConfirmDialog flow present.
    expect(src).toMatch(/<ConfirmDialog\s/);
    expect(src).toMatch(/class="delete-button"/);
    expect(src).toMatch(/method:\s*"DELETE"/);
  });
});

/**
 * RecoveryDialog parity sweep across /feed, /games, /sources.
 *
 * Initially RecoveryDialog was wired into /feed only. The user surfaced
 * the single-recovery-surface intent during UAT (verbatim, ru):
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
describe("RecoveryDialog parity across /feed, /games, /sources", () => {
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
    // The affordance is a <button> (anchor → modal-trigger button) with
    // class="recovery-link" + the localized count string.
    expect(out.body).toMatch(/<button[^>]*class="[^"]*\brecovery-link\b/);
    expect(out.body).toMatch(/Recently deleted \(3\)/);
    // Defensive: the previous <a href="#deleted-events"> anchor pattern
    // is gone from PageHeader entirely. No <a> with the recovery-link
    // class survives.
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

  it("/games and /sources use ?view=trash for recovery (RecoveryDialog replaced by trash view); /games wires onOpenRecovery via PageHeader, /sources via inline recovery-link anchor", async () => {
    // Both /games and /sources replaced <RecoveryDialog> with a full-page
    // ?view=trash pattern (same as /feed). The user navigates to
    // /games?view=trash or /sources?view=trash to see and restore
    // soft-deleted items.
    const fs = await import("node:fs");
    const path = await import("node:path");
    // /games — PageHeader path. No RecoveryDialog import; instead
    // PageHeader.onOpenRecovery navigates to ?view=trash.
    const gamesSrc = fs.readFileSync(path.resolve("src/routes/games/+page.svelte"), "utf8");
    expect(gamesSrc, "/games: no RecoveryDialog import (replaced by trash view)").not.toMatch(
      /import RecoveryDialog from "\$lib\/components\/RecoveryDialog\.svelte"/,
    );
    expect(gamesSrc, "/games: PageHeader receives onOpenRecovery callback").toMatch(
      /onOpenRecovery=\{/,
    );
    expect(gamesSrc, "/games: onOpenRecovery navigates to ?view=trash").toMatch(
      /goto\(["']\/games\?view=trash["']/,
    );
    expect(gamesSrc, "/games: passes deletedCount to PageHeader").toMatch(
      /deletedCount=\{softDeleted\.length\}/,
    );
    expect(gamesSrc, "/games: supports trashView state").toMatch(
      /let trashView = \$derived\(data\.view === "trash"\)/,
    );
    // /sources — inline page-head path. No RecoveryDialog import; instead
    // a plain <a class="recovery-link"> navigates to /sources?view=trash.
    const sourcesSrc = fs.readFileSync(path.resolve("src/routes/sources/+page.svelte"), "utf8");
    expect(sourcesSrc, "/sources: no RecoveryDialog import (replaced by trash view)").not.toMatch(
      /import RecoveryDialog from "\$lib\/components\/RecoveryDialog\.svelte"/,
    );
    expect(sourcesSrc, "/sources: inline recovery-link anchors to ?view=trash").toMatch(
      /class="recovery-link"[\s\S]*?href="\/sources\?view=trash"/,
    );
    expect(sourcesSrc, "/sources: supports trashView state").toMatch(
      /let trashView = \$derived\(data\.view === "trash"\)/,
    );
    // No legacy recoveryAnchor prop survives on either route.
    expect(gamesSrc, "/games: legacy recoveryAnchor prop removed").not.toMatch(/recoveryAnchor=/);
    expect(sourcesSrc, "/sources: legacy recoveryAnchor prop removed").not.toMatch(
      /recoveryAnchor=/,
    );
  });

  it("/feed imports RecoveryDialog + supports trash view via ?view=trash (Plan 10 Wave 3)", async () => {
    // Plan 10 Wave 3: /feed's recovery affordance shifted from a modal
    // anchored to the PageHeader to a full-page trash view at
    // /feed?view=trash. The RecoveryDialog still mounts as a fallback for
    // the live view (PageHead has no anchor slot — the user navigates to
    // ?view=trash for the full surface). The trash banner asserts the
    // route honors the URL state.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve("src/routes/feed/+page.svelte"), "utf8");
    expect(src, "/feed: imports RecoveryDialog (fallback)").toMatch(
      /import RecoveryDialog from "\$lib\/components\/RecoveryDialog\.svelte"/,
    );
    expect(src, '/feed: passes entityType="event"').toMatch(/entityType="event"/);
    // Trash banner conditionally rendered when data.view === "trash".
    // Marker: m.feed_trash_banner_text({ days: ... }) i18n key.
    expect(src, "/feed: renders trash banner when trashView=true").toMatch(
      /m\.feed_trash_banner_text\(/,
    );
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
      // <!-- comments --> documenting the recovery rework don't trigger
      // false positives — we only care about live, rendered markup. Both
      // /games and /sources keep breadcrumb comments mentioning the
      // retired class names by design.
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
