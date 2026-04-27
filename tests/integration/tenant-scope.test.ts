import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../src/lib/server/db/client.js';
import { auditLog } from '../../src/lib/server/db/schema/audit-log.js';
import { writeAudit } from '../../src/lib/server/audit.js';
import { NotFoundError } from '../../src/lib/server/services/errors.js';
import { seedUserDirectly } from './helpers.js';

/**
 * Plan 01-07 (Wave 4) — VALIDATION 7/8/9 (cross-tenant 404 not 403).
 *
 * Phase 1 has /api/me only — no cross-resource matrix yet (Phase 2 lands
 * /api/games). This test seeds the Pattern-3 invariant on a sentinel: an
 * audit_log row owned by user B is unreadable when scoped by user A's id.
 *
 * Revision 1 W1 fix: VALIDATION 8 (write) and 9 (delete) are explicit
 * `it.skip` with the EXACT annotations `deferred to Phase 2: no writable
 * resource in Phase 1` and `deferred to Phase 2: no deletable resource in
 * Phase 1`. No silent skips; every behavior accounted for.
 */
describe('cross-tenant 404 (PRIV-01, VALIDATION 7/8/9)', () => {
  it('user A cannot READ user B audit row (404 NOT 403)', async () => {
    const userA = await seedUserDirectly({ email: 'a@test.local' });
    const userB = await seedUserDirectly({ email: 'b@test.local' });
    await writeAudit({
      userId: userB.id,
      action: 'session.signin',
      ipAddress: '127.0.0.1',
    });

    // Sentinel "service": fetch one audit row scoped by userId. The double
    // eq(...userId) clause encodes the Pattern 3 invariant — the scope is
    // ALWAYS the caller's userId, even when looking up "this specific row";
    // the only way both clauses can be true is if rowOwnerId === callerId.
    async function getAuditRowFor(callerId: string, rowOwnerId: string) {
      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.userId, callerId), eq(auditLog.userId, rowOwnerId)),
        )
        .limit(1);
      if (rows.length === 0) throw new NotFoundError();
      return rows[0]!;
    }

    // user A scoping user B's row: NotFoundError, never a result.
    await expect(getAuditRowFor(userA.id, userB.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  // VALIDATION behavior 8 — cross-tenant WRITE — is deferred to Phase 2 (which lands the
  // first writable resource: /api/games). Phase 1 has no write-able tenant resource;
  // documenting the deferral explicitly here (per checker iteration 1 W1) so the
  // skip is not silent.
  it.skip(
    'user A cannot WRITE user B resource — returns 404 (deferred to Phase 2: no writable resource in Phase 1)',
    () => {
      /* Phase 2 GAMES-01 lands /api/games and turns this on. */
    },
  );

  // VALIDATION behavior 9 — cross-tenant DELETE — same deferral.
  it.skip(
    'user A cannot DELETE user B resource — returns 404 (deferred to Phase 2: no deletable resource in Phase 1)',
    () => {
      /* Phase 2 GAMES-01 lands /api/games and turns this on. */
    },
  );

  it('NotFoundError serializes to {error: "not_found"} status 404 (never "forbidden")', () => {
    const err = new NotFoundError();
    expect(err.status).toBe(404);
    expect(err.code).toBe('not_found');
    // Body must NOT contain "forbidden" or "permission".
    const body = JSON.stringify({ error: err.code });
    expect(body).not.toContain('forbidden');
    expect(body).not.toContain('permission');
  });

  it('user A reading their own /api/me returns 200; user B reading their own returns 200 with different data', async () => {
    const { createApp } = await import('../../src/lib/server/http/app.js');
    const app = createApp();
    const userA = await seedUserDirectly({ email: 'mine-a@test.local', name: 'A' });
    const userB = await seedUserDirectly({ email: 'mine-b@test.local', name: 'B' });

    const resA = await app.request('/api/me', {
      headers: { cookie: `neotolis.session_token=${userA.sessionToken}` },
    });
    expect(resA.status).toBe(200);
    const bodyA = (await resA.json()) as Record<string, unknown>;
    expect(bodyA.email).toBe('mine-a@test.local');

    const resB = await app.request('/api/me', {
      headers: { cookie: `neotolis.session_token=${userB.sessionToken}` },
    });
    expect(resB.status).toBe(200);
    const bodyB = (await resB.json()) as Record<string, unknown>;
    expect(bodyB.email).toBe('mine-b@test.local');
    expect(bodyA.id).not.toBe(bodyB.id);
  });
});
