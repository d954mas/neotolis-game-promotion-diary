// DNS bootstrap — set IPv4-first resolution once per Node process.
//
// Node 18+ defaults to whatever the OS returns for getaddrinfo, which
// on dual-stack Windows hosts without working IPv6 connectivity hangs
// outbound fetch calls until the per-request timeout fires. Calling
// dns.setDefaultResultOrder('ipv4first') flips the global default so
// every outbound fetch in the process prefers A records.
//
// This module's side-effect runs at module-load time, so importing it
// once from `src/server.ts` and `src/hooks.server.ts` is enough to
// guarantee the call happens exactly once per process — even if both
// import paths fire (dual-stack Vite SSR / production node entry),
// Node's module cache dedupes the load.
//
// Server-only by placement (lives under `$lib/server/`); SvelteKit + the
// node build pipeline never bundle this for the browser. Top-level
// static import of `node:dns` is therefore safe and gives us synchronous
// side-effect execution at module load — a dynamic `await import` would
// race against the first outbound fetch on the same tick.
//
// Replaces the per-request dns.setDefaultResultOrder call that previously
// lived in `youtube-oembed.ts` (B-8). One global write per process is
// the correct shape; per-request was a wasted syscall on every paste.

import dns from "node:dns";
import { logger } from "../logger.js";

try {
  dns.setDefaultResultOrder("ipv4first");
} catch (err) {
  logger.warn(
    { err: String((err as Error)?.message ?? err) },
    "dns-bootstrap: setDefaultResultOrder failed; outbound fetches may prefer IPv6",
  );
}
