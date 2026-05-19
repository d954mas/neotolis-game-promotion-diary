// Render-time guard for the live-state PollingBadge rewrite (5
// user-facing variants).
//
// Uses Svelte 5 SSR via `svelte/server` — same pattern as
// audit-render.test.ts and tests/unit/account-deleted-banner.test.ts.
//
// FILE LOCATION DEVIATION: the test was originally planned at
// tests/browser/polling-badge.test.ts but vitest's browser-mode bundler
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
// end-to-end is deferred along with the rest of the auth-harness surface
// (same precedent as feed-360.test.ts skips for /feed at 360px).
//
// Coverage:
//   1. Active tier — Hot · checked Xh ago
//   2. Cold tier — Cold variant copy with day count
//   3. Frozen tier — Frozen · refresh to update
//   4. lastPollStatus override — Unavailable · last seen Xd ago
//   5. Manual entry — lastPolledAt=null + Active tier; refresh button HIDDEN
//   6. Non-pollable kind — component renders nothing
//   7. RefreshNowButton renders inline when refresh affordance is visible
//
// All copy comes from messages/en.json via Paraglide;
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
  publishedAt: Date | string | null;
  lastPolledAt: Date | string | null;
  lastPollStatus: string | null;
  metadata: Record<string, unknown> | null;
};

function mkEvent(overrides: Partial<EventForBadge> = {}): EventForBadge {
  // Per-video refactor (2026-05-06): tier resolves on publishedAt.
  // Default mirrors the old occurredAt-driven Active tier (12h-old).
  return {
    id: "evt-1",
    kind: "youtube_video",
    occurredAt: ago(12 * 3_600_000),
    publishedAt: ago(12 * 3_600_000),
    lastPolledAt: ago(3_600_000),
    lastPollStatus: "ok",
    metadata: null,
    ...overrides,
  };
}

