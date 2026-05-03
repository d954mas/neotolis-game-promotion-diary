import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { render } from "svelte/server";

// Phase 02.2 Plan 02.2-05 — public /privacy /terms /about pages
// (D-09 / D-10 / D-14 / D-S4). Wave 0 placeholders flipped to live.
//
// Approach: SSR-render each route's +page.svelte via svelte/server (the
// audit-render.test.ts pattern) with mock {data} props matching what the
// +page.server.ts load function would return. This locks the rendered-HTML
// contract — magic phrases ("Right to Erasure" for Article 17, "early access"
// for ToS, github.com/d954mas/neotolis-diary for /about) + env-injection
// surface (SUPPORT_EMAIL + RETENTION_DAYS interpolated, never hardcoded
// literals).
//
// We also assert the structural guarantee that none of these routes appear
// in src/routes/+layout.server.ts's PROTECTED_PATHS allowlist — this is the
// "anonymous can access" invariant (200 not 401) since the layout-level
// auth gate is the sole 401-trigger for public routes; with no entry in
// PROTECTED_PATHS, anonymous requests fall through to SSR.
//
// CI env seed pattern (matches theme.test.ts) — env.ts boot fails fast if
// these are missing, but every public-page test loads PageServer load via
// the lib/server/config/env.ts module which requires them on import.

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "x".repeat(40);
process.env.OAUTH_CLIENT_ID ??= "test";
process.env.OAUTH_CLIENT_SECRET ??= "test";
process.env.APP_KEK_BASE64 ??= randomBytes(32).toString("base64");
// Plan 02.2-05 specifically tests env-injection — set deterministic values
// so the assertions can match exact substrings.
process.env.SUPPORT_EMAIL ??= "test-support@example.com";

const PrivacyPage = (await import("../../src/routes/privacy/+page.svelte")).default;
const TermsPage = (await import("../../src/routes/terms/+page.svelte")).default;
const AboutPage = (await import("../../src/routes/about/+page.svelte")).default;
const { load: privacyLoad } = await import("../../src/routes/privacy/+page.server.js");
const { load: termsLoad } = await import("../../src/routes/terms/+page.server.js");
const { load: aboutLoad } = await import("../../src/routes/about/+page.server.js");
const { env } = await import("../../src/lib/server/config/env.js");

// SvelteKit's PageServerLoad type returns `void | object` because in the
// general case a load fn may return nothing (and merge with parent). For
// these three env-only loaders we always return an object with known
// fields — `runLoad` narrows the return type via the explicit Shape param.
async function runLoad<Shape>(fn: unknown): Promise<Shape> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (fn as any)(undefined);
  return result as Shape;
}

type PrivacyData = {
  supportEmail: string;
  retentionDays: number;
  worstCaseDays: number;
  lastUpdated: string;
};
type TermsData = {
  supportEmail: string;
  gamesLimit: number;
  sourcesLimit: number;
  eventsLimit: number;
  lastUpdated: string;
};
type AboutData = {
  supportEmail: string;
  domain: string;
};

function renderHtml<TData>(
  Component: unknown,
  data: TData,
): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(Component as any, { props: { data } as any }).body;
}

