// Defense-in-depth CHECK constraint test.
//
// Migration 0025 adds `audit_log_metadata_flow_valid` pinning
// metadata->>'flow' to the AuditFlow enum. TypeScript catches typos at
// write site (`writeAudit({metadata:{flow:'autoo_passive'}})` fails tsc);
// this suite verifies the DB-level defense fires for raw-SQL writes that
// bypass the typed boundary.
//
// Three branches of the constraint predicate:
//   1. metadata IS NULL                            → pass
//   2. NOT (metadata ? 'flow')                     → pass (legacy verbs)
//   3. metadata->>'flow' IN (...allowed values...) → pass when valid
//   4. metadata->>'flow' = anything else           → REJECT with constraint error
//
// We don't test branch 1 explicitly — every legacy audit row went in
// with metadata != NULL (writeAudit defaults to {}); branch 2 covers the
// vast majority of legacy rows.

import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { seedUserDirectly } from "./helpers.js";

const uniq = (): string => Math.random().toString(36).slice(2, 10);

describe("audit_log metadata.flow CHECK constraint (migration 0025)", () => {
  it("rejects raw INSERT with invalid flow value", async () => {
    const u = await seedUserDirectly({ email: `flow-bad-${uniq()}@test.local` });
    interface PgError {
      code?: string;
      constraint?: string;
      cause?: { code?: string; constraint?: string };
    }
    let caught: PgError | null = null;
    try {
      await db.execute(sql`
        INSERT INTO audit_log (id, user_id, action, ip_address, metadata)
        VALUES (${uuidv7()}, ${u.id}, 'event.created', '127.0.0.1',
                '{"flow":"autoo_passive"}'::jsonb)
      `);
    } catch (err) {
      caught = err as PgError;
    }
    // Drizzle wraps the underlying pg error; the cause chain carries
    // PG error code 23514 (check_violation) + constraint name.
    expect(caught).not.toBeNull();
    const err = caught as PgError;
    const code = err.code ?? err.cause?.code;
    const constraint = err.constraint ?? err.cause?.constraint;
    expect(code).toBe("23514");
    expect(constraint).toBe("audit_log_metadata_flow_valid");
  });

  it("accepts raw INSERT with valid flow value (incremental)", async () => {
    const u = await seedUserDirectly({ email: `flow-good-${uniq()}@test.local` });
    await expect(
      db.execute(sql`
        INSERT INTO audit_log (id, user_id, action, ip_address, metadata)
        VALUES (${uuidv7()}, ${u.id}, 'source.refresh_content_requested', '127.0.0.1',
                '{"flow":"incremental","requests_used":1,"events_inserted":0}'::jsonb)
      `),
    ).resolves.toBeDefined();
  });

  it("accepts raw INSERT without flow key (legacy verbs)", async () => {
    const u = await seedUserDirectly({ email: `flow-none-${uniq()}@test.local` });
    await expect(
      db.execute(sql`
        INSERT INTO audit_log (id, user_id, action, ip_address, metadata)
        VALUES (${uuidv7()}, ${u.id}, 'session.signin', '127.0.0.1',
                '{"event_id":"abc"}'::jsonb)
      `),
    ).resolves.toBeDefined();
  });

  it("accepts every value declared in AuditFlow union", async () => {
    const u = await seedUserDirectly({ email: `flow-all-${uniq()}@test.local` });
    const allowed = ["initial", "incremental", "historical", "stats_refresh", "auto_passive"];
    for (const flow of allowed) {
      await expect(
        db.execute(sql`
          INSERT INTO audit_log (id, user_id, action, ip_address, metadata)
          VALUES (${uuidv7()}, ${u.id}, 'event.created', '127.0.0.1',
                  ${JSON.stringify({ flow })}::jsonb)
        `),
      ).resolves.toBeDefined();
    }
  });
});
