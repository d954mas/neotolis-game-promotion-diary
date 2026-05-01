import { describe, it } from "vitest";

// Phase 02.2 Wave 0 placeholder — closed by Plan 02.2-05 (public /privacy,
// /terms, /about pages per CONTEXT D-09 / D-10 / D-14 / D-S4). Each it.skip
// name starts with `Plan 02.2-05:` so the executor agent for that plan greps
// + flips to live tests without scaffolding rounds.

describe("public pages /privacy /terms /about (Phase 02.2)", () => {
  it.skip("Plan 02.2-05: GET /privacy returns 200 and contains Article 17 (Right to Erasure) magic phrase", () => {});
  it.skip("Plan 02.2-05: GET /privacy renders SUPPORT_EMAIL value from server-side load (not hardcoded literal)", () => {});
  it.skip("Plan 02.2-05: GET /privacy renders RETENTION_DAYS value from server-side load (not hardcoded literal)", () => {});
  it.skip("Plan 02.2-05: GET /terms returns 200 and contains 'early access' magic phrase", () => {});
  it.skip("Plan 02.2-05: GET /terms renders SUPPORT_EMAIL value from server-side load", () => {});
  it.skip("Plan 02.2-05: GET /about returns 200 and contains GitHub repo link", () => {});
  it.skip("Plan 02.2-05: GET /about renders SUPPORT_EMAIL value from server-side load", () => {});
  it.skip("Plan 02.2-05: anonymous user can access /privacy, /terms, /about without auth (200 not 401)", () => {});
});
