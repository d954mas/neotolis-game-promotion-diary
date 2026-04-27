// Trusted-proxy header parser (D-19/D-20 — Phase 1 Plan 06).
//
// Resolves the real client IP and protocol scheme behind any combination of
// bare port / nginx / Caddy / Cloudflare. Implements CVE-2026-27700
// mitigation: forwarded headers (X-Forwarded-For, CF-Connecting-IP,
// X-Forwarded-Proto) are honored ONLY when the immediate socket peer is
// listed in `TRUSTED_PROXY_CIDR`. From any other peer, the headers are
// ignored — an attacker who connects directly to the app cannot spoof their
// origin IP by setting `X-Forwarded-For: 8.8.8.8`.
//
// PT1: TRUSTED_PROXY_CIDR='' → always use socket peer; XFF ignored.
// PT2: trusted source + multi-hop XFF → walk right-to-left, drop trusted hops,
//      first untrusted entry is the real client.
// PT3: untrusted source → XFF / CF / XFP all ignored.
// PT4: trusted CF source + CF-Connecting-IP → header preferred over XFF.
// PT5: untrusted source + CF-Connecting-IP → header ignored.
// PT6: trusted source + X-Forwarded-Proto → respected (HSTS-relevant);
//      untrusted source falls back to socket scheme.

import ipaddr, { type IPv4, type IPv6 } from "ipaddr.js";

const { parse, parseCIDR } = ipaddr;
import type { MiddlewareHandler } from "hono";
import { env } from "../../config/env.js";

export interface CidrEntry {
  network: IPv4 | IPv6;
  bits: number;
  kind: "ipv4" | "ipv6";
}

export function parseCidrList(csv: string): CidrEntry[] {
  if (!csv.trim()) return [];
  const result: CidrEntry[] = [];
  for (const raw of csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    try {
      const [network, bits] = parseCIDR(raw);
      result.push({ network, bits, kind: network.kind() as "ipv4" | "ipv6" });
    } catch {
      throw new Error(`TRUSTED_PROXY_CIDR contains invalid CIDR: ${raw}`);
    }
  }
  return result;
}

const TRUSTED: CidrEntry[] = parseCidrList(env.TRUSTED_PROXY_CIDR);

export function isTrusted(ip: string): boolean {
  if (!ip) return false;
  let parsed: IPv4 | IPv6;
  try {
    parsed = parse(ip);
    // Normalize IPv6 IPv4-mapped (::ffff:1.2.3.4) → IPv4 so a connection from
    // an IPv6-stack TCP socket carrying an IPv4 client still matches IPv4 CIDRs.
    if (parsed.kind() === "ipv6" && (parsed as IPv6).isIPv4MappedAddress()) {
      parsed = (parsed as IPv6).toIPv4Address();
    }
  } catch {
    return false;
  }
  const kind = parsed.kind();
  return TRUSTED.some((entry) => {
    if (entry.kind !== kind) return false;
    return parsed.match([entry.network, entry.bits] as Parameters<typeof parsed.match>[0]);
  });
}

export const proxyTrust: MiddlewareHandler<{
  Variables: { clientIp: string; clientProto: "http" | "https" };
}> = async (c, next) => {
  // Hono's Node adapter exposes the underlying IncomingMessage on c.env.incoming.
  // For tests using app.request(...), tests pass a synthetic socket via the
  // third argument's `incoming.socket` field.
  const incoming = (
    c.env as { incoming?: { socket?: { remoteAddress?: string; encrypted?: boolean } } } | undefined
  )?.incoming;
  const socketIp = incoming?.socket?.remoteAddress ?? "";
  let clientIp = socketIp;
  let clientProto: "http" | "https" = incoming?.socket?.encrypted ? "https" : "http";

  if (TRUSTED.length > 0 && isTrusted(socketIp)) {
    // CF-Connecting-IP takes precedence if proxy is Cloudflare (PT4).
    const cf = c.req.header("cf-connecting-ip");
    if (cf) {
      clientIp = cf;
    } else {
      const xff = c.req.header("x-forwarded-for") ?? "";
      const hops = xff
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // Walk from right: drop trusted hops, first untrusted is the real client (PT2).
      for (let i = hops.length - 1; i >= 0; i--) {
        if (!isTrusted(hops[i]!)) {
          clientIp = hops[i]!;
          break;
        }
      }
    }
    // PT6: respect X-Forwarded-Proto from trusted source (HSTS-relevant).
    const xfp = c.req.header("x-forwarded-proto");
    if (xfp === "https" || xfp === "http") {
      clientProto = xfp;
    }
  }
  // If socket peer is NOT trusted: ignore X-Forwarded-For / CF-Connecting-IP /
  // X-Forwarded-Proto entirely (CVE-2026-27700; PT3, PT5 reject XFF/CF; PT6
  // falls back to socket scheme).

  c.set("clientIp", clientIp);
  c.set("clientProto", clientProto);
  return next();
};
