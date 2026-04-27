import { describe, it, expect } from "vitest";
import { toUserDto, toSessionDto, toApiKeySteamDto } from "../../src/lib/server/dto.js";

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
