import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

// Seed env vars before any module that pulls env.ts loads (the wrapper
// imports envelope.ts which imports env.ts at top level). Mirrors the
// pattern in tests/unit/encryption.test.ts.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "x".repeat(40);
process.env.OAUTH_CLIENT_ID ??= "test-google-id";
process.env.OAUTH_CLIENT_SECRET ??= "test-google-secret";
process.env.APP_KEK_BASE64 ??= randomBytes(32).toString("base64");

// Storage shared by the mocked drizzleAdapter so we can inspect what the
// wrapper actually wrote vs what Better Auth saw on the way back.
const storage: { row: Record<string, unknown> | null } = { row: null };
const calls: { op: string; model: string; payload: unknown }[] = [];

vi.mock("better-auth/adapters/drizzle", () => ({
  // The real `drizzleAdapter` is `(db, config) => (options) => DBAdapter`.
  // We mirror that exact shape with a fake that records inputs and reads
  // back the same row, simulating a single-row Postgres "table".
  drizzleAdapter: () => () => ({
    id: "fake",
    create: async ({ model, data }: { model: string; data: Record<string, unknown> }) => {
      calls.push({ op: "create", model, payload: data });
      storage.row = { ...data };
      return storage.row;
    },
    update: async ({ model, update }: { model: string; update: Record<string, unknown> }) => {
      calls.push({ op: "update", model, payload: update });
      storage.row = { ...storage.row, ...update };
      return storage.row;
    },
    updateMany: async ({ model, update }: { model: string; update: Record<string, unknown> }) => {
      calls.push({ op: "updateMany", model, payload: update });
      storage.row = { ...storage.row, ...update };
      return 1;
    },
    findOne: async ({ model }: { model: string }) => {
      calls.push({ op: "findOne", model, payload: null });
      return storage.row;
    },
    findMany: async ({ model }: { model: string }) => {
      calls.push({ op: "findMany", model, payload: null });
      return storage.row ? [storage.row] : [];
    },
    count: async () => 0,
    delete: async () => undefined,
    deleteMany: async () => 0,
    transaction: async <R>(cb: (trx: unknown) => Promise<R>) => cb(undefined),
  }),
}));

// Import AFTER vi.mock so the wrapper picks up the mocked drizzleAdapter.
const { encryptedDrizzleAdapter } = await import("../../src/lib/server/auth-adapter.js");

const REFRESH_TOKEN = "1//05GoogleRefreshTokenSecretValue123";
const ACCESS_TOKEN = "ya29.GoogleAccessTokenLooksLikeThis";
const ID_TOKEN = "eyJhbGciOiJSUzI1NiIsImtpZCI6Im1vY2tfa2lkIn0.payload.signature";

function reset() {
  storage.row = null;
  calls.length = 0;
}

