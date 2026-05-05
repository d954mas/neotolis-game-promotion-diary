// Phase 03.0 Plan 12 — AccountDeletedBanner Permanent-delete-now CTA
// (DV-6 activation; UI-SPEC §"Interaction Contracts → AccountDeletedBanner").
//
// SSR-render coverage (this file):
//   - Test 1: When deletedAt is set, the banner renders BOTH the existing
//             Restore button AND the new "Permanently delete now" CTA
//             (the Phase 02.2-04 PUTOFF gate has been removed in 03.0-12).
//   - Test 2: The new CTA carries `class="purge-cta"` (destructive variant)
//             and the Paraglide-keyed copy "Permanently delete now". This
//             is the literal text from messages/en.json line 420.
//   - Test 3: The component embeds <ConfirmDialog requireText="DELETE"
//             isIrreversible={true}> as its purge confirmation. Both gates
//             engaged per UI-SPEC Destructive Confirmations table (D-S3
//             pattern reused verbatim from Phase 02.2).
//   - Test 4: The component imports the DELETE /api/me/account/purge fetch
//             call AND the signOut helper — verified by source-text grep
//             (the SSR render does not exercise click handlers).
//
// The click → fetch → signOut → goto flow is exercised at the HTTP/integration
// boundary (tests/integration/account-state.test.ts) and the eventual
// Playwright suite. SSR-render here is the static-shape contract.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// SvelteKit virtual modules — `$app/navigation` is unavailable outside the
// SvelteKit runtime. The component imports `goto` and `invalidateAll` for
// its click handler; the SSR-render path never calls them, but the static
// import has to resolve. Mock with no-op stubs.
vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(),
}));

// Same story for `$lib/auth-client` — Better Auth's createAuthClient calls
// fetch at module load, which fails in node. The SSR-render path never
// invokes signOut; stub it with a no-op.
vi.mock("$lib/auth-client", () => ({
  authClient: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  useSession: vi.fn(),
}));

const { render } = await import("svelte/server");
const AccountDeletedBanner = (
  await import("../../src/lib/components/AccountDeletedBanner.svelte")
).default;

const SOURCE_PATH = resolve(
  __dirname,
  "../../src/lib/components/AccountDeletedBanner.svelte",
);
const sourceText = readFileSync(SOURCE_PATH, "utf8");

describe("Plan 03.0-12 — AccountDeletedBanner Permanent-delete-now CTA (DV-6)", () => {
  it("renders BOTH Restore button AND Permanently delete now CTA when deletedAt is set", () => {
    const out = render(AccountDeletedBanner, {
      props: {
        deletedAt: new Date("2026-05-01T00:00:00Z"),
        retentionDays: 60,
      },
    });
    // Existing Restore button stays.
    expect(out.body).toMatch(/class="[^"]*\brestore\b[^"]*"/);
    // New CTA — text from messages/en.json key
    // account_deleted_banner_permanent_delete_button.
    expect(out.body).toContain("Permanently delete now");
  });

  it("the new CTA carries the destructive variant class", () => {
    const out = render(AccountDeletedBanner, {
      props: {
        deletedAt: new Date("2026-05-01T00:00:00Z"),
        retentionDays: 60,
      },
    });
    // The purge CTA must be visually distinct (destructive fill — UI-SPEC
    // §Color → Destructive new surfaces). We use class="purge-cta" as the
    // CSS hook; the auditor + Plan 13 audit checks grep for this token.
    expect(out.body).toMatch(/class="[^"]*\bpurge-cta\b[^"]*"/);
  });

  it("the component source imports ConfirmDialog and uses requireText=\"DELETE\" isIrreversible={true} (D-S3 pattern)", () => {
    expect(sourceText).toContain("ConfirmDialog");
    expect(sourceText).toContain('requireText="DELETE"');
    expect(sourceText).toContain("isIrreversible={true}");
  });

  it("the component source wires the DELETE /api/me/account/purge fetch + signOut + invalidateAll redirect", () => {
    expect(sourceText).toContain("/api/me/account/purge");
    expect(sourceText).toMatch(/method:\s*"DELETE"/);
    expect(sourceText).toContain("signOut");
    expect(sourceText).toContain("invalidateAll: true");
  });

  it("the component source references the new permanent-delete failure + pending Paraglide keys", () => {
    expect(sourceText).toContain("account_deleted_banner_permanent_delete_failed");
    expect(sourceText).toContain("account_deleted_banner_permanent_delete_pending");
    expect(sourceText).toContain("account_deleted_banner_permanent_delete_button");
  });

  it("the Phase 02.2 PUTOFF marker is removed from the component source", () => {
    expect(sourceText).not.toContain("PUTOFF");
  });
});