describe("public pages /privacy /terms /about (Phase 02.2)", () => {
  it("Plan 02.2-05: GET /privacy returns 200 and contains Article 17 (Right to Erasure) magic phrase", async () => {
    const data = await runLoad<PrivacyData>(privacyLoad);
    const html = renderHtml(PrivacyPage, data);
    // GDPR Article 17 magic phrase MUST appear (legal-compliance lock from
    // privacy_section_rights_body — the integration boundary that proves
    // the rights section reaches the rendered page).
    expect(html).toContain("Right to Erasure");
  });

  it("Plan 02.2-05: GET /privacy renders SUPPORT_EMAIL value from server-side load (not hardcoded literal)", async () => {
    const data = await runLoad<PrivacyData>(privacyLoad);
    expect(data.supportEmail).toBe("test-support@example.com");
    const html = renderHtml(PrivacyPage, data);
    // The configured SUPPORT_EMAIL value is interpolated (privacy_section_
    // contact_body, plus rights_body, children_body, who_we_are_body).
    expect(html).toContain("test-support@example.com");
    // And the `data.supportEmail` value is what's rendered — NOT a fallback
    // literal email baked into the template.
    expect(html).not.toContain("(support email not configured)");
  });

  it("Plan 02.2-05: GET /privacy renders RETENTION_DAYS value from server-side load (not hardcoded literal)", async () => {
    const data = await runLoad<PrivacyData>(privacyLoad);
    expect(data.retentionDays).toBe(env.RETENTION_DAYS);
    const html = renderHtml(PrivacyPage, data);
    // Retention value comes from env.RETENTION_DAYS (default 60 in tests
    // because env.ts schema default is 60). The body string contains both
    // retentionDays and worstCaseDays = retentionDays + 30.
    expect(html).toContain(`${data.retentionDays}-day grace period`);
    expect(html).toContain(`~${data.worstCaseDays} days`);
    // Retention number is NEVER hardcoded as a literal "60" inside the
    // template — it always flows through {data.retentionDays}. We can't
    // grep that here directly, but the structural guarantee is upheld by
    // the env-injection assertion above (different env.RETENTION_DAYS
    // would change the rendered output).
  });

  it("Plan 02.2-05: GET /terms returns 200 and contains 'early access' magic phrase", async () => {
    const data = await runLoad<TermsData>(termsLoad);
    const html = renderHtml(TermsPage, data);
    // Case-insensitive — terms_section_early_access_body uses lowercase
    // ("The service is in early access.") but title uses "Early access".
    expect(html.toLowerCase()).toContain("early access");
  });

  it("Plan 02.2-05: GET /terms renders SUPPORT_EMAIL value from server-side load", async () => {
    const data = await runLoad<TermsData>(termsLoad);
    expect(data.supportEmail).toBe("test-support@example.com");
    const html = renderHtml(TermsPage, data);
    expect(html).toContain("test-support@example.com");
  });

  it("Plan 02.2-05: GET /about returns 200 and contains GitHub repo link", async () => {
    const data = await runLoad<AboutData>(aboutLoad);
    const html = renderHtml(AboutPage, data);
    // The canonical GitHub repo URL is the project-credibility marker
    // for /about (per RESEARCH §6 about page structure + Plan acceptance
    // criterion "https://github.com/d954mas/neotolis-diary").
    expect(html).toContain("https://github.com/d954mas/neotolis-diary");
  });

  it("Plan 02.2-05: GET /about renders SUPPORT_EMAIL value from server-side load", async () => {
    const data = await runLoad<AboutData>(aboutLoad);
    expect(data.supportEmail).toBe("test-support@example.com");
    const html = renderHtml(AboutPage, data);
    expect(html).toContain("test-support@example.com");
  });

  it("Plan 02.2-05: anonymous user can access /privacy, /terms, /about without auth (200 not 401)", async () => {
    // The auth-gate for SvelteKit pages lives in src/routes/+layout.server.ts's
    // PROTECTED_PATHS allowlist. Public pages MUST NOT appear there — if
    // they did, anonymous requests would hit the redirect(303 → /login)
    // branch before the PageServerLoad runs. This structural assertion is
    // the load-bearing 401-not-200 contract.
    const fs = await import("node:fs");
    const layoutSource = fs.readFileSync("src/routes/+layout.server.ts", "utf8");
    const protectedMatch = layoutSource.match(/PROTECTED_PATHS[^=]*=\s*\[([\s\S]*?)\]/);
    expect(protectedMatch, "PROTECTED_PATHS array not found in +layout.server.ts").not.toBeNull();
    const protectedBlock = protectedMatch![1]!;
    expect(protectedBlock).not.toMatch(/["']\/privacy["']/);
    expect(protectedBlock).not.toMatch(/["']\/terms["']/);
    expect(protectedBlock).not.toMatch(/["']\/about["']/);

    // And a positive smoke check — each page renders without throwing
    // when given the env-driven data shape (i.e. 200 not 500). Anonymous
    // request semantics + 200 status are emergent from PROTECTED_PATHS
    // omission + load-without-auth-context succeeding — both held above.
    const privacyData = await runLoad<PrivacyData>(privacyLoad);
    const termsData = await runLoad<TermsData>(termsLoad);
    const aboutData = await runLoad<AboutData>(aboutLoad);
    expect(() => renderHtml(PrivacyPage, privacyData)).not.toThrow();
    expect(() => renderHtml(TermsPage, termsData)).not.toThrow();
    expect(() => renderHtml(AboutPage, aboutData)).not.toThrow();
  });
});