describe("encryptedDrizzleAdapter — OAuth token envelope encryption (D-11 / Fix 4)", () => {
  it("create on `account` writes ciphertext to storage and returns plaintext to Better Auth", async () => {
    reset();
    const factory = encryptedDrizzleAdapter({} as never, { provider: "pg" });
    const adapter = factory({} as never);

    const created = (await adapter.create({
      model: "account",
      data: {
        userId: "u1",
        accountId: "google-sub-1",
        providerId: "google",
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        idToken: ID_TOKEN,
      },
    })) as Record<string, unknown>;

    expect(created.refreshToken).toBe(REFRESH_TOKEN);
    expect(created.accessToken).toBe(ACCESS_TOKEN);
    expect(created.idToken).toBe(ID_TOKEN);

    expect(storage.row).not.toBeNull();
    const stored = storage.row!;
    const storedRefresh = stored.refreshToken as string;
    expect(storedRefresh.startsWith("ev1:")).toBe(true);
    expect(storedRefresh).not.toContain(REFRESH_TOKEN);
    expect(storedRefresh).not.toContain("GoogleRefreshTokenSecretValue");
    expect((stored.accessToken as string).startsWith("ev1:")).toBe(true);
    expect((stored.idToken as string).startsWith("ev1:")).toBe(true);
    // Non-token fields untouched.
    expect(stored.providerId).toBe("google");
    expect(stored.accountId).toBe("google-sub-1");
  });

  it("findOne on `account` decrypts back to plaintext for Better Auth", async () => {
    reset();
    const factory = encryptedDrizzleAdapter({} as never, { provider: "pg" });
    const adapter = factory({} as never);
    await adapter.create({
      model: "account",
      data: { userId: "u2", providerId: "google", refreshToken: REFRESH_TOKEN },
    });
    const found = (await adapter.findOne({ model: "account", where: [] })) as {
      refreshToken: string;
    };
    expect(found.refreshToken).toBe(REFRESH_TOKEN);
  });

  it("findMany on `account` decrypts each row back to plaintext", async () => {
    reset();
    const factory = encryptedDrizzleAdapter({} as never, { provider: "pg" });
    const adapter = factory({} as never);
    await adapter.create({
      model: "account",
      data: { userId: "u2b", providerId: "google", refreshToken: REFRESH_TOKEN },
    });
    const rows = (await adapter.findMany({ model: "account", limit: 10 })) as {
      refreshToken: string;
    }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.refreshToken).toBe(REFRESH_TOKEN);
  });

  it("update on `account` re-encrypts new tokens with fresh DEK + IV", async () => {
    reset();
    const factory = encryptedDrizzleAdapter({} as never, { provider: "pg" });
    const adapter = factory({} as never);
    await adapter.create({
      model: "account",
      data: { userId: "u3", providerId: "google", refreshToken: "old" },
    });
    const firstStored = storage.row!.refreshToken as string;
    await adapter.update({
      model: "account",
      where: [],
      update: { refreshToken: "new" },
    });
    const secondStored = storage.row!.refreshToken as string;
    expect(secondStored.startsWith("ev1:")).toBe(true);
    expect(secondStored).not.toBe(firstStored);
    expect(secondStored).not.toContain("new");
  });

  it("does not double-encrypt an already-wrapped value (idempotent on update)", async () => {
    reset();
    const factory = encryptedDrizzleAdapter({} as never, { provider: "pg" });
    const adapter = factory({} as never);
    await adapter.create({
      model: "account",
      data: { userId: "u4", providerId: "google", refreshToken: REFRESH_TOKEN },
    });
    const wrapped = storage.row!.refreshToken as string;
    await adapter.update({
      model: "account",
      where: [],
      update: { refreshToken: wrapped },
    });
    expect(storage.row!.refreshToken).toBe(wrapped);
  });

  it("non-account models pass through untouched", async () => {
    reset();
    const factory = encryptedDrizzleAdapter({} as never, { provider: "pg" });
    const adapter = factory({} as never);
    await adapter.create({
      model: "user",
      data: { id: "u5", email: "x@x.test", refreshToken: "would-not-be-encrypted-here" },
    });
    expect(storage.row!.refreshToken).toBe("would-not-be-encrypted-here");
  });

  it("legacy plaintext rows decrypt to themselves (graceful migration)", async () => {
    reset();
    const factory = encryptedDrizzleAdapter({} as never, { provider: "pg" });
    const adapter = factory({} as never);
    // Plant a row with plaintext (no `ev1:` prefix) directly into storage.
    storage.row = { userId: "u6", providerId: "google", refreshToken: "legacy-plain-token" };
    const found = (await adapter.findOne({ model: "account", where: [] })) as {
      refreshToken: string;
    };
    // Plaintext is returned as-is — graceful migration so a half-rolled-out
    // schema doesn't break authentication for users whose row was written
    // before this commit.
    expect(found.refreshToken).toBe("legacy-plain-token");
  });

  it("missing/empty tokens are not encrypted (no JSON blob written for null/undefined)", async () => {
    reset();
    const factory = encryptedDrizzleAdapter({} as never, { provider: "pg" });
    const adapter = factory({} as never);
    await adapter.create({
      model: "account",
      data: {
        userId: "u7",
        providerId: "google",
        accessToken: ACCESS_TOKEN,
        // refreshToken omitted; idToken is empty string
        idToken: "",
      },
    });
    expect((storage.row!.accessToken as string).startsWith("ev1:")).toBe(true);
    expect(storage.row!.refreshToken).toBeUndefined();
    expect(storage.row!.idToken).toBe(""); // empty stays empty
  });
});
