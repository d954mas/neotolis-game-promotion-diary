// Phase 3.0 Plan 11 — render-time guard for the live-state PollingBadge
// rewrite (5 user-facing variants per UI-SPEC §"Component inventory:
// PollingBadge REWRITE").
//
// Uses Svelte 5 SSR via `svelte/server` — same pattern as Plan 02.1-20's
// audit-render.test.ts and Plan 03.0-12's tests/unit/account-deleted-banner.test.ts.
//
// FILE LOCATION DEVIATION (Rule 3 — blocking): the plan asked for the test
// at tests/browser/polling-badge.test.ts but vitest's browser-mode bundler
// (Playwright-driven Chromium) cannot resolve the $app/navigation virtual
// module pulled in by RefreshNowButton.svelte (which PollingBadge renders
// inline). A vi.mock() runs at TEST time but the import-analysis vite
// plugin fails BEFORE that — pre-transform error: "Failed to resolve
// import '$app/navigation' from 'src/lib/components/RefreshNowButton.svelte'".
// The integration project (Node test environment) DOES support the
// vi.mock indirection (lifted verbatim from
// tests/unit/account-deleted-banner.test.ts which has the exact same
// $app/navigation challenge for AccountDeletedBanner). Moving the test
// here keeps all 14 assertions live; the browser-mode 360px-viewport
// end-to-end is deferred to Phase 6 with the rest of the auth-harness
// surface (same precedent as feed-360.test.ts skips for /feed at 360px).
//
// Coverage (per the plan's <behavior> block):
//   1. Active tier — Hot · checked Xh ago
//   2. Cold tier — Cold variant copy with day count
//   3. Frozen tier — Frozen · refresh to update
//   4. lastPollStatus override — Unavailable · last seen Xd ago
//   5. Manual entry — lastPolledAt=null + Active tier; refresh button HIDDEN
//   6. Non-pollable kind — component renders nothing (Phase 2.1 contract)
//   7. RefreshNowButton renders inline when refresh affordance is visible
//
// All copy comes from messages/en.json via Paraglide (Plan 02 keys);
// assertions match against substring fragments to stay tolerant of small
// copy edits down the road (the `Hot` / `Cold` / `Frozen` / `Unavailable`
// / `Manual entry` discriminator words are load-bearing).

import { describe, it, expect, vi } from "vitest";

// SvelteKit virtual modules — RefreshNowButton (rendered inline by
// PollingBadge) imports `invalidateAll` from $app/navigation for its click
// handler. The SSR-render path never invokes it; mock with a no-op stub
// so the static import resolves at module load. Pattern lifted from
// tests/unit/account-deleted-banner.test.ts.
vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(),
}));

const { render } = await import("svelte/server");
const PollingBadge = (await import("../../src/lib/components/PollingBadge.svelte")).default;

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms);

type EventForBadge = {
  id: string;
  kind: string;
  occurredAt: Date | string;
  lastPolledAt: Date | string | null;
  lastPollStatus: string | null;
  metadata: Record<string, unknown> | null;
};

function mkEvent(overrides: Partial<EventForBadge> = {}): EventForBadge {
  return {
    id: "evt-1",
    kind: "youtube_video",
    // Default: 12h-old event, polled 1h ago, OK status.
    occurredAt: ago(12 * 3_600_000),
    lastPolledAt: ago(3_600_000),
    lastPollStatus: "ok",
    metadata: null,
    ...overrides,
  };
}

