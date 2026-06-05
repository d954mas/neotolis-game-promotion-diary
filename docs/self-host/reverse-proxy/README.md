# Reverse-proxy parity matrix

The app honors trusted-proxy headers behind **any** reverse proxy. There is
**one knob** you have to get right: `TRUSTED_PROXY_CIDR`. It controls which
immediate socket peer the app trusts to have set `X-Forwarded-For`,
`CF-Connecting-IP`, and `X-Forwarded-Proto`. Set it wrong and either your audit
log records the proxy's IP instead of the real client (too narrow), or an
attacker can spoof their origin IP (too wide).

No application code changes between topologies — `proxy-trust.ts` already handles
all three headers. You only set `TRUSTED_PROXY_CIDR`.

## Pick your topology

| Topology                          | `TRUSTED_PROXY_CIDR`        | Why                                                                 |
| --------------------------------- | --------------------------- | ------------------------------------------------------------------- |
| **Bare port** (nothing in front)  | *(empty)*                   | The socket peer **is** the client. A CIDR here is a spoofing hole.  |
| **Caddy, same host**              | `127.0.0.1/32`              | Caddy is the loopback peer (add `::1/128` if it reaches over IPv6). |
| **Caddy, separate container**     | `172.16.0.0/12`             | Peer is the container IP on the compose bridge, not loopback.       |
| **Cloudflare Tunnel**             | `172.16.0.0/12`             | App sees `cloudflared`'s **container** IP, NOT Cloudflare edge IPs. |
| **nginx** (the shipped example)   | contents of `nginx/cf-ips.conf` | nginx's `real_ip` rewrite + the CF edge CIDR list (refresh quarterly). |

The Docker bridge subnet defaults to a slice of `172.16.0.0/12`. Trusting the
whole `/12` is the simplest safe choice for a single-host compose deployment
where only your own containers share that bridge. If you run untrusted
containers on the same bridge, narrow it to your project's actual subnet
(`docker network inspect <network>` → `IPAM.Config.Subnet`).

## Files in this directory

- [`Caddyfile`](./Caddyfile) — Caddy with automatic Let's Encrypt TLS, reverse
  proxying to the app on `localhost:3000`. Set `TRUSTED_PROXY_CIDR=127.0.0.1/32`
  (same-host) or `172.16.0.0/12` (separate container).
- [`cloudflared-config.yml`](./cloudflared-config.yml) — Cloudflare Tunnel
  ingress to the `app` compose service. Set `TRUSTED_PROXY_CIDR=172.16.0.0/12`.

The shipped **nginx** example lives at the repo root in `nginx/`
(`nginx/nginx.conf.template` + `nginx/cf-ips.conf`); it is the topology the
author's SaaS instance runs.

## Bare port (no proxy at all)

Listen on `:3000`, put nothing in front, and leave `TRUSTED_PROXY_CIDR=` **empty**.
The app then uses the socket peer directly as the client IP — which is correct,
because with no proxy the peer **is** the client.

> **WARNING:** never set a CIDR in bare-port mode. If you trust any CIDR while
> exposed directly, anyone who can reach the port can spoof their origin by
> sending `X-Forwarded-For: 8.8.8.8`, poisoning your audit log and rate limits
> (CVE-2026-27700). Empty = trust nothing = safe by default.

Bare port is suitable for a trusted LAN or a Tailscale/WireGuard overlay where
TLS and access control happen at the network layer.

## Cloudflare Tunnel pitfall (read this)

The single most common misconfiguration: setting `TRUSTED_PROXY_CIDR` to
**Cloudflare's edge IP ranges**. That is **WRONG** for a Tunnel.

With a Tunnel, the app's immediate socket peer is the `cloudflared` container on
your Docker bridge — the request never arrives directly from a Cloudflare edge
IP. So you must trust the **bridge subnet** (`172.16.0.0/12`), not CF edge IPs.
Once the bridge peer is trusted, `proxy-trust.ts` reads `CF-Connecting-IP` (which
cloudflared forwards) to recover the real client IP.

(CF edge IPs only matter for the **nginx-in-front-of-Cloudflare** topology, where
nginx's socket peer genuinely is a Cloudflare edge node — that is what
`nginx/cf-ips.conf` is for.)

## How to confirm it works

After deploying behind your proxy, sign in and open `/audit`. The
`session.signin` row must show **your real public IP**, not the proxy's or
loopback IP. That round-trip — real client IP surviving from the browser through
the proxy into the audit log — **is** the parity proof; if the recorded IP is
`127.0.0.1`, a `172.x` container IP, or a Cloudflare edge IP, your
`TRUSTED_PROXY_CIDR` is wrong for your topology.

You do not need to add a test for this. The header-resolution logic
(`proxy-trust.ts`) is already covered by the PT1–PT6 unit tests:

- **PT1** empty CIDR → always use socket peer (XFF ignored)
- **PT2** trusted source + multi-hop XFF → walk right-to-left to the real client
- **PT3** untrusted source → XFF / CF / XFP ignored
- **PT4** trusted Cloudflare source → `CF-Connecting-IP` preferred over XFF
- **PT5** untrusted source + `CF-Connecting-IP` → header ignored
- **PT6** trusted source + `X-Forwarded-Proto` → respected (HSTS-relevant)
