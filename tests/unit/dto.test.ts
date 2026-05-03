import { describe, it, expect } from "vitest";
import {
  toUserDto,
  toSessionDto,
  toApiKeySteamDto,
  toDataSourceDto,
  toEventDto,
} from "../../src/lib/server/dto.js";

// Plan 01-07 (Wave 4) — PITFALL P3 DTO discipline. Round-trip projection
// asserted to strip every secret-shaped field even when the input row
// carries them (defense-in-depth — schema-as-types alone is not sufficient,
// because TypeScript erases at runtime; the projection is the runtime guard).
describe("DTO discipline (PITFALL P3)", () => {
  it("toUserDto strips google_sub / accountId / passwords / verification", () => {
    const fakeUser = {
      id: "u-1",
      email: "a@b.test",
      name: "A",
      image: null,
      // Fields that MUST NOT appear in DTO:
      googleSub: "gsub-secret",
      refreshToken: "r-tok",
      accessToken: "a-tok",
      idToken: "i-tok",
      password: "should-not-exist",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Parameters<typeof toUserDto>[0];

    const dto = toUserDto(fakeUser);
    expect(dto).toEqual({ id: "u-1", email: "a@b.test", name: "A", image: null });
    expect(dto).not.toHaveProperty("googleSub");
    expect(dto).not.toHaveProperty("refreshToken");
    expect(dto).not.toHaveProperty("accessToken");
    expect(dto).not.toHaveProperty("idToken");
    expect(dto).not.toHaveProperty("password");
    expect(dto).not.toHaveProperty("emailVerified");
  });

  it("toSessionDto omits the session token (=cookie value)", () => {
    const fakeSession = {
      id: "s-1",
      userId: "u-1",
      token: "cookie-token-secret",
      expiresAt: new Date(),
      ipAddress: "1.2.3.4",
      userAgent: "test",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Parameters<typeof toSessionDto>[0];

    const dto = toSessionDto(fakeSession);
    expect(dto).not.toHaveProperty("token");
    expect(dto).not.toHaveProperty("userId");
  });
});

// Plan 02-05 (D-39 ciphertext discipline) — the DTO projection function is
// the load-bearing runtime guard for envelope-encrypted secret tables.
// TypeScript erases types at runtime; only the projection function decides
// what crosses the wire. This test asserts the strip happens behaviourally
// even when a row literal carries every ciphertext-shaped field. If a
// future contributor adds a ciphertext column to api_keys_steam without
// updating toApiKeySteamDto's explicit field listing, this test fails
// loudly instead of silently leaking the new column.
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
    // ApiKeySteamRow type erases; the cast is the test authoring move, not
    // a production pattern.
    const dto = toApiKeySteamDto(fakeRow as Parameters<typeof toApiKeySteamDto>[0]);

    const keys = Object.keys(dto).sort();
    expect(keys).toEqual(["createdAt", "id", "label", "last4", "rotatedAt", "updatedAt"]);

    // Stringify and assert NO ciphertext-shaped key name appears anywhere
    // — the field names themselves are the most reliable tripwire. A
    // future column rename that slips through TypeScript would fail here.
    const json = JSON.stringify(dto);
    expect(json).not.toMatch(
      /secret_ct|secretCt|secret_iv|secretIv|secret_tag|secretTag|wrapped_dek|wrappedDek|dek_iv|dekIv|dek_tag|dekTag|kekVersion|kek_version|userId|user_id/,
    );
  });
});

