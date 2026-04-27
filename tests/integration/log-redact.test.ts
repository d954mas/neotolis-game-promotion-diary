import { describe, it, expect, vi } from "vitest";
import { writeAudit } from "../../src/lib/server/audit.js";
import { logger } from "../../src/lib/server/logger.js";
import { createSteamKey } from "../../src/lib/server/services/api-keys-steam.js";
import * as SteamApi from "../../src/lib/server/integrations/steam-api.js";
import { seedUserDirectly } from "./helpers.js";

/**
 * Plan 02-08 — cross-cutting Pino redact (P3 + D-24).
 *
 * The Wave 0 placeholder for "ciphertext field names never logged during
 * request flow" lights up here. The assertion is coarse but load-bearing:
 *
 *   1. The plaintext input to `createSteamKey` MUST NOT appear in any
 *      logged line. (If it did, an attacker reading the operator's log
 *      stream would steal Steam keys.)
 *   2. The ciphertext column NAMES (secret_ct, wrappedDek, etc.) MAY appear
 *      in logs (e.g. as Pino's "[REDACTED]" placeholder for the field) but
 *      the ASSOCIATED VALUE — a base64-shaped string of meaningful length —
 *      MUST NOT appear next to those names. This proxies for "the bytes
 *      of the ciphertext didn't leak".
 *
 * Capture strategy: spy on the four logger output methods. This is
 * coarser than attaching a stream to Pino but sufficient for the
 * cross-cutting check the plan requires; tightening (e.g. fast-redact
 * fuzzing) is Phase 6 polish.
 */
describe("cross-cutting Pino redact (P3 + D-24)", () => {
  it("02-08: cross-cutting Pino redact — ciphertext field names never logged during request flow", async () => {
    const captured: string[] = [];
    const originalInfo = logger.info.bind(logger);
    const originalWarn = logger.warn.bind(logger);
    const originalError = logger.error.bind(logger);
    const originalDebug = logger.debug.bind(logger);

    const wrap =
      <F extends (...a: unknown[]) => unknown>(fn: F) =>
      (...args: unknown[]) => {
        try {
          captured.push(JSON.stringify(args));
        } catch {
          // Some args carry circular refs; fall back to String().
          captured.push(args.map((a) => String(a)).join(" "));
        }
        return fn(...args);
      };

    (logger as unknown as { info: unknown }).info = wrap(originalInfo);
    (logger as unknown as { warn: unknown }).warn = wrap(originalWarn);
    (logger as unknown as { error: unknown }).error = wrap(originalError);
    (logger as unknown as { debug: unknown }).debug = wrap(originalDebug);

    try {
      vi.spyOn(SteamApi, "validateSteamKey").mockResolvedValue(true);
      const u = await seedUserDirectly({ email: "lr@test.local" });
      const PLAIN = "STEAM-LOG-REDACT-TEST-XYZW";

      // The full lifecycle that exercises the audit + envelope-encryption paths.
      await createSteamKey(u.id, { label: "L", plaintext: PLAIN }, "127.0.0.1");
      await writeAudit({
        userId: u.id,
        action: "session.signin",
        ipAddress: "127.0.0.1",
      });

      const all = captured.join("\n");

      // (1) The plaintext MUST NEVER appear in any logged line.
      expect(all).not.toContain(PLAIN);

      // (2) Ciphertext bytes (base64-shaped string after a known column-name key)
      //     MUST NOT appear in logs. Pino's redact paths cover camelCase variants
      //     of these (D-24 / src/lib/server/logger.ts). The check below is a
      //     belt-and-suspenders proxy: if the ciphertext bytes leaked alongside
      //     the field name, we'd spot the regex hit and fail.
      const ciphertextNames = [
        "secret_ct",
        "secretCt",
        "wrapped_dek",
        "wrappedDek",
        "kekVersion",
        "kek_version",
      ];
      for (const name of ciphertextNames) {
        const re = new RegExp(`"${name}":"[A-Za-z0-9+/=]{8,}"`, "g");
        const hits = all.match(re) ?? [];
        expect(
          hits.length,
          `field "${name}" must not log raw base64-shaped bytes (got ${hits.length})`,
        ).toBe(0);
      }
    } finally {
      (logger as unknown as { info: unknown }).info = originalInfo;
      (logger as unknown as { warn: unknown }).warn = originalWarn;
      (logger as unknown as { error: unknown }).error = originalError;
      (logger as unknown as { debug: unknown }).debug = originalDebug;
    }
  });
});
