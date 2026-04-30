---
phase: 02-ingest-secrets-and-audit
plan: 07
type: execute
wave: 1
depends_on: [02-03-schema-and-migration]
files_modified:
  - src/lib/server/services/audit-read.ts
  - src/lib/server/dto.ts
  - tests/unit/audit-cursor.test.ts
  - tests/unit/audit-append-only.test.ts
  - tests/integration/audit.test.ts
autonomous: true
requirements: [PRIV-02, KEYS-06]
requirements_addressed: [PRIV-02, KEYS-06]
must_haves:
  truths:
    - "listAuditPage(userId, cursor, action) returns 50 rows max + nextCursor; ordered by (created_at desc, id desc)"
    - "Cursor is base64url(JSON.stringify({at: ISO, id})); WHERE clause uses tuple-comparison `(created_at, id) < ($1, $2)` constrained by userId always"
    - "Cross-tenant: user A's cursor presented by user B never returns user A's rows (PITFALL P19 mitigated by construction — userId filter is independent of cursor)"
    - "actionFilter='all' returns all actions; actionFilter='key.add' filters to that single action; actions outside AUDIT_ACTIONS are rejected at the route boundary (Plan 08 zod validation)"
    - "audit-append-only invariant: src/lib/server/audit.ts module exports `writeAudit` and NOTHING else (no update / delete path); test asserts via Object.keys on the imported module"
  artifacts:
    - path: "src/lib/server/services/audit-read.ts"
      provides: "listAuditPage (cursor pagination) + encodeCursor / decodeCursor helpers"
      contains: "listAuditPage"
      min_lines: 60
    - path: "src/lib/server/dto.ts"
      provides: "toAuditEntryDto + AuditEntryDto"
      contains: "toAuditEntryDto"
  key_links:
    - from: "src/lib/server/services/audit-read.ts"
      to: "src/lib/server/db/schema/audit-log.ts"
      via: "Drizzle SELECT scoped by eq(auditLog.userId, userId) AND tuple comparison"
      pattern: "auditLog\\.userId, userId"
    - from: "tests/integration/audit.test.ts"
      to: "src/lib/server/services/audit-read.ts"
      via: "Tenant-relative cursor cross-tenant assertion"
      pattern: "listAuditPage"
---

<objective>
Land the audit-log READ surface (PRIV-02). Phase 1 already shipped the WRITE side (`src/lib/server/audit.ts`, `audit_log` schema). Phase 2 adds: the read service with tuple-comparison cursor pagination, the action filter (using the const `AUDIT_ACTIONS` list from Plan 03), the DTO projection, and the cross-tenant cursor invariant test (PITFALL P19).

Purpose: This is the first user-visible read of the audit log. Get the cursor format and the WHERE clause right; the cross-tenant test asserts that a cursor extracted by user A and presented by user B yields zero of user A's rows. The append-only invariant (from Phase 1 — audit.ts has no update/delete path) gets a behavioural unit test here so future drift is caught.

Output: 1 new service file (audit-read.ts), DTO addition, live test bodies for `tests/unit/audit-cursor.test.ts`, `tests/unit/audit-append-only.test.ts`, and the remaining 4 stubs in `tests/integration/audit.test.ts` (Plan 05 already lit up the IP-resolution stub).
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/lib/server/audit.ts
@src/lib/server/db/schema/audit-log.ts
@src/lib/server/audit/actions.ts
@src/lib/server/dto.ts
@.planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md
@.planning/phases/02-ingest-secrets-and-audit/02-CONTEXT.md
@.planning/phases/02-ingest-secrets-and-audit/02-03-SUMMARY.md

<interfaces>
<!-- Cursor pagination contract (D-31; verbatim RESEARCH.md §"Cursor pagination" lines 583–645):

PAGE_SIZE = 50 (D-31; P6 makes tunable)

Cursor format: base64url(JSON.stringify({ at: createdAt.toISOString(), id }))

