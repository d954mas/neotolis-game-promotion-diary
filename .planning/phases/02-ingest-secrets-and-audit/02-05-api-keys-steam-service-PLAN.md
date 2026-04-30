---
phase: 02-ingest-secrets-and-audit
plan: 05
type: execute
wave: 1
depends_on: [02-03-schema-and-migration]
files_modified:
  - src/lib/server/services/api-keys-steam.ts
  - src/lib/server/integrations/steam-api.ts
  - src/lib/server/dto.ts
  - tests/integration/secrets-steam.test.ts
  - tests/unit/dto.test.ts
autonomous: true
requirements: [KEYS-03, KEYS-04, KEYS-05, KEYS-06]
requirements_addressed: [KEYS-03, KEYS-04, KEYS-05, KEYS-06]
must_haves:
  truths:
    - "createSteamKey calls validateSteamKey BEFORE persist; 4xx → AppError code='validation_failed' status=422; 5xx → AppError code='steam_api_unavailable' status=502"
    - "Plaintext is encrypted via encryptSecret() and the EncryptedSecret tuple is persisted; plaintext lives only inside the function scope and is never logged"
    - "On successful insert, audit row written with action='key.add' and metadata={kind:'steam', key_id, label, last4}"
    - "rotateSteamKey overwrites all 7 ciphertext columns + bumps rotated_at; previous ciphertext is unrecoverable; audit action='key.rotate'"
    - "removeSteamKey audits 'key.remove' BEFORE the DELETE; FK cascade clears game_steam_listings.api_key_id (set null per Plan 03 schema)"
    - "toApiKeySteamDto returns ONLY {id, label, last4, createdAt, updatedAt, rotatedAt} — every ciphertext column and kek_version is stripped at the projection function"
    - "Behavioral DTO test asserts even if a row literal carries ciphertext columns, the projection output omits them"
  artifacts:
    - path: "src/lib/server/services/api-keys-steam.ts"
      provides: "createSteamKey, listSteamKeys, getSteamKeyById, rotateSteamKey, removeSteamKey, decryptSteamKeyForOperator (Phase 3 worker entry; Phase 2 only uses internally for D-17)"
      contains: "encryptSecret"
      min_lines: 100
    - path: "src/lib/server/integrations/steam-api.ts"
      provides: "validateSteamKey added (Plan 04 already created this file with fetchSteamAppDetails)"
      contains: "validateSteamKey"
    - path: "src/lib/server/dto.ts"
      provides: "toApiKeySteamDto + ApiKeySteamDto interface"
      contains: "toApiKeySteamDto"
  key_links:
    - from: "src/lib/server/services/api-keys-steam.ts"
      to: "src/lib/server/crypto/envelope.ts"
      via: "encryptSecret(plaintext) on write; decryptSecret(row) only inside D-17 validation path"
      pattern: "encryptSecret"
    - from: "src/lib/server/services/api-keys-steam.ts"
      to: "src/lib/server/audit.ts"
      via: "writeAudit({action: 'key.add'|'key.rotate'|'key.remove', metadata: {kind:'steam', key_id, label, last4}})"
      pattern: "writeAudit\\(.*key\\."
    - from: "src/lib/server/services/api-keys-steam.ts"
      to: "src/lib/server/integrations/steam-api.ts"
      via: "validateSteamKey(plaintext) called BEFORE encryptSecret + persist"
      pattern: "validateSteamKey"
