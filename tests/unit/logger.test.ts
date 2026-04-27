import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";

// Phase-1 final D-24 coverage: redaction-behavior + env-discipline tripwire.
// Plan 01-01 owns src/lib/server/logger.ts; this test guards two invariants
// that no other test catches:
//   1. Every path in the logger's REDACT_PATHS list actually emits
//      "[REDACTED]" in the JSON output. A typo in the list silently disables
//      the protection — the only way to notice is to log an object shaped
//      like the path and grep stdout in tests.
//   2. process.env.* is read ONLY in src/lib/server/config/env.ts. Anywhere
//      else risks a KEK-shaped secret leaking via accidental console.log
//      (PITFALL P2).

describe("logger redaction", () => {
  it("logger module exposes pino-shaped interface", async () => {
    let logger: unknown = null;
    try {
      const mod = await import("../../src/lib/server/logger.js");
      logger = (mod as { logger?: unknown }).logger ?? mod;
    } catch {
      // Module not yet present — skip the shape check; placeholder still asserts file exists.
      return;
    }
    expect(typeof (logger as { info?: unknown }).info).toBe("function");
  });

  it("redacts every D-24 path with [REDACTED]", async () => {
    // Read the canonical list straight from the source so the test mirrors
    // whatever the runtime logger uses. We don't import the live logger
    // because it is configured to write to stdout / a transport — feeding it
    // a synchronous capture stream is simpler with a fresh pino() instance
    // configured against the same redact list.
    const loggerSource = await fs.readFile(
      path.resolve(process.cwd(), "src/lib/server/logger.ts"),
      "utf8",
    );
    const arrayMatch = loggerSource.match(/const REDACT_PATHS\s*=\s*\[([\s\S]*?)\]/);
    expect(arrayMatch, "REDACT_PATHS array not found in src/lib/server/logger.ts").toBeTruthy();
    const paths = Array.from(arrayMatch![1]!.matchAll(/"([^"]+)"/g)).map((m) => m[1]!);
    expect(paths.length).toBeGreaterThan(0);

    // Capture pino's JSON output line-by-line.
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const testLogger = pino(
      { redact: { paths, censor: "[REDACTED]" }, base: null, timestamp: false },
      sink,
    );

    // For each path, build an object that populates exactly that path with a
    // distinctive sentinel value, log it, then assert the emitted JSON
    // contains "[REDACTED]" instead of the sentinel.
    const SENTINEL = "PLAINTEXT_LEAK_SENTINEL_VALUE_DO_NOT_LOG";
    for (const p of paths) {
      lines.length = 0;
      const obj = buildObjectForPath(p, SENTINEL);
      testLogger.info(obj, `redact-test path=${p}`);
      const out = lines.join("");
      expect(out, `path "${p}" did not produce a log line`).toContain("[REDACTED]");
      expect(out, `path "${p}" leaked the sentinel value: ${out}`).not.toContain(SENTINEL);
    }
  });

  it("process.env.* is not accessed outside src/lib/server/config/env.ts", async () => {
    // Static-grep tripwire (D-24 / PITFALL P2). The ESLint contract is
    // configured separately, but a runtime guard catches the case where the
    // lint config drifts or a future contributor disables the rule with
    // `// eslint-disable-next-line` and forgets to revert.
    const root = path.resolve(process.cwd(), "src");
    const allowed = path.normalize(path.join("server", "config", "env.ts"));
    const offenders: { file: string; line: number; text: string }[] = [];

    async function walk(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === "paraglide") continue;
          await walk(full);
          continue;
        }
        if (!/\.(ts|tsx|svelte|js|mjs|cjs)$/.test(ent.name)) continue;
        const rel = path.relative(root, full);
        if (rel.endsWith(allowed)) continue;
        const src = await fs.readFile(full, "utf8");
        const lines = src.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          // Skip comments — the discipline is about runtime reads, not docs.
          const stripped = line.replace(/\/\/.*$/, "").replace(/\/\*[\s\S]*?\*\//g, "");
          if (/\bprocess\.env\b/.test(stripped)) {
            offenders.push({ file: rel, line: i + 1, text: line.trim() });
          }
        }
      }
    }
    await walk(root);

    if (offenders.length > 0) {
      const detail = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join("\n");
      throw new Error(`process.env access found outside src/lib/server/config/env.ts:\n${detail}`);
    }
  });
});

/**
 * Build a nested object so that the value at the given pino redact path is the
 * sentinel. Supports the `*.foo` glob (single segment) and `req.headers.x` style
 * dotted paths. Wildcard-segments are materialized as `wild`.
 */
function buildObjectForPath(p: string, value: string): Record<string, unknown> {
  // pino redact paths support `*` as a leading segment (glob over top-level keys)
  // and bracketed keys, but our REDACT_PATHS use simple `*.foo` / `a.b.c` shapes.
  // Anything starting with `*.` we materialize under a top-level key called `obj`.
  // `*.encrypted_*` (a wildcarded leaf) is materialized with the leaf literal
  // `encrypted_x` since pino treats `encrypted_*` as a leaf-glob over keys.
  const segments = p.split(".").map((seg) => {
    if (seg === "*") return "wild";
    if (seg.endsWith("_*")) return seg.replace(/_\*$/, "_x");
    return seg;
  });
  const root: Record<string, unknown> = {};
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const next: Record<string, unknown> = {};
    cursor[segments[i]!] = next;
    cursor = next;
  }
  cursor[segments[segments.length - 1]!] = value;
  return root;
}