WHERE clause: `(audit_log.created_at, audit_log.id) < ($cursorAt, $cursorId)` AND
              `audit_log.user_id = $callerId` AND
              [optional] `audit_log.action = $actionFilter`

ORDER BY: created_at DESC, id DESC

LIMIT: PAGE_SIZE + 1 (one extra row to detect "has more")

Tenant-relative by construction: userId filter is INDEPENDENT of cursor — even
if attacker submits a forged cursor encoding another tenant's (created_at, id),
the userId WHERE clause filters to caller's rows only. PITFALL P19 mitigated
not by cursor opacity but by query structure.
-->

<!-- AUDIT_ACTIONS const list from Plan 03 (single source of truth):
['session.signin', 'session.signout', 'session.signout_all', 'user.signup',
 'key.add', 'key.rotate', 'key.remove',
 'game.created', 'game.deleted', 'game.restored',
 'item.created', 'item.deleted',
 'event.created', 'event.edited', 'event.deleted',
 'theme.changed']
The action filter at the route boundary (Plan 08) validates inputs against
['all', ...AUDIT_ACTIONS].
-->
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Implement audit-read.ts + DTO + cursor helpers</name>
  <files>src/lib/server/services/audit-read.ts, src/lib/server/dto.ts</files>
  <read_first>
    - src/lib/server/db/schema/audit-log.ts (Plan 03 — auditLog pgTable; action is now `auditActionEnum` typed; (user_id, created_at) and (user_id, action, created_at) indexes exist for the two query shapes)
    - src/lib/server/audit/actions.ts (Plan 03 — AUDIT_ACTIONS const list)
    - .planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md §"Cursor pagination for /api/audit" lines 583–645 (encodeCursor + decodeCursor + listAuditPage verbatim)
    - .planning/phases/02-ingest-secrets-and-audit/02-CONTEXT.md `<decisions>` D-31, D-32, D-34
  </read_first>
  <action>
    **A. Create `src/lib/server/services/audit-read.ts`** — verbatim from RESEARCH.md §"Cursor pagination" lines 596–645, with these adaptations:
    - Import `auditLog` from `../db/schema/audit-log.js`.
    - Import `db` from `../db/client.js`.
    - PAGE_SIZE = 50 const.
    - Validate `actionFilter` parameter: must be either `'all'` or a member of `AUDIT_ACTIONS`. If neither, throw `AppError code='validation_failed' status=422`. Plan 08's route layer also validates via zod, so this is defense-in-depth.

    Final exports:
    ```typescript
    export const PAGE_SIZE = 50;

    export interface AuditPage {
      rows: AuditEntryRow[];   // raw rows; route handler maps via toAuditEntryDto
      nextCursor: string | null;
    }

    export type AuditActionFilter = "all" | (typeof AUDIT_ACTIONS)[number];

    export function encodeCursor(at: Date, id: string): string;
    export function decodeCursor(s: string): { at: Date; id: string };

    export async function listAuditPage(
      userId: string,
      cursor: string | null,
      actionFilter: AuditActionFilter = "all",
    ): Promise<AuditPage>;
    ```

    Cursor implementation (verbatim from RESEARCH.md):
    ```typescript
    function encodeCursor(at: Date, id: string): string {
      return Buffer.from(JSON.stringify({ at: at.toISOString(), id })).toString("base64url");
    }
    function decodeCursor(s: string): { at: Date; id: string } {
      try {
        const parsed = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
        if (typeof parsed?.at !== "string" || typeof parsed?.id !== "string") {
          throw new AppError("invalid cursor", "invalid_cursor", 422);
        }
        return { at: new Date(parsed.at), id: parsed.id };
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError("invalid cursor", "invalid_cursor", 422);
      }
    }
    ```

    listAuditPage WHERE clause (the load-bearing piece):
    ```typescript
    const cursorClause = cursor
      ? sql`(${auditLog.createdAt}, ${auditLog.id}) < (${decodeCursor(cursor).at}, ${decodeCursor(cursor).id})`
      : sql`true`;
    const filterClause = actionFilter === "all"
      ? sql`true`
      : eq(auditLog.action, actionFilter);

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userId), cursorClause, filterClause))   // userId ALWAYS first
      .orderBy(sql`${auditLog.createdAt} desc, ${auditLog.id} desc`)
      .limit(PAGE_SIZE + 1);

    const hasMore = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);
    const last = page[page.length - 1];
    return {
      rows: page,
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    };
    ```

    Optimisation: decode the cursor ONCE outside the SQL builder, not twice as in the RESEARCH.md snippet — cleaner code:
    ```typescript
    let parsedCursor: { at: Date; id: string } | null = null;
    if (cursor) parsedCursor = decodeCursor(cursor);
    const cursorClause = parsedCursor
      ? sql`(${auditLog.createdAt}, ${auditLog.id}) < (${parsedCursor.at}, ${parsedCursor.id})`
      : sql`true`;
    ```

    **B. AMEND `src/lib/server/dto.ts`** — append `toAuditEntryDto`:
    ```typescript
    import type { auditLog } from "./db/schema/audit-log.js";
    type AuditEntryRow = typeof auditLog.$inferSelect;

    export interface AuditEntryDto {
      id: string;
      action: string;
      ipAddress: string;
      userAgent: string | null;
      metadata: unknown;       // jsonb; D-34 shape for key.* events; consumer renders the chip
      createdAt: Date;
    }
    export function toAuditEntryDto(r: AuditEntryRow): AuditEntryDto {
      return {
        id: r.id,
        action: r.action,
        ipAddress: r.ipAddress,
        userAgent: r.userAgent,
        metadata: r.metadata,
        createdAt: r.createdAt,
      };
    }
    ```

    Cross-cutting: the DTO does NOT include `userId` — caller knows their own id (P3 discipline).
  </action>
  <verify>
    <automated>pnpm exec tsc --noEmit 2>&1 | tail -10 && pnpm exec eslint src/lib/server/services/audit-read.ts 2>&1 | tail -10</automated>
  </verify>
  <done>
    `src/lib/server/services/audit-read.ts` compiles and lints clean (zero tenant-scope violations — userId is the first WHERE clause). `toAuditEntryDto` exists in dto.ts. Cursor encode/decode round-trips for non-zero ms timestamps. `actionFilter` is type-safe via union with AUDIT_ACTIONS members.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Cursor unit tests + audit append-only behavioural test + audit.test.ts integration tests</name>
  <files>tests/unit/audit-cursor.test.ts, tests/unit/audit-append-only.test.ts, tests/integration/audit.test.ts</files>
  <read_first>
    - tests/unit/audit-cursor.test.ts (placeholder file from Plan 02-01 — has 2 it.skip stubs)
    - tests/unit/audit-append-only.test.ts (placeholder file from Plan 02-01 — has 2 it.skip stubs)
    - tests/integration/audit.test.ts (Plan 05 lit up `02-05: KEYS-06 ip resolved via proxy-trust`; this plan flips the remaining 4 stubs starting with `02-07:`)
    - src/lib/server/audit.ts (the writeAudit-only module — append-only invariant assertion)
    - src/lib/server/services/audit-read.ts (Task 1 output)
    - tests/integration/helpers.ts (seedUserDirectly)
  </read_first>
  <action>
    **A. `tests/unit/audit-cursor.test.ts` — flip 2 it.skip stubs:**

    ```typescript
    import { describe, it, expect } from "vitest";
    import { encodeCursor, decodeCursor } from "../../src/lib/server/services/audit-read.js";
    import { AppError } from "../../src/lib/server/services/errors.js";

    describe("audit cursor encode/decode", () => {
      it("02-07: encodeCursor + decodeCursor round-trip", () => {
        const at = new Date("2026-04-27T18:30:00.123Z");
        const id = "01923456-7890-7abc-def0-123456789012";
        const c = encodeCursor(at, id);
        const decoded = decodeCursor(c);
        expect(decoded.at.toISOString()).toBe(at.toISOString());
        expect(decoded.id).toBe(id);
      });

      it("02-07: cursor decode rejects malformed input", () => {
        expect(() => decodeCursor("not-base64!@#$")).toThrow(AppError);
        expect(() => decodeCursor(Buffer.from("{}").toString("base64url"))).toThrow(AppError);
        expect(() => decodeCursor(Buffer.from('{"at":"x"}').toString("base64url"))).toThrow(AppError);
      });
    });
    ```

    **B. `tests/unit/audit-append-only.test.ts` — flip 2 it.skip stubs:**

    ```typescript
    import { describe, it, expect } from "vitest";
    import * as auditModule from "../../src/lib/server/audit.js";

    describe("audit module export shape (P19)", () => {
      it("02-08: writeAudit module exports no update path", () => {
        // Even checking via wildcard import: no `update*` symbol exists.
        const keys = Object.keys(auditModule);
        for (const k of keys) {
          expect(k).not.toMatch(/^update/i);
          expect(k).not.toMatch(/setAction|setIp|amend|patch|edit/i);
        }
      });

      it("02-08: writeAudit module exports no delete path", () => {
        const keys = Object.keys(auditModule);
        for (const k of keys) {
          expect(k).not.toMatch(/^delete/i);
          expect(k).not.toMatch(/^purge/i);
          expect(k).not.toMatch(/^clear/i);
          expect(k).not.toMatch(/^remove/i);
        }
      });
    });
    ```

    Note: the `02-08:` annotation in audit-append-only is intentional — Plan 08 (routes) is when the cross-cutting append-only invariant becomes visible across the system. Plan 02-07 lights it up early because the test depends only on `audit.ts` (Phase 1) — no need to wait.

    **C. `tests/integration/audit.test.ts` — flip 4 remaining stubs (Plan 05 already lit up `02-05: KEYS-06 ip resolved via proxy-trust`):**

    ```typescript
    import { describe, it, expect, vi, afterEach } from "vitest";
    import { eq } from "drizzle-orm";
    import { listAuditPage, encodeCursor } from "../../src/lib/server/services/audit-read.js";
    import { writeAudit } from "../../src/lib/server/audit.js";
    import { db } from "../../src/lib/server/db/client.js";
    import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
    import { seedUserDirectly } from "./helpers.js";

    describe("audit log read endpoint (PRIV-02 + KEYS-06 metadata)", () => {
      it("02-07: PRIV-02 page size 50 + cursor", async () => {
        const u = await seedUserDirectly({ email: "ap1@test.local" });
        // seed 60 audit rows
        for (let i = 0; i < 60; i++) {
          await writeAudit({ userId: u.id, action: "session.signin", ipAddress: `10.0.0.${i % 250 + 1}` });
        }
        const page1 = await listAuditPage(u.id, null, "all");
        expect(page1.rows.length).toBe(50);
        expect(page1.nextCursor).toBeTruthy();
        const page2 = await listAuditPage(u.id, page1.nextCursor!, "all");
        expect(page2.rows.length).toBe(10);
        expect(page2.nextCursor).toBeNull();
        // No row appears in both pages
        const ids1 = new Set(page1.rows.map((r) => r.id));
        for (const r of page2.rows) expect(ids1.has(r.id)).toBe(false);
      });

      it("02-07: PRIV-02 action filter", async () => {
        const u = await seedUserDirectly({ email: "ap2@test.local" });
        await writeAudit({ userId: u.id, action: "session.signin", ipAddress: "10.0.0.1" });
        await writeAudit({ userId: u.id, action: "key.add", ipAddress: "10.0.0.1" });
        await writeAudit({ userId: u.id, action: "key.rotate", ipAddress: "10.0.0.1" });
        const all = await listAuditPage(u.id, null, "all");
        expect(all.rows.length).toBe(3);
        const keyAdds = await listAuditPage(u.id, null, "key.add");
        expect(keyAdds.rows.length).toBe(1);
        expect(keyAdds.rows[0]!.action).toBe("key.add");
      });

      it("02-07: PRIV-02 tenant-relative cursor (cross-tenant rejection)", async () => {
        // Seed rows for user A; capture a cursor; present it as user B; expect zero of A's rows.
        const userA = await seedUserDirectly({ email: "tcA@test.local" });
        const userB = await seedUserDirectly({ email: "tcB@test.local" });
        for (let i = 0; i < 5; i++) {
          await writeAudit({ userId: userA.id, action: "session.signin", ipAddress: "10.0.0.1" });
        }
        const aPage = await listAuditPage(userA.id, null, "all");
        expect(aPage.rows.length).toBe(5);
        // Force a cursor pointing at A's row 5
        const aCursor = encodeCursor(aPage.rows[2]!.createdAt, aPage.rows[2]!.id);
        // Now query as user B with that cursor — expect ZERO rows AND no observation of A's IDs.
        const bPage = await listAuditPage(userB.id, aCursor, "all");
        expect(bPage.rows.length).toBe(0);
        expect(bPage.nextCursor).toBeNull();
        for (const r of bPage.rows) {
          expect(r.id).not.toMatch(/^/); // any A id; but rows.length is 0 so vacuous
        }
        // Also assert direct query as user B sees only B's rows (B has none seeded — should be 0)
        const bAll = await listAuditPage(userB.id, null, "all");
        expect(bAll.rows.length).toBe(0);
      });
    });
    ```

    The cross-tenant test is the LOAD-BEARING assertion of PITFALL P19: even with a forged cursor encoding user A's row coordinates, the userId filter in the WHERE clause guarantees user B sees nothing.

    Cross-cutting: Plan 05 already added the `02-05: KEYS-06 ip resolved via proxy-trust` describe block. Plan 07's tests live in their OWN describe block (`PRIV-02`) so the file has two describes. Don't merge them.
  </action>
  <verify>
    <automated>pnpm test:unit tests/unit/audit-cursor.test.ts tests/unit/audit-append-only.test.ts --reporter=verbose 2>&1 | tail -10 && pnpm test:integration tests/integration/audit.test.ts --reporter=verbose 2>&1 | tail -20</automated>
  </verify>
  <done>
    - 2 cursor stubs + 2 append-only stubs + 3 PRIV-02 stubs in audit.test.ts (in addition to Plan 05's 1 stub) all pass.
    - The tenant-relative cursor test demonstrates that user B presenting user A's cursor returns 0 rows.
    - The append-only test catches any future Phase that adds an `updateAudit` / `deleteAudit` / `purgeAudit` export.
  </done>
</task>

</tasks>

<verification>
- `pnpm exec eslint src/lib/server/services/audit-read.ts` exits 0.
- `pnpm test:unit tests/unit/audit-cursor.test.ts tests/unit/audit-append-only.test.ts` is green.
- `pnpm test:integration tests/integration/audit.test.ts` is green (with both Plan 05 and Plan 07 describe blocks).
- `grep -c "auditLog.userId, userId" src/lib/server/services/audit-read.ts` >= 1 (the userId filter is FIRST in `and(...)`).
</verification>

<success_criteria>
- `listAuditPage` returns 50 rows max + `nextCursor` when more exist; tenant-filter is independent of cursor.
- Action filter accepts `all` or any AUDIT_ACTIONS value; rejects others (defense-in-depth — Plan 08's zod validation also covers).
- Cursor encode/decode round-trips losslessly; malformed cursor → AppError 422.
- Audit module export shape stays append-only — the unit test fails loudly if a future plan adds an update/delete export.
- Cross-tenant cursor test asserts P19 mitigation: forged cursor cannot leak across tenant boundary.
- 7 placeholder tests across 3 files all pass.
</success_criteria>

<output>
After completion, create `.planning/phases/02-ingest-secrets-and-audit/02-07-SUMMARY.md`. Highlight: cursor format chosen (base64url(JSON({at, id}))), confirmed PAGE_SIZE = 50, the cross-tenant test outcome, and that audit.ts module exports remain {writeAudit, AuditEntry} only.
</output>