// Plan 02.1-04 (Phase 2.1 SOURCES-01) — DTO discipline for the unified
// `data_sources` table. The toDataSourceDto projection is the runtime guard
// for cross-tenant userId leakage on the new entity. Mirrors the api_keys_steam
// behavioural test pattern: a row literal with userId is fed in, and the
// output object MUST NOT contain `userId` even though it sat in the input.
describe("toDataSourceDto strips userId (P3 behavioural)", () => {
  it("02.1-04: strips userId at runtime even when the row carries it", () => {
    const fakeRow = {
      id: "src1",
      userId: "leak-target",
      kind: "youtube_channel" as const,
      handleUrl: "https://youtube.com/@me",
      channelId: "UC123",
      displayName: "My channel",
      isOwnedByMe: true,
      autoImport: true,
      metadata: { uploads_playlist_id: "PL123" },
      createdAt: new Date("2026-04-28T00:00:00Z"),
      updatedAt: new Date("2026-04-28T00:00:00Z"),
      deletedAt: null,
    };
    const dto = toDataSourceDto(fakeRow as Parameters<typeof toDataSourceDto>[0]);

    expect(Object.keys(dto)).not.toContain("userId");
    expect(dto.id).toBe("src1");
    expect(dto.kind).toBe("youtube_channel");
    expect(dto.handleUrl).toBe("https://youtube.com/@me");
    expect(dto.channelId).toBe("UC123");
    expect(dto.displayName).toBe("My channel");
    expect(dto.isOwnedByMe).toBe(true);
    expect(dto.autoImport).toBe(true);
    expect(dto.metadata).toEqual({ uploads_playlist_id: "PL123" });
    expect(dto.deletedAt).toBeNull();

    const json = JSON.stringify(dto);
    expect(json).not.toMatch(/userId|user_id|leak-target/);
  });

  it("02.1-04: preserves every documented DTO field across kinds + soft-deleted state", () => {
    const deletedAt = new Date("2026-04-28T01:00:00Z");
    const fakeRow = {
      id: "src2",
      userId: "should-not-leak",
      kind: "reddit_account" as const,
      handleUrl: "https://reddit.com/user/me",
      channelId: null,
      displayName: null,
      isOwnedByMe: false,
      autoImport: false,
      metadata: {},
      createdAt: new Date("2026-04-27T00:00:00Z"),
      updatedAt: new Date("2026-04-27T00:00:00Z"),
      deletedAt,
    };
    const dto = toDataSourceDto(fakeRow as Parameters<typeof toDataSourceDto>[0]);

    expect(Object.keys(dto).sort()).toEqual([
      "autoImport",
      "channelId",
      "createdAt",
      "deletedAt",
      "displayName",
      "handleUrl",
      "id",
      "isOwnedByMe",
      "kind",
      "metadata",
      "updatedAt",
    ]);
    expect(dto.deletedAt).toEqual(deletedAt);
    expect(dto.kind).toBe("reddit_account");
    expect(dto.channelId).toBeNull();
    expect(dto.displayName).toBeNull();
    expect(dto.isOwnedByMe).toBe(false);
    expect(dto.autoImport).toBe(false);
  });

  it("02.1-04: coerces null/undefined metadata to empty object", () => {
    const fakeRow = {
      id: "src3",
      userId: "u1",
      kind: "youtube_channel" as const,
      handleUrl: "https://youtube.com/@x",
      channelId: null,
      displayName: null,
      isOwnedByMe: true,
      autoImport: true,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    const dto = toDataSourceDto(fakeRow as Parameters<typeof toDataSourceDto>[0]);
    expect(dto.metadata).toEqual({});
  });
});

/**
 * Plan 02.1-28 (UAT-NOTES.md §4.24.G — M:N migration application layer) —
 * toEventDto behavioural test.
 *
 * The signature change (toEventDto now takes (event, gameIds: string[]))
 * is the load-bearing API change. The DTO discipline contract (P3 / D-39):
 * userId must be stripped at runtime even when a row literal carries it.
 * The legacy singular `gameId` field MUST NOT appear on the projected
 * output (it's not in the new EventDto interface).
 */
describe("Plan 02.1-28 — toEventDto with gameIds (P3 behavioural)", () => {
  it("Plan 02.1-28: gameIds is a defensive copy of the input array (caller cannot mutate the source)", () => {
    const gameIds = ["g1", "g2"];
    const fakeRow = {
      id: "ev1",
      userId: "should-NOT-leak",
      sourceId: null,
      kind: "press" as const,
      authorIsMe: false,
      occurredAt: new Date("2026-04-29T00:00:00Z"),
      title: "T",
      url: null,
      notes: null,
      metadata: {},
      externalId: null,
      lastPolledAt: null,
      lastPollStatus: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    const dto = toEventDto(fakeRow as unknown as Parameters<typeof toEventDto>[0], gameIds);

    expect(dto.gameIds).toEqual(["g1", "g2"]);
    // Defensive copy: mutating the result does not affect the input.
    dto.gameIds.push("g3");
    expect(gameIds).toEqual(["g1", "g2"]);
  });

  it("Plan 02.1-28: userId is stripped from the projected DTO (P3 discipline)", () => {
    const fakeRow = {
      id: "ev2",
      userId: "leak-target",
      sourceId: null,
      kind: "press" as const,
      authorIsMe: false,
      occurredAt: new Date(),
      title: "T",
      url: null,
      notes: null,
      metadata: {},
      externalId: null,
      lastPolledAt: null,
      lastPollStatus: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    const dto = toEventDto(fakeRow as unknown as Parameters<typeof toEventDto>[0], []);

    expect(Object.keys(dto)).not.toContain("userId");
    const json = JSON.stringify(dto);
    expect(json).not.toMatch(/userId|user_id|leak-target/);
  });

  it("Plan 02.1-28: legacy singular gameId field MUST NOT appear on the projected output", () => {
    // Even when a (legacy) row literal carries `gameId`, the projection
    // function MUST NOT pass it through — the new EventDto interface
    // exposes `gameIds: string[]` only. This is the runtime tripwire for
    // a future contributor accidentally re-adding gameId to the projection.
    const fakeRow = {
      id: "ev3",
      userId: "u1",
      // Phantom legacy field — should not surface on the DTO.
      gameId: "should-not-appear",
      sourceId: null,
      kind: "press" as const,
      authorIsMe: false,
      occurredAt: new Date(),
      title: "T",
      url: null,
      notes: null,
      metadata: {},
      externalId: null,
      lastPolledAt: null,
      lastPollStatus: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    const dto = toEventDto(fakeRow as unknown as Parameters<typeof toEventDto>[0], ["g1"]);

    expect(Object.keys(dto)).not.toContain("gameId");
    expect(dto.gameIds).toEqual(["g1"]);
  });

  it("Plan 02.1-28: empty gameIds array produces gameIds: [] (inbox semantic)", () => {
    const fakeRow = {
      id: "ev4",
      userId: "u1",
      sourceId: null,
      kind: "press" as const,
      authorIsMe: false,
      occurredAt: new Date(),
      title: "T",
      url: null,
      notes: null,
      metadata: {},
      externalId: null,
      lastPolledAt: null,
      lastPollStatus: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    const dto = toEventDto(fakeRow as unknown as Parameters<typeof toEventDto>[0], []);

    expect(dto.gameIds).toEqual([]);
  });
});

// Phase 02.2 D-16 — the export envelope (services/account.ts exportAccountJson)
// composes per-entity DTO projections into one JSON envelope. Ciphertext
// columns MUST NOT cross the wire even though the underlying rows carry
// them (AGENTS.md §5 — DTO projection is the runtime barrier). The
// HTTP-boundary integration assertion lives in tests/integration/account.test.ts
// (envelope strip test); the four assertions below are the unit-layer
// projection-invariant guards over the two projection functions that own
// the secret-shaped fields the envelope risks leaking: toApiKeySteamDto
// (ciphertext columns from api_keys_steam) and toUserDto (PII / OAuth
// tokens that Better Auth's account table holds). If a future contributor
// extends either projection in a way that leaks one of these field names,
// this test fails loudly at unit-test time without booting Postgres.
describe("account export envelope ciphertext strip (Phase 02.2 D-16)", () => {
  it("Plan 02.2-03: exportAccountJson envelope contains no secret_ct field anywhere", () => {
    const fakeRow = {
      id: "k1",
      userId: "u1",
      label: "L",
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
    const dto = toApiKeySteamDto(fakeRow as Parameters<typeof toApiKeySteamDto>[0]);
    const json = JSON.stringify(dto);
    expect(json).not.toMatch(/secret_ct|secretCt/);
  });

  it("Plan 02.2-03: exportAccountJson envelope contains no wrapped_dek field anywhere", () => {
    const fakeRow = {
      id: "k2",
      userId: "u1",
      label: "L",
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
    const dto = toApiKeySteamDto(fakeRow as Parameters<typeof toApiKeySteamDto>[0]);
    const json = JSON.stringify(dto);
    expect(json).not.toMatch(/wrapped_dek|wrappedDek|dek_iv|dekIv|dek_tag|dekTag/);
  });

  it("Plan 02.2-03: exportAccountJson envelope contains no kek_version field anywhere", () => {
    const fakeRow = {
      id: "k3",
      userId: "u1",
      label: "L",
      last4: "WXYZ",
      secretCt: Buffer.from([1]),
      secretIv: Buffer.from([2]),
      secretTag: Buffer.from([3]),
      wrappedDek: Buffer.from([4]),
      dekIv: Buffer.from([5]),
      dekTag: Buffer.from([6]),
      kekVersion: 7,
      createdAt: new Date(),
      updatedAt: new Date(),
      rotatedAt: null,
    };
    const dto = toApiKeySteamDto(fakeRow as Parameters<typeof toApiKeySteamDto>[0]);
    const json = JSON.stringify(dto);
    expect(json).not.toMatch(/kek_version|kekVersion/);
    // Sanity: the literal int 7 might appear by coincidence elsewhere; the
    // assertion above is the load-bearing one (the field name is the
    // tripwire, not the value).
  });

  it("Plan 02.2-03: exportAccountJson envelope contains no googleSub / refreshToken / accessToken / idToken anywhere", () => {
    // toUserDto is the projection that owns the PII/OAuth-token strip.
    // The Better Auth `account` table carries the OAuth tokens; the user
    // row does not, but the User type literal in dto.ts carries timestamps
    // and an emailVerified flag the export must not leak. The assertion
    // here cross-checks the projection literally rather than relying on
    // schema type erasure.
    const fakeRow = {
      id: "u1",
      email: "a@b.test",
      name: "A",
      image: null,
      // PII / OAuth fields the projection MUST drop:
      googleSub: "leak-google-sub",
      refreshToken: "leak-refresh",
      accessToken: "leak-access",
      idToken: "leak-id",
      emailVerified: true,
      themePreference: "system",
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as unknown as Parameters<typeof toUserDto>[0];
    const dto = toUserDto(fakeRow);
    const json = JSON.stringify(dto);
    expect(json).not.toMatch(/googleSub|google_sub/);
    expect(json).not.toMatch(/refreshToken|refresh_token/);
    expect(json).not.toMatch(/accessToken|access_token/);
    expect(json).not.toMatch(/idToken|id_token/);
    expect(json).not.toContain("leak-google-sub");
    expect(json).not.toContain("leak-refresh");
    expect(json).not.toContain("leak-access");
    expect(json).not.toContain("leak-id");
  });
});
