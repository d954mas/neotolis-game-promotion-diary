// KEK batch rotation — the shared core invoked by BOTH the operator script
// (scripts/rotate-kek.ts) AND the permanent CI integration test
// (tests/integration/kek-rotation.test.ts). One code path so the drill the
// operator runs is the exact code CI proves every PR (D-13 / DEPLOY-04). A
// one-time runbook transcript rots into aspiration; a permanent test cannot
// (PITFALLS P20).
//
// What it does: walks every envelope-encrypted table and, for each row still
// wrapped under an older KEK, re-wraps its per-row DEK under the target KEK
// version using rotateDek (envelope.ts). The ciphertext (secret_ct) is never
// touched — only the wrapped DEK changes — so rotation is cheap and online
// (D-10). kek_version IS the resumable checkpoint: a crash-rerun re-selects
// only the rows that have not yet advanced, so rotation is idempotent and safe
// to re-run.
//
// No new crypto lives here — the per-row primitive is rotateDek. No checkpoint
// table — the row's own kek_version column is the cursor. No tenant scoping —
// this is operator maintenance that re-wraps EVERY tenant's keys by design, so
// each unfiltered query carries an inline tenant-scope opt-out with the
// required justification.

import { lt, eq, asc, getTableName } from "drizzle-orm";
import { db } from "../db/client.js";
import { apiKeysSteam } from "../db/schema/api-keys-steam.js";
import { env } from "../config/env.js";
import { rotateDek, type EncryptedSecret } from "./envelope.js";

export interface RotateOptions {
  /** Target KEK version every candidate row is re-wrapped to. Required. */
  to: number;
  /** Rows per transaction. Default 500 — batch-level granularity is safe
   *  because the kek_version checkpoint makes partial progress resumable. */
  batchSize?: number;
  /** Verify-only: decrypt each candidate under its current KEK to prove the
   *  row is sound, then issue NO UPDATE. */
  dryRun?: boolean;
}

export interface RotateResult {
  table: string;
  /** Rows still below the target version at the start of this run. */
  candidates: number;
  /** Rows whose DEK was re-wrapped and persisted (0 in dry-run). */
  rotated: number;
  /** Rows whose re-wrap (or dry-run decrypt) succeeded. */
  verified: number;
  /** Row ids whose DEK could not be unwrapped (tamper / corruption) — surfaced,
   *  never silently skipped. */
  failures: string[];
}

// ONE-entry table registry today: only api_keys_steam carries wrapped_dek.
// Append a future encrypted table here — KISS, no premature abstraction. Every
// entry must expose the EncryptedSecret column set (secret_ct/iv/tag,
// wrapped_dek/iv/tag, kek_version) plus an `id` PK and a `rotatedAt` column.
const ENCRYPTED_TABLES = [apiKeysSteam] as const;

export async function rotateAllDeks(opts: RotateOptions): Promise<RotateResult[]> {
  // Fail fast with a friendly message if the target KEK is not loaded. loadKek
  // would throw on the first row anyway, but a pre-check turns an operator
  // misconfiguration into a clear "you forgot APP_KEK_V{to}_BASE64" error
  // before any row work begins.
  if (!env.KEK_VERSIONS.has(opts.to)) {
    throw new Error(
      `KEK v${opts.to} not loaded — set APP_KEK_V${opts.to}_BASE64 and reboot before rotating`,
    );
  }

  const batchSize = opts.batchSize ?? 500;
  const results: RotateResult[] = [];

  for (const table of ENCRYPTED_TABLES) {
    const tableName = getTableName(table);
    let rotated = 0;
    let verified = 0;
    const failures: string[] = [];

    // Cursor predicate: kek_version < to is the natural resumable cursor.
    // Order by id so a crash-rerun re-walks deterministically.
    // This is an UNFILTERED (all-tenant) read of api_keys_steam BY DESIGN —
    // operator KEK-rotation maintenance, not a per-tenant query. No
    // eslint-disable: `table` comes from the ENCRYPTED_TABLES registry (not a
    // literal table ref), so the tenant-scope rule cannot match it and never
    // fires here — a disable would be a dead directive.
    const rows = await db
      .select()
      .from(table)
      .where(lt(table.kekVersion, opts.to))
      .orderBy(asc(table.id));

    const candidates = rows.length;

    for (let start = 0; start < rows.length; start += batchSize) {
      const batch = rows.slice(start, start + batchSize);

      // Re-wrap (and persist) one batch in a single transaction. Batch-level
      // granularity is fine: the kek_version checkpoint makes partial progress
      // safe, so a crash mid-rotation leaves a clean resumable cursor.
      await db.transaction(async (tx) => {
        for (const row of batch) {
          let next: EncryptedSecret;
          try {
            // rotateDek unwraps under the row's current KEK and re-wraps under
            // `to`; throws on auth-tag mismatch (tamper) or unknown KEK.
            next = rotateDek(row as unknown as EncryptedSecret, opts.to);
          } catch {
            // Surface the failing row id — never silently skip an undecryptable
            // row. The operator investigates; the row stays at its old version.
            failures.push(row.id);
            continue;
          }
          verified++;

          if (!opts.dryRun) {
            // All-tenant UPDATE by design (see the select above) — registry-
            // driven `table` ref, not matched by the tenant-scope rule.
            await tx
              .update(table)
              .set({
                wrappedDek: next.wrappedDek,
                dekIv: next.dekIv,
                dekTag: next.dekTag,
                kekVersion: next.kekVersion,
                rotatedAt: new Date(),
              })
              .where(eq(table.id, row.id));
            rotated++;
          }
        }
      });
    }

    results.push({ table: tableName, candidates, rotated, verified, failures });
  }

  return results;
}