describe("PollingBadge — live state (Plan 03.0-11)", () => {
  it("Active tier (12h occurred, 1h polled): renders 'Hot · checked Xh ago' + refresh button", () => {
    const out = render(PollingBadge, { props: { event: mkEvent() } });
    expect(out.body).toMatch(/Hot/);
    expect(out.body).toMatch(/h ago/);
    // Refresh-now visible because lastPolledAt !== null per D-10.
    expect(out.body).toMatch(/class="refresh-now/);
    // Variant class on the badge root for color-rule routing.
    expect(out.body).toMatch(/polling-badge--active/);
  });

  it("Cold tier (5d occurred, 30h polled): renders Cold variant", () => {
    const ev = mkEvent({
      occurredAt: ago(5 * 86_400_000),
      lastPolledAt: ago(30 * 3_600_000),
    });
    const out = render(PollingBadge, { props: { event: ev } });
    expect(out.body).toMatch(/Cold/);
    // Should be one of cold-yesterday or cold-days-ago.
    expect(out.body).toMatch(/polling-badge--cold-(yesterday|days-ago)/);
  });

  it("Cold tier (5d occurred, 24h polled): renders 'Cold · yesterday'", () => {
    // daysSincePoll ~= 1 → cold-yesterday branch.
    const ev = mkEvent({
      occurredAt: ago(5 * 86_400_000),
      lastPolledAt: ago(86_400_000),
    });
    const out = render(PollingBadge, { props: { event: ev } });
    expect(out.body).toMatch(/yesterday/);
  });

  it("Frozen tier (30d occurred, 30d polled): renders 'Frozen · refresh to update' + refresh button", () => {
    const ev = mkEvent({
      occurredAt: ago(30 * 86_400_000),
      lastPolledAt: ago(30 * 86_400_000),
    });
    const out = render(PollingBadge, { props: { event: ev } });
    expect(out.body).toMatch(/Frozen/);
    expect(out.body).toMatch(/refresh to update/);
    // Frozen carries a dashed border per UI-SPEC §"Color → variant color rules".
    expect(out.body).toMatch(/polling-badge--frozen/);
    // D-10: refresh-now visible when tier=Frozen even if lastPolledAt would
    // suggest otherwise (here both gates are true).
    expect(out.body).toMatch(/class="refresh-now/);
  });

  it("Unavailable: lastPollStatus='not_found' overrides age-based tier", () => {
    const ev = mkEvent({
      lastPollStatus: "not_found",
      lastPolledAt: ago(2 * 86_400_000),
    });
    const out = render(PollingBadge, { props: { event: ev } });
    expect(out.body).toMatch(/Unavailable/);
    expect(out.body).toMatch(/last seen/);
    expect(out.body).toMatch(/polling-badge--unavailable/);
  });

  it("Unavailable: lastPollStatus='private' overrides age-based tier", () => {
    const ev = mkEvent({
      lastPollStatus: "private",
      lastPolledAt: ago(86_400_000),
    });
    const out = render(PollingBadge, { props: { event: ev } });
    expect(out.body).toMatch(/Unavailable/);
  });

  it("Unavailable: lastPollStatus='auth_error' overrides age-based tier", () => {
    const ev = mkEvent({
      lastPollStatus: "auth_error",
      lastPolledAt: ago(86_400_000),
    });
    const out = render(PollingBadge, { props: { event: ev } });
    expect(out.body).toMatch(/Unavailable/);
  });

  it("Manual entry: lastPolledAt=null + Active tier renders Manual variant + HIDES refresh button", () => {
    const ev = mkEvent({
      lastPolledAt: null,
      occurredAt: ago(3_600_000),
    });
    const out = render(PollingBadge, { props: { event: ev } });
    expect(out.body).toMatch(/Manual entry/);
    expect(out.body).toMatch(/no polling/);
    expect(out.body).toMatch(/polling-badge--manual/);
    // D-10: refresh-now HIDDEN when lastPolledAt IS NULL AND tier ≠ Frozen.
    expect(out.body).not.toMatch(/class="refresh-now/);
  });

  it("Non-pollable kind (kind=conference): component renders nothing", () => {
    const ev = mkEvent({ kind: "conference" });
    const out = render(PollingBadge, { props: { event: ev } });
    // The {#if POLLABLE_KINDS.includes(event.kind)} guard suppresses the
    // entire badge wrapper. The body may still carry SSR comment markers
    // but no .polling-badge element.
    expect(out.body).not.toMatch(/class="polling-badge[^_]/);
    expect(out.body).not.toMatch(/Hot|Cold|Frozen|Unavailable|Manual entry/);
  });

  it("Non-pollable kind (kind=reddit_post): component renders nothing in 3.0 (Phase 3.1 lifts gate)", () => {
    // Phase 3.0 keeps PollingBadge YouTube-only per UI-SPEC. Phase 3.1
    // extends POLLABLE_KINDS with 'reddit_post' once the Reddit adapter
    // ships. The current contract: any non-youtube_video kind renders
    // nothing.
    const ev = mkEvent({ kind: "reddit_post" });
    const out = render(PollingBadge, { props: { event: ev } });
    expect(out.body).not.toMatch(/class="polling-badge[^_]/);
  });

  it("a11y: rendered badge carries role='status' + aria-live='polite'", () => {
    const out = render(PollingBadge, { props: { event: mkEvent() } });
    expect(out.body).toMatch(/role="status"/);
    expect(out.body).toMatch(/aria-live="polite"/);
  });

  it("color rule: Active variant colors the icon with --color-success (green) via CSS class", () => {
    const out = render(PollingBadge, { props: { event: mkEvent() } });
    // The CSS rule .polling-badge--active .polling-badge__icon { color:
    // var(--color-success) } in the component's <style> block; the runtime
    // assertion is on the variant class — Svelte SSR scopes the style but
    // the modifier class is what we assert is set.
    expect(out.body).toMatch(/polling-badge--active/);
  });

  it("color rule: Frozen variant gets a dashed border (rendered as polling-badge--frozen modifier)", () => {
    const ev = mkEvent({
      occurredAt: ago(30 * 86_400_000),
      lastPolledAt: ago(30 * 86_400_000),
    });
    const out = render(PollingBadge, { props: { event: ev } });
    expect(out.body).toMatch(/polling-badge--frozen/);
  });

  it("Pitfall H: ISO-string occurredAt + lastPolledAt are coerced to Date before tier resolution", () => {
    const ev = mkEvent({
      occurredAt: ago(12 * 3_600_000).toISOString(),
      lastPolledAt: ago(3_600_000).toISOString(),
    });
    // Should still pick the Active variant — coercion succeeded.
    const out = render(PollingBadge, { props: { event: ev } });
    expect(out.body).toMatch(/Hot/);
    expect(out.body).toMatch(/polling-badge--active/);
  });
});
