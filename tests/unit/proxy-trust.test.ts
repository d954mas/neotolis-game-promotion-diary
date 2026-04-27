import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { randomBytes } from "node:crypto";

// Seed env BEFORE importing the module under test (matches Plan 04's env-shape contract).
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "x".repeat(40);
process.env.OAUTH_CLIENT_ID ??= "test";
process.env.OAUTH_CLIENT_SECRET ??= "test";
process.env.APP_KEK_BASE64 ??= randomBytes(32).toString("base64");
// Trusted CIDRs for these tests: private LAN, loopback, IPv6 loopback,
// and a real Cloudflare IPv6 prefix (PT4).
process.env.TRUSTED_PROXY_CIDR ??= "10.0.0.0/8,127.0.0.1/32,::1/128,2400:cb00::/32";

const { parseCidrList, isTrusted, proxyTrust } =
  await import("../../src/lib/server/http/middleware/proxy-trust.js");

/**
 * Build a tiny Hono app under proxyTrust that echoes the resolved
 * clientIp + clientProto. Tests pass the synthetic `incoming` object
 * via app.request's third arg so the middleware sees a controlled
 * `socket.remoteAddress`.
 */
function buildEchoApp() {
  const app = new Hono<{
    Variables: { clientIp: string; clientProto: "http" | "https" };
  }>();
  app.use("*", proxyTrust);
  app.get("/echo", (c) => c.json({ clientIp: c.var.clientIp, clientProto: c.var.clientProto }));
  return app;
}

/** Synthetic incoming-message factory for app.request tests. */
function fakeIncoming(remoteAddress: string, encrypted = false) {
  return { incoming: { socket: { remoteAddress, encrypted } } };
}

describe("proxy-trust: parseCidrList (helper)", () => {
  it("empty string returns empty array", () => {
    expect(parseCidrList("")).toEqual([]);
    expect(parseCidrList("   ")).toEqual([]);
  });

  it("parses IPv4 and IPv6 CIDRs", () => {
    const r = parseCidrList("10.0.0.0/8, 192.168.0.0/16, ::1/128");
    expect(r).toHaveLength(3);
    expect(r[0]!.kind).toBe("ipv4");
    expect(r[2]!.kind).toBe("ipv6");
  });

  it("throws on invalid CIDR", () => {
    expect(() => parseCidrList("not-a-cidr")).toThrow(/invalid CIDR/);
  });
});

describe("proxy-trust: isTrusted (helper)", () => {
  it("10.0.0.5 is trusted (matches 10.0.0.0/8)", () => {
    expect(isTrusted("10.0.0.5")).toBe(true);
  });

  it("1.2.3.4 is NOT trusted", () => {
    expect(isTrusted("1.2.3.4")).toBe(false);
  });

  it("IPv4-mapped IPv6 normalises to IPv4 matcher", () => {
    expect(isTrusted("::ffff:10.0.0.5")).toBe(true);
  });

  it("IPv6 ::1 matches ::1/128", () => {
    expect(isTrusted("::1")).toBe(true);
  });
});

describe("proxy-trust: middleware behavior PT1-PT6 (CVE-2026-27700 mitigation)", () => {
  it("PT1: untrusted source — XFF ignored, clientIp = socket peer", async () => {
    const app = buildEchoApp();
    const res = await app.request(
      "/echo",
      { headers: { "x-forwarded-for": "1.2.3.4" } },
      fakeIncoming("99.99.99.99"), // not trusted
    );
    const body = (await res.json()) as { clientIp: string };
    expect(body.clientIp).toBe("99.99.99.99");
  });

  it("PT2: trusted source + multi-hop XFF — walk right-to-left, drop trusted hops, return first untrusted IP", async () => {
    const app = buildEchoApp();
    const res = await app.request(
      "/echo",
      { headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1, 10.0.0.2" } },
      fakeIncoming("10.0.0.5"), // trusted (10.0.0.0/8)
    );
    const body = (await res.json()) as { clientIp: string };
    expect(body.clientIp).toBe("1.2.3.4");
  });

  it("PT3: untrusted source — XFF spoofing rejected; CVE-2026-27700 mitigation", async () => {
    const app = buildEchoApp();
    const res = await app.request(
      "/echo",
      { headers: { "x-forwarded-for": "8.8.8.8" } },
      fakeIncoming("203.0.113.7"), // untrusted public IP
    );
    const body = (await res.json()) as { clientIp: string };
    expect(body.clientIp).toBe("203.0.113.7");
    expect(body.clientIp).not.toBe("8.8.8.8");
  });

  it("PT4: trusted CF source — CF-Connecting-IP preferred over XFF", async () => {
    const app = buildEchoApp();
    const res = await app.request(
      "/echo",
      {
        headers: {
          "cf-connecting-ip": "5.6.7.8",
          "x-forwarded-for": "99.99.99.99, 10.0.0.1",
        },
      },
      fakeIncoming("2400:cb00::1"), // trusted Cloudflare CIDR
    );
    const body = (await res.json()) as { clientIp: string };
    expect(body.clientIp).toBe("5.6.7.8");
  });

  it("PT5: untrusted source with CF-Connecting-IP set — header IGNORED (attacker can set arbitrary headers)", async () => {
    const app = buildEchoApp();
    const res = await app.request(
      "/echo",
      { headers: { "cf-connecting-ip": "5.6.7.8" } },
      fakeIncoming("203.0.113.99"), // untrusted
    );
    const body = (await res.json()) as { clientIp: string };
    expect(body.clientIp).toBe("203.0.113.99");
    expect(body.clientIp).not.toBe("5.6.7.8");
  });

  it("PT6: X-Forwarded-Proto respected only from trusted source (HSTS-relevant)", async () => {
    const app = buildEchoApp();
    // From trusted source: XFP=https → clientProto='https'
    const trustedRes = await app.request(
      "/echo",
      { headers: { "x-forwarded-proto": "https" } },
      fakeIncoming("10.0.0.5"),
    );
    const trustedBody = (await trustedRes.json()) as { clientProto: string };
    expect(trustedBody.clientProto).toBe("https");

    // From untrusted source: XFP=https → IGNORED, clientProto remains http
    const untrustedRes = await app.request(
      "/echo",
      { headers: { "x-forwarded-proto": "https" } },
      fakeIncoming("203.0.113.7"),
    );
    const untrustedBody = (await untrustedRes.json()) as { clientProto: string };
    expect(untrustedBody.clientProto).toBe("http");
  });
});
