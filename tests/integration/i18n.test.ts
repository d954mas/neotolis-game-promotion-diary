import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Plan 01-09 (Wave 4) — UX-04 i18n at runtime.
// VALIDATION 18 end-to-end "render a SvelteKit page through Hono and grep
// English text from the response body" lands in Plan 10's Docker smoke test
// (which boots the actual built image). At the integration-test layer we
// assert the contract that ties .svelte files to messages/en.json:
//   every m.<key>(...) reference in src/routes/*.svelte MUST resolve to a key
//   defined in messages/en.json. This catches typos that the TypeScript
//   build-time check would also catch (Paraglide generates typed exports),
//   but matters in addition because the test runs without requiring the
//   Paraglide compile step to have produced output yet.
describe("i18n at runtime (UX-04, VALIDATION 18)", () => {
  it("messages/en.json exists, is valid JSON, and contains every key referenced by Phase 1 .svelte files", () => {
    const raw = JSON.parse(fs.readFileSync(path.resolve("messages/en.json"), "utf8"));
    // Grep the .svelte files for m.<key>(...) references and assert each key exists.
    const svelteFiles = [
      path.resolve("src/routes/+page.svelte"),
      path.resolve("src/routes/login/+page.svelte"),
      path.resolve("src/routes/+layout.svelte"),
    ].filter((f) => fs.existsSync(f));
    const usedKeys = new Set<string>();
    const re = /m\.([a-z][a-z_0-9]*)\s*\(/g;
    for (const f of svelteFiles) {
      const src = fs.readFileSync(f, "utf8");
      let match: RegExpExecArray | null;
      while ((match = re.exec(src)) !== null) {
        usedKeys.add(match[1]!);
      }
    }
    expect(usedKeys.size).toBeGreaterThan(0);
    for (const key of usedKeys) {
      expect(raw, `messages/en.json missing key referenced from .svelte: ${key}`).toHaveProperty(
        key,
      );
    }
  });
});
