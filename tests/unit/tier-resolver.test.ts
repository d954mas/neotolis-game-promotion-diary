// Phase 3.0 Wave 0 placeholder — assertions activate in Plan 03.0-03.
// Tier-resolver is the single source of truth for the Active / Cold /
// Frozen / Unavailable bucket of an event (CONTEXT DV-2 — Pitfall 7
// avoidance: no tier logic in any other service / route / Svelte
// component). Boundary tests are the load-bearing guard against drift in
// the cutoffs.
import { describe, it } from "vitest";

describe("tier-resolver (Plan 03.0-03)", () => {
  it.skip("boundary 23h59m → active — activated in Plan 03.0-03", () => {});
  it.skip("boundary 24h → cold — activated in Plan 03.0-03", () => {});
  it.skip("boundary 27d23h59m → cold — activated in Plan 03.0-03", () => {});
  it.skip("boundary 28d → frozen — activated in Plan 03.0-03", () => {});
  it.skip("lastPollStatus=not_found overrides → unavailable — activated in Plan 03.0-03", () => {});
  it.skip("lastPollStatus=private overrides → unavailable — activated in Plan 03.0-03", () => {});
  it.skip("lastPollStatus=auth_error overrides → unavailable — activated in Plan 03.0-03", () => {});
});