---
<!-- B-3 CARDINALITY DECISION: Phase 2 ships **multi-key UI** (Option (a) per checker B-3),
     honoring CONTEXT.md D-13 verbatim ("publisher with two Steamworks accounts; one row per
     labelled Steamworks account, linked per-listing"). The schema-level enforcement is the
     UNIQUE(user_id, label) index added in Plan 02-03; the service-layer pre-check is in
     `createSteamKey` below; the multi-row list UI is in Plan 02-10. Single-key UI (Option (b))
     was rejected because it would amend CONTEXT.md, which is out of scope for a checker
     revision iteration. -->



<objective>
Land the Steam API key service end-to-end: paste-time validation against `IWishlistService/GetWishlistItemCount/v1` (D-17), envelope encryption per the Phase 1 `crypto/envelope.ts` contract (D-12), one Replace form per user (D-14), audit on every write (KEYS-06 with metadata shape per D-34), and the strict DTO projection (KEYS-04). Also flip the secrets-steam.test.ts placeholder stubs to live tests, and extend `tests/unit/dto.test.ts` with the behavioural ciphertext-strip assertion.

Purpose: Steam is the typed-per-kind credential example (D-08) — the implementation here is the template Plan 03 of Phase 3 will copy for `api_keys_youtube` and `api_keys_reddit`. Get the audit metadata shape, the ciphertext-strip DTO, and the validation-then-persist order right; downstream phases inherit the pattern.

Output: 1 new service file, 1 amendment to `integrations/steam-api.ts` (adds `validateSteamKey`), 1 amendment to `dto.ts` (adds `toApiKeySteamDto`), live test bodies for `tests/integration/secrets-steam.test.ts` (5 stubs + audit IP-resolution stub from `audit.test.ts`), and the new behavioural ciphertext-strip test in `tests/unit/dto.test.ts`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/lib/server/crypto/envelope.ts
@src/lib/server/db/schema/api-keys-steam.ts
@src/lib/server/audit.ts
@src/lib/server/services/errors.ts
@src/lib/server/dto.ts
@src/lib/server/logger.ts
@src/lib/server/integrations/steam-api.ts
@.planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md
@.planning/phases/02-ingest-secrets-and-audit/02-CONTEXT.md
@.planning/phases/02-ingest-secrets-and-audit/02-04-SUMMARY.md

<interfaces>
<!-- Phase 1 envelope.ts contract (verified):
encryptSecret(plaintext: string): EncryptedSecret
  → { secretCt, secretIv, secretTag, wrappedDek, dekIv, dekTag, kekVersion }
decryptSecret(s: EncryptedSecret): string
rotateDek(s: EncryptedSecret, newKekVersion: number): EncryptedSecret

The plaintext input to encryptSecret cannot be wiped (V8 strings are immutable);
function-scope variable is the only durable mitigation. Pino redact (D-24)
handles the field-name layer.
-->

<!-- D-17 Steam validation endpoint (RESEARCH.md §"7. Steam appdetails fetch" lines 1319–1338, function `validateSteamKey`):
GET https://api.steampowered.com/IWishlistService/GetWishlistItemCount/v1/?key=<plaintext>&steamid=0
- 2xx → key works (regardless of count for steamid=0)
- 4xx → key invalid (return false)
- 5xx → throw 'steam_api_5xx' (caller translates to 502; Pitfall 9)
5s AbortController timeout.
-->

<!-- D-34 audit metadata shape (verbatim):
{ kind: 'steam' | 'youtube' | 'reddit', key_id: uuid, label: string, last4: string }
last4 is NOT a secret (already shown in masked UI). Including it in audit
metadata is the explicit forensics path. Pino redact does not match `last4`.
-->

<!-- Plan 04 already created src/lib/server/integrations/steam-api.ts with `fetchSteamAppDetails`.
This plan AMENDS that file to add `validateSteamKey`. Do not re-create the file.
-->
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Implement api-keys-steam service + validateSteamKey + DTO projection</name>
  <files>src/lib/server/services/api-keys-steam.ts, src/lib/server/integrations/steam-api.ts, src/lib/server/dto.ts</files>
  <read_first>
    - src/lib/server/crypto/envelope.ts (encryptSecret + EncryptedSecret + decryptSecret + rotateDek; the function signatures Plan 05 calls verbatim)
    - src/lib/server/db/schema/api-keys-steam.ts (Plan 03 output — column names: secretCt, secretIv, secretTag, wrappedDek, dekIv, dekTag, kekVersion, label, last4, rotatedAt)
    - src/lib/server/audit.ts (writeAudit signature; AuditEntry shape — note: writeAudit's `action` was `string` in Phase 1 but Plan 03 retyped audit_log.action to enum, so callers should pass an `AuditAction` value from `src/lib/server/audit/actions.ts`)
    - src/lib/server/integrations/steam-api.ts (Plan 04 output — has `fetchSteamAppDetails`; this plan adds `validateSteamKey` to the same file)
    - src/lib/server/dto.ts (Phase 1 + Plan 04 amendments — append toApiKeySteamDto here)
    - .planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md §"3. Service: api-keys-steam create" lines 1065–1137 (the createSteamKey + rotateSteamKey verbatim implementation) and §"4. DTO projection" lines 1139–1167 (toApiKeySteamDto verbatim) and §"7. Steam appdetails fetch" lines 1319–1338 (validateSteamKey verbatim)
    - .planning/phases/02-ingest-secrets-and-audit/02-CONTEXT.md `<decisions>` D-12, D-14, D-15, D-17, D-34, D-39 (the full secrets contract)
  </read_first>
  <action>
    **A. AMEND `src/lib/server/integrations/steam-api.ts`** — add the `validateSteamKey` export (do NOT touch the existing `fetchSteamAppDetails` function from Plan 04):

    ```typescript
    /**
     * D-17 Steam Web API key paste-time validation.
     *
     * One test call to IWishlistService/GetWishlistItemCount/v1/?key=...&steamid=0.
     * steamid=0 is a sentinel — Valve accepts the call shape and returns 4xx if
     * the key is invalid (auth error). 2xx means the key works.
     *
     * Distinguishes 4xx (invalid key — caller returns 422 to the user) vs 5xx
     * (transient — caller returns 502 with retry hint per Pitfall 9). Throws
     * an Error with message 'steam_api_5xx' on 5xx so the service-layer try
     * block can map to 502; returns boolean for 2xx vs 4xx.
     */
    export async function validateSteamKey(plaintext: string): Promise<boolean> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(
          `https://api.steampowered.com/IWishlistService/GetWishlistItemCount/v1/?key=${encodeURIComponent(plaintext)}&steamid=0`,
          {
            signal: ctrl.signal,
            headers: { "user-agent": "neotolis-game-promotion-diary/0.1" },
          },
        );
        if (res.status >= 500) {
          throw new Error("steam_api_5xx");
        }
        return res.ok;   // 2xx → true; 4xx → false
      } finally {
        clearTimeout(timer);
      }
    }
    ```

    **B. Create `src/lib/server/services/api-keys-steam.ts`** with these exports. Every function takes `userId: string` first; every db query filters by `eq(apiKeysSteam.userId, userId)`.

    Export shape:
    ```typescript
    export interface CreateSteamKeyInput { label: string; plaintext: string; }
    export async function createSteamKey(userId: string, input: CreateSteamKeyInput, ipAddress: string): Promise<ApiKeySteamRow>;
    export async function listSteamKeys(userId: string): Promise<ApiKeySteamRow[]>;
    export async function getSteamKeyById(userId: string, keyId: string): Promise<ApiKeySteamRow>;   // throws NotFoundError
    export interface RotateSteamKeyInput { plaintext: string; }
    export async function rotateSteamKey(userId: string, keyId: string, input: RotateSteamKeyInput, ipAddress: string): Promise<ApiKeySteamRow>;
    export async function removeSteamKey(userId: string, keyId: string, ipAddress: string): Promise<void>;
    // Internal use only — DO NOT expose to a HTTP route. Phase 2 only uses this in tests; Phase 3 worker calls it per job.
    export async function decryptSteamKeyForOperator(userId: string, keyId: string): Promise<string>;
    ```

    Implementation rules (CRITICAL — RESEARCH.md §3 lines 1065–1137 is the verbatim template):

    1. `createSteamKey`: validate `input.label.length >= 1 && input.label.length <= 100` and `input.plaintext.length >= 1` (zod inline OR manual). If invalid, throw AppError code='validation_failed' status=422 BEFORE any external call.
       - **D-13 / B-3 label-collision pre-check (multi-key UI):** SELECT 1 from apiKeysSteam WHERE `userId = $1 AND label = $2 LIMIT 1`. If a row exists, throw `new AppError('a key with this label already exists', 'steam_key_label_exists', 422)` BEFORE the Steam API call. The DB-level UNIQUE(user_id, label) (Plan 02-03) is the load-bearing safety net; this app-level check exists so the user gets a clean Paraglide-keyed error message instead of a Postgres unique-violation 23505. The Plan 02-08 route layer maps `steam_key_label_exists` → 422 with `{error: 'steam_key_label_exists'}`.
       - Call `await validateSteamKey(input.plaintext)`. Wrap in try/catch:
         - On `Error` with message 'steam_api_5xx', throw `new AppError('steam api unavailable', 'steam_api_unavailable', 502)`.
         - On any other thrown Error (network / abort), let it propagate; the route layer maps to 500.
         - On `false` return, throw `new AppError('invalid steam key', 'validation_failed', 422)`.
         - On `true` return, proceed.
       - `const enc = encryptSecret(input.plaintext);`
       - `const last4 = input.plaintext.slice(-4);`
       - INSERT into apiKeysSteam: `userId, label, last4, ...enc-fields-explicitly-spread` (use the EncryptedSecret fields one by one, NOT `...enc` — explicit field listing keeps the schema-DTO mapping reviewable).
       - `RETURNING { id, label, last4, createdAt, updatedAt, rotatedAt }` (the DTO-shaped fields ONLY — never select the ciphertext columns into the in-process variable used for the response).
       - `await writeAudit({ userId, action: 'key.add', ipAddress, metadata: { kind: 'steam', key_id: row.id, label: row.label, last4 } });`
       - Return the inserted row (already DTO-shaped).

    2. `rotateSteamKey`: same validation order. After validation passes:
       - `encryptSecret(input.plaintext)` → fresh enc tuple (D-14: previous ciphertext is overwritten — there is no rotateDek call here because the user supplied a NEW plaintext, not just a KEK rotation).
       - UPDATE apiKeysSteam SET secretCt, secretIv, secretTag, wrappedDek, dekIv, dekTag, kekVersion, last4, rotatedAt = now(), updatedAt = now() WHERE userId = $1 AND id = $2 RETURNING { id, label, last4, ... }.
       - If RETURNING is empty (cross-tenant or non-existent), throw NotFoundError.
       - `await writeAudit({ action: 'key.rotate', metadata: { kind:'steam', key_id, label, last4 } })`.

    3. `removeSteamKey`: AUDIT FIRST (so even if DELETE fails for any reason, the attempt is logged), then DELETE. Order:
       - SELECT label, last4 from apiKeysSteam scoped by userId+id; if 0 rows, throw NotFoundError.
       - `await writeAudit({ action: 'key.remove', metadata: { kind:'steam', key_id, label, last4 } });`
       - `db.delete(apiKeysSteam).where(and(eq(apiKeysSteam.userId, userId), eq(apiKeysSteam.id, keyId)))`. Postgres FK `game_steam_listings.api_key_id ON DELETE SET NULL` will null-out the FK on any listings that referenced this key — that's a deliberate D-13 choice (listings persist; only the key linkage is severed).

    4. `decryptSteamKeyForOperator`: SELECT scoped by userId+id; if 0 rows, throw NotFoundError; map row → EncryptedSecret tuple; `decryptSecret(s)` → string. **NEVER expose this via a Hono route.** Plan 06 ingest does NOT call it. Phase 3 worker is the only caller; Phase 2 test exercises it once to prove envelope encryption + decryption round-trip.

    **C. AMEND `src/lib/server/dto.ts`** — append `toApiKeySteamDto` (verbatim from RESEARCH.md §4 lines 1139–1167):

    ```typescript
    import type { apiKeysSteam } from "./db/schema/api-keys-steam.js";
    type ApiKeySteamRow = typeof apiKeysSteam.$inferSelect;

    export interface ApiKeySteamDto {
      id: string;
      label: string;
      last4: string;
      createdAt: Date;
      updatedAt: Date;
      rotatedAt: Date | null;
    }

    /**
     * D-39 / PITFALL P3 — strip every ciphertext column AND kek_version.
     * Runtime guard: TypeScript erases types at runtime; the projection function
     * is the actual barrier. tests/unit/dto.test.ts asserts the strip happens
     * even when a row literal carries the ciphertext columns.
     */
    export function toApiKeySteamDto(r: ApiKeySteamRow): ApiKeySteamDto {
      return {
        id: r.id,
        label: r.label,
        last4: r.last4,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        rotatedAt: r.rotatedAt,
      };
    }
    ```

    Cross-cutting: the service file MUST import `AUDIT_ACTIONS` type or the `auditActionEnum` from `src/lib/server/audit/actions.ts` so passing `'key.add'` etc. through `writeAudit` is type-checked.
  </action>
  <verify>
    <automated>pnpm exec tsc --noEmit 2>&1 | tail -10 && pnpm exec eslint src/lib/server/services/api-keys-steam.ts 2>&1 | tail -10 && grep -E "(encryptSecret|validateSteamKey|writeAudit|key\\.(add|rotate|remove))" src/lib/server/services/api-keys-steam.ts | wc -l</automated>
  </verify>
  <done>
    - `src/lib/server/services/api-keys-steam.ts` compiles; ESLint reports zero violations of `tenant-scope/no-unfiltered-tenant-query` (every query has `eq(apiKeysSteam.userId, userId)`).
    - `validateSteamKey` is exported from `src/lib/server/integrations/steam-api.ts` alongside the existing `fetchSteamAppDetails`.
    - `toApiKeySteamDto` exists in `src/lib/server/dto.ts` and produces ONLY `{id, label, last4, createdAt, updatedAt, rotatedAt}`.
    - Service grep finds: encryptSecret (≥1), validateSteamKey (≥2 — create + rotate), writeAudit (≥3 — add/rotate/remove), key.add (1), key.rotate (1), key.remove (1).
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Flip secrets-steam.test.ts (5 stubs) + KEYS-06 audit-IP stub in audit.test.ts; extend dto.test.ts behavioural strip assertion</name>
  <files>tests/integration/secrets-steam.test.ts, tests/integration/audit.test.ts, tests/unit/dto.test.ts</files>
  <read_first>
    - tests/integration/secrets-steam.test.ts (placeholder file from Plan 02-01 — has 5 it.skip stubs)
    - tests/integration/audit.test.ts (placeholder file from Plan 02-01 — Plan 05 lights up the `02-05: KEYS-06 ip resolved via proxy-trust` stub; the other audit.test.ts stubs belong to Plan 07)
    - tests/unit/dto.test.ts (Phase 1 unit-test file — extend with one new describe / it for ciphertext-strip behavioural test per D-39)
    - tests/integration/helpers.ts (seedUserDirectly)
    - src/lib/server/services/api-keys-steam.ts (Task 1 output — functions under test)
    - src/lib/server/crypto/envelope.ts (encryptSecret signature; tests use this directly to construct a mock row literal carrying ciphertext)
    - .planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md §"Validation Architecture" lines 1446–1453 (the 5 KEYS test cases verbatim)
  </read_first>
  <behavior>
    **secrets-steam.test.ts (5 it.skip → it):**
    1. `02-05: KEYS-03 envelope encrypted at rest` — fetch must hit a stub of validateSteamKey returning true (mock the integration); call createSteamKey with a real-ish key 'STEAM-TEST-KEY-XYZW'; SELECT raw row from DB; expect `secret_ct.length > 0`, `secret_iv.length === 12`, `secret_tag.length === 16`, `wrapped_dek.length > 0`, `kek_version === 1`; assert plaintext 'STEAM-TEST-KEY-XYZW' does NOT appear in any column when stringified.
    2. `02-05: KEYS-04 DTO strips ciphertext` — call `toApiKeySteamDto(row)` directly; assert returned object has keys `['id', 'label', 'last4', 'createdAt', 'updatedAt', 'rotatedAt']` exactly (no `secretCt`, `wrappedDek`, etc.).
    3. `02-05: KEYS-05 rotate overwrites ciphertext + audits` — createSteamKey, capture ciphertext bytes; rotateSteamKey with a different plaintext; SELECT raw row; assert `secret_ct` bytes differ (Buffer.compare !== 0), `last4` changed, `rotatedAt !== null`; assert audit log has both `key.add` and `key.rotate` rows for this user.
    4. `02-05: KEYS-05 rotate fails on invalid key (422)` — mock validateSteamKey to return false; rotateSteamKey should throw `AppError code='validation_failed' status=422`; SELECT raw row; assert ciphertext is UNCHANGED from the pre-rotate snapshot (no half-write).
    5. `02-05: KEYS-06 audit metadata shape {kind, key_id, label, last4}` — createSteamKey 'KEY-1234'; SELECT the audit row with action='key.add'; assert `metadata.kind === 'steam'`, `metadata.key_id === row.id`, `metadata.label === 'My Test Key'`, `metadata.last4 === '1234'`.

    **audit.test.ts (1 stub from Plan 01):**
    - `02-05: KEYS-06 ip resolved via proxy-trust` — pass the resolved IP `203.0.113.7` (RFC 5737 test address) explicitly to createSteamKey; SELECT the audit row; assert `audit_log.ip_address === '203.0.113.7'` (NOT `127.0.0.1`).

    **dto.test.ts (NEW behavioural test):**
    - Construct a hand-built `ApiKeySteamRow`-shaped literal that includes random bytea-shaped Buffers for every ciphertext column, plus `id`, `label`, `last4`. Call `toApiKeySteamDto(literal)`. Assert `Object.keys(result).sort()` is `['createdAt', 'id', 'label', 'last4', 'rotatedAt', 'updatedAt']` and no ciphertext-shaped key appears in `JSON.stringify(result)`.
  </behavior>
  <action>
    **A. Mocking strategy for `validateSteamKey`** — Vitest's `vi.mock` against `src/lib/server/integrations/steam-api.ts` does NOT play well with ESM partial mocks; use `vi.spyOn(SteamApi, 'validateSteamKey')` after `await import` (Phase 1 helpers.ts uses the same pattern). Sketch:

    ```typescript
    import * as SteamApi from "../../src/lib/server/integrations/steam-api.js";

    const validateSpy = vi.spyOn(SteamApi, "validateSteamKey");
    afterEach(() => validateSpy.mockReset());
    ```

    For the 'returns true' tests: `validateSpy.mockResolvedValue(true)`. For 'rotate fails on invalid' (test 4): `validateSpy.mockResolvedValue(false)`.

    **B. Replace each `it.skip` from Plan 02-01 with `it`** in `tests/integration/secrets-steam.test.ts`:

    ```typescript
    import { describe, it, expect, vi, afterEach } from "vitest";
    import { and, eq } from "drizzle-orm";
    import { createSteamKey, rotateSteamKey, getSteamKeyById } from "../../src/lib/server/services/api-keys-steam.js";
    import { toApiKeySteamDto } from "../../src/lib/server/dto.js";
    import { db } from "../../src/lib/server/db/client.js";
    import { apiKeysSteam } from "../../src/lib/server/db/schema/api-keys-steam.js";
    import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
    import * as SteamApi from "../../src/lib/server/integrations/steam-api.js";
    import { AppError } from "../../src/lib/server/services/errors.js";
    import { seedUserDirectly } from "./helpers.js";

    describe("api_keys_steam envelope encryption (KEYS-03..06)", () => {
      const validateSpy = vi.spyOn(SteamApi, "validateSteamKey");
      afterEach(() => validateSpy.mockReset());

      it("02-05: KEYS-03 envelope encrypted at rest", async () => {
        validateSpy.mockResolvedValue(true);
        const userA = await seedUserDirectly({ email: "k1@test.local" });
        const PLAIN = "STEAM-TEST-KEY-ABCDEFGH-XYZW";
        const dto = await createSteamKey(userA.id, { label: "Studio A", plaintext: PLAIN }, "127.0.0.1");

        const [raw] = await db
          .select()
          .from(apiKeysSteam)
          .where(and(eq(apiKeysSteam.userId, userA.id), eq(apiKeysSteam.id, dto.id)))
          .limit(1);
        expect(raw).toBeDefined();
        expect(raw!.secretCt.length).toBeGreaterThan(0);
        expect(raw!.secretIv.length).toBe(12);
        expect(raw!.secretTag.length).toBe(16);
        expect(raw!.wrappedDek.length).toBeGreaterThan(0);
        expect(raw!.kekVersion).toBe(1);
        // Plaintext must not appear in any column when stringified.
        const json = JSON.stringify(raw, (_k, v) => (Buffer.isBuffer(v) ? v.toString("base64") : v));
        expect(json).not.toContain(PLAIN);
        // last4 = last 4 chars of plaintext
        expect(raw!.last4).toBe("XYZW");
      });

      it("02-05: KEYS-04 DTO strips ciphertext", async () => {
        validateSpy.mockResolvedValue(true);
        const userA = await seedUserDirectly({ email: "k2@test.local" });
        const dto = await createSteamKey(userA.id, { label: "K", plaintext: "1234567890ABCD" }, "127.0.0.1");
        // dto already DTO-shaped (RETURNING projection in service); also test toApiKeySteamDto on the raw row.
        const [raw] = await db.select().from(apiKeysSteam).where(eq(apiKeysSteam.userId, userA.id)).limit(1);
        const projected = toApiKeySteamDto(raw!);
        expect(Object.keys(projected).sort()).toEqual(
          ["createdAt", "id", "label", "last4", "rotatedAt", "updatedAt"].sort(),
        );
        expect(projected).not.toHaveProperty("secretCt");
        expect(projected).not.toHaveProperty("wrappedDek");
        expect(projected).not.toHaveProperty("kekVersion");
      });

      it("02-05: KEYS-05 rotate overwrites ciphertext + audits", async () => {
        validateSpy.mockResolvedValue(true);
        const userA = await seedUserDirectly({ email: "k3@test.local" });
        const PLAIN1 = "ORIGINAL-KEY-1111";
        const PLAIN2 = "ROTATED-KEY-9999";
        const created = await createSteamKey(userA.id, { label: "K3", plaintext: PLAIN1 }, "127.0.0.1");
        const [pre] = await db.select().from(apiKeysSteam).where(eq(apiKeysSteam.id, created.id)).limit(1);
        await rotateSteamKey(userA.id, created.id, { plaintext: PLAIN2 }, "127.0.0.1");
        const [post] = await db.select().from(apiKeysSteam).where(eq(apiKeysSteam.id, created.id)).limit(1);
        expect(Buffer.compare(pre!.secretCt, post!.secretCt)).not.toBe(0);
        expect(post!.last4).toBe("9999");
        expect(post!.rotatedAt).not.toBeNull();
        const audits = await db.select().from(auditLog).where(eq(auditLog.userId, userA.id));
        expect(audits.some((a) => a.action === "key.add")).toBe(true);
        expect(audits.some((a) => a.action === "key.rotate")).toBe(true);
      });

      it("02-05: KEYS-05 rotate fails on invalid key (422)", async () => {
        validateSpy.mockResolvedValueOnce(true);   // initial create
        const userA = await seedUserDirectly({ email: "k4@test.local" });
        const created = await createSteamKey(userA.id, { label: "K4", plaintext: "VALID-KEY-1111" }, "127.0.0.1");
        const [pre] = await db.select().from(apiKeysSteam).where(eq(apiKeysSteam.id, created.id)).limit(1);

        validateSpy.mockResolvedValueOnce(false);  // rotation rejects
        await expect(
          rotateSteamKey(userA.id, created.id, { plaintext: "BAD" }, "127.0.0.1"),
        ).rejects.toMatchObject({ status: 422, code: "validation_failed" });

        const [post] = await db.select().from(apiKeysSteam).where(eq(apiKeysSteam.id, created.id)).limit(1);
        expect(Buffer.compare(pre!.secretCt, post!.secretCt)).toBe(0);  // ciphertext UNCHANGED
        expect(post!.last4).toBe("1111");
      });

      it("02-05: KEYS-06 audit metadata shape {kind, key_id, label, last4}", async () => {
        validateSpy.mockResolvedValue(true);
        const userA = await seedUserDirectly({ email: "k5@test.local" });
        const created = await createSteamKey(userA.id, { label: "My Test Key", plaintext: "AAAA1234" }, "127.0.0.1");
        const [a] = await db.select().from(auditLog).where(and(eq(auditLog.userId, userA.id), eq(auditLog.action, "key.add"))).limit(1);
        expect(a).toBeDefined();
        expect(a!.metadata).toMatchObject({
          kind: "steam",
          key_id: created.id,
          label: "My Test Key",
          last4: "1234",
        });
      });
    });
    ```

    **C. Replace the `02-05: KEYS-06 ip resolved via proxy-trust` stub in tests/integration/audit.test.ts**:

    ```typescript
    it("02-05: KEYS-06 ip resolved via proxy-trust", async () => {
      validateSpy.mockResolvedValue(true);
      const userA = await seedUserDirectly({ email: "ip@test.local" });
      await createSteamKey(userA.id, { label: "K", plaintext: "ABCD1234" }, "203.0.113.7");
      const [a] = await db.select().from(auditLog).where(eq(auditLog.userId, userA.id)).limit(1);
      expect(a!.ipAddress).toBe("203.0.113.7");
    });
    ```

    Note: this test requires the spyOn pattern + the same imports as secrets-steam.test.ts. Add a fresh `describe('audit IP forwarding (KEYS-06)', () => { ... })` block in audit.test.ts and import what's needed; do not modify the other audit it.skip stubs (Plan 07 owns those).

    **D. AMEND `tests/unit/dto.test.ts`** — append a new describe block:

    ```typescript
    describe("toApiKeySteamDto strips ciphertext (D-39 behavioural)", () => {
      it("02-05: returns only DTO keys even when row literal carries ciphertext", () => {
        const fakeRow = {
          id: "test-id",
          userId: "should-NOT-leak",
          label: "K",
          last4: "WXYZ",
          secretCt: Buffer.from([1, 2, 3]),
          secretIv: Buffer.from([4, 5, 6]),
          secretTag: Buffer.from([7, 8, 9]),
          wrappedDek: Buffer.from([10, 11, 12]),
          dekIv: Buffer.from([13, 14, 15]),
          dekTag: Buffer.from([16, 17, 18]),
          kekVersion: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          rotatedAt: null,
        };
        // Cast required because the literal includes secret-shaped fields the
        // ApiKeySteamRow type erases; the cast is the test authoring move, not a
        // production pattern.
        const dto = toApiKeySteamDto(fakeRow as Parameters<typeof toApiKeySteamDto>[0]);
        const keys = Object.keys(dto).sort();
        expect(keys).toEqual(["createdAt", "id", "label", "last4", "rotatedAt", "updatedAt"]);
        const json = JSON.stringify(dto);
        expect(json).not.toMatch(/secret_ct|secretCt|wrapped_dek|wrappedDek|dek_iv|dekIv|kekVersion|kek_version|userId|user_id/);
      });
    });
    ```
  </action>
  <verify>
    <automated>pnpm test:integration tests/integration/secrets-steam.test.ts tests/integration/audit.test.ts --reporter=verbose 2>&1 | tail -30 && pnpm test:unit tests/unit/dto.test.ts --reporter=verbose 2>&1 | tail -10</automated>
  </verify>
  <done>
    - 5 stubs in secrets-steam.test.ts are now `it(...)` and pass; 1 stub in audit.test.ts (`02-05: KEYS-06 ip resolved via proxy-trust`) is `it(...)` and passes.
    - The new `toApiKeySteamDto` behavioural test in `tests/unit/dto.test.ts` passes.
    - No ciphertext field name appears in any test fixture's stringified output.
    - `validateSpy.mockReset()` runs in afterEach so tests don't leak mock state.
  </done>
</task>

</tasks>

<verification>
- `pnpm exec eslint src/lib/server/services/api-keys-steam.ts` exits 0.
- `pnpm test:integration tests/integration/secrets-steam.test.ts tests/integration/audit.test.ts` is green.
- `pnpm test:unit tests/unit/dto.test.ts` is green and the new behavioural test runs.
- `grep -E "(secret_ct|wrapped_dek|kek_version)" src/lib/server/dto.ts | grep -v -E "^//|/\\*|\\*"` returns ZERO non-comment matches in the projection function (D-39).
</verification>

<success_criteria>
- `createSteamKey` validates → encrypts → persists → audits in that order; 4xx Steam returns 422; 5xx Steam returns 502; cancel mid-flight does NOT half-write.
- `rotateSteamKey` overwrites all 7 ciphertext columns; on validation failure, ciphertext is unchanged; audit captures `key.rotate` only on success.
- `removeSteamKey` audits BEFORE delete; the FK `set null` cascade leaves listings intact.
- `toApiKeySteamDto` strips every secret-shaped field — verified at type-check (TS) AND at runtime (behavioural test in dto.test.ts).
- KEYS-06 audit metadata shape is exactly `{kind, key_id, label, last4}`; IP comes from the resolved `clientIp` (trusted-proxy middleware), not raw headers.
- 6 placeholder tests + 1 dto behavioural test all pass.
</success_criteria>

<output>
After completion, create `.planning/phases/02-ingest-secrets-and-audit/02-05-SUMMARY.md`. Highlight: which it.skip stubs flipped to it, the audit metadata shape verified across all three actions (add/rotate/remove), and confirmation that `decryptSteamKeyForOperator` is NOT exported from any HTTP route (Phase 3 worker is the only future caller).
</output>