describe("PollingBadge — live state", () => {
  // Badge text replaced tier vocab ("Hot/Cold/Frozen") with relative-time
  // copy ("Updated 1h ago"). Tier
  // still drives the variant CSS class for color rules. Tests assert
  // both: relative-time copy AND variant class so style/copy contracts
  // stay independent.
  it("Active tier (12h occurred, 1h polled): renders 'Updated Xh ago' + refresh button", () => {
    const out = render(PollingBadge, { props: { event: mkEvent() } });
    expect(out.body).toMatch(/Updated \d+h ago/);
    expect(out.body).toMatch(/class="refresh-now/);
    expect(out.body).toMatch(/polling-badge--active/);
  });

  it("Queued refresh: request newer than last poll renders transient queued state", () => {
    const ev = mkEvent({
      lastPolledAt: ago(3_600_000),
      metadata: { last_user_refresh_at: ago(60_000).toISOString() },
    });
    const out = render(PollingBadge, { props: { event: ev } });
    expect(out.body).toMatch(/Refresh queued/);
    expect(out.body).toMatch(/polling-badge--refreshing/);
  });

  it("Cold tier (5d published, 30h polled): renders 'Updated Xd ago' + cold variant", () => {
    const ev = mkEvent({
      occurredAt: ago(5 * 86_400_000),
      publishedAt: ago(5 * 86_400_000),
      lastPolledAt: ago(30 * 3_600_000),
    });
    const out = render(PollingBadge, { props: { event: ev } });
    expect(out.body).toMatch(/Updated \d+d ago/);
    expect(out.body).toMatch(/polling-badge--cold-(yesterday|days-ago)/);
  });

  it("Cold tier (5d published, 24h polled): renders 'Updated 1d ago'", () => {
    const ev = mkEvent({
      occurredAt: ago(5 * 86_400_000),
      publishedAt: ago(5 * 86_400_000),
      lastPolledAt: ago(86_400_000),
    });
    const out = render(PollingBadge, { props: { event: ev } });
    expect(out.body).toMatch(/Updated 1d ago/);
  });

  it("Frozen tier (30d published, 30d polled): renders 'Updated <date>' + refresh button", () => {
    const ev = mkEvent({
      occurredAt: ago(30 * 86_400_000),
      publishedAt: ago(30 * 86_400_000),
      lastPolledAt: ago(30 * 86_400_000),
    });
    const out = render(PollingBadge, { props: { event: ev } });
    // Beyond 30 days the relative-time copy switches to a localized date
    // string. Assert the "Updated " prefix without pinning the date format.
    expect(out.body).toMatch(/Updated \S+/);
    expect(out.body).toMatch(/polling-badge--frozen/);
    // Refresh-now visible whenever tier !== 'pending'
    // (was previously gated also on lastPolledAt !== null OR tier === 'frozen').
    expect(out.body).toMatch(/class="refresh-now/);
  });

  it("Unavailable: lastPollStatus='not_found' overrides age-based tier", () => {
    const ev = mkEvent({
      lastPollStatus: "not_found",
      lastPolledAt: ago(2 * 86_400_000),
    });
    const out = render(PollingBadge, { props: { event: ev } });
    expect(out.body).toMatch(/Unavailable · updated/);
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

  it("Manual entry: lastPolledAt=null + Active tier renders Manual variant + refresh button visible", () => {
    const ev = mkEvent({
      lastPolledAt: null,
      occurredAt: ago(3_600_000),
      publishedAt: ago(3_600_000),
    });
    const out = render(PollingBadge, { props: { event: ev } });
    expect(out.body).toMatch(/Manual entry/);
    expect(out.body).toMatch(/no polling/);
    expect(out.body).toMatch(/polling-badge--manual/);
    // Refresh-now visible (was hidden pre-UAT). The
    // sync-stats hook in createEvent makes manual-tier-with-null-poll a
    // rare edge case (only on rate-limit / auth-error swallow), and when
    // it does happen the user needs a way to retry.
    expect(out.body).toMatch(/class="refresh-now/);
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

  it("Pollable kind (kind=reddit_post): renders polling-badge with refresh-now button", () => {
    // Phase 03.1 v0.1 UAT: reddit_post joined POLLABLE_KINDS so the
    // RefreshNowButton + tier-coloured status text show up on the event
    // detail surface for Reddit posts (same shape as youtube_video).
    const ev = mkEvent({ kind: "reddit_post" });
    const out = render(PollingBadge, { props: { event: ev } });
    expect(out.body).toMatch(/class="polling-badge[^_]/);
    expect(out.body).toMatch(/refresh-now/);
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
      publishedAt: ago(30 * 86_400_000),
      lastPolledAt: ago(30 * 86_400_000),
    });
    const out = render(PollingBadge, { props: { event: ev } });
    expect(out.body).toMatch(/polling-badge--frozen/);
  });

  it("ISO-string publishedAt + lastPolledAt are coerced to Date before tier resolution", () => {
    const ev = mkEvent({
      occurredAt: ago(12 * 3_600_000).toISOString(),
      publishedAt: ago(12 * 3_600_000).toISOString(),
      lastPolledAt: ago(3_600_000).toISOString(),
    });
    // Should still pick the Active variant — coercion succeeded.
    const out = render(PollingBadge, { props: { event: ev } });
    expect(out.body).toMatch(/Updated 1h ago/);
    expect(out.body).toMatch(/polling-badge--active/);
  });

  it("Pending tier: publishedAt=null renders 'Pending · fetching video info…' + HIDES refresh", () => {
    // Per-video refactor (2026-05-06): backfill in flight, no publishedAt
    // yet. Brief window between event creation and channel-context-backfill
    // completion. Refresh-poll service rejects 'pending' with 422; UI hides
    // the button to avoid the dead click.
    const ev = mkEvent({ publishedAt: null, lastPolledAt: null });
    const out = render(PollingBadge, { props: { event: ev } });
    expect(out.body).toMatch(/Pending/);
    expect(out.body).toMatch(/fetching/);
    expect(out.body).toMatch(/polling-badge--pending/);
    expect(out.body).not.toMatch(/class="refresh-now/);
  });
});
