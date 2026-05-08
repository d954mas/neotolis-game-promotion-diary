// Phase 3.0 post-build (UAT 2026-05-06): the Permanent-delete-now CTA
// was MOVED from AccountDeletedBanner to /settings. Operator's call:
// destructive button next to Restore on every page = footgun. The
// banner now stays minimal (Restore only); /settings owns the
// immediate-purge UI under the existing danger-zone disclosure when
// the account is already soft-deleted.
//
// SSR-render coverage (this file):
//   - Test 1: When deletedAt is set, the banner renders the Restore
//             button and ONLY the Restore button — no purge CTA on
//             this surface anymore.
//   - Test 2: The component source no longer references the purge
//             fetch / signOut redirect / ConfirmDialog. (Those move
//             to /settings; tests/unit/settings-page.test.ts can pick
//             that up if/when added.)
//   - Test 3: PUTOFF marker stays gone (was removed in Plan 03.0-12).

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(),
}));
vi.mock("$lib/auth-client", () => ({
  authClient: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  useSession: vi.fn(),
}));

const { render } = await import("svelte/server");
const AccountDeletedBanner = (await import("../../src/lib/components/AccountDeletedBanner.svelte"))
  .default;

const SOURCE_PATH = resolve(__dirname, "../../src/lib/components/AccountDeletedBanner.svelte");
const sourceText = readFileSync(SOURCE_PATH, "utf8");

describe("AccountDeletedBanner — minimal banner contract (UAT 2026-05-06)", () => {
  it("renders the Restore button when deletedAt is set", () => {
    const out = render(AccountDeletedBanner, {
      props: {
        deletedAt: new Date("2026-05-01T00:00:00Z"),
        retentionDays: 60,
      },
    });
    expect(out.body).toMatch(/class="[^"]*\brestore\b[^"]*"/);
  });

  it("does NOT render a Permanently-delete-now CTA on the banner", () => {
    const out = render(AccountDeletedBanner, {
      props: {
        deletedAt: new Date("2026-05-01T00:00:00Z"),
        retentionDays: 60,
      },
    });
    expect(out.body).not.toContain("Permanently delete now");
    expect(out.body).not.toMatch(/class="[^"]*\bpurge-cta\b[^"]*"/);
  });

  it("the component source no longer wires the purge fetch / signOut / ConfirmDialog (moved to /settings)", () => {
    expect(sourceText).not.toContain("/api/me/account/purge");
    expect(sourceText).not.toContain("ConfirmDialog");
    expect(sourceText).not.toContain("signOut");
  });

  it("the Phase 02.2 PUTOFF marker stays gone", () => {
    expect(sourceText).not.toContain("PUTOFF");
  });
});
