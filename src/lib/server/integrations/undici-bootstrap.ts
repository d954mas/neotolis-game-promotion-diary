// undici bootstrap — force HTTP/1.1 for all process-wide outbound `fetch`.
//
// Why: undici's connector negotiates HTTP/2 by default (allowH2 true). When the
// OTHER side closes an idle keep-alive h2 connection, undici emits a SocketError
// on the h2 session-end (client-h2.js onHttp2SocketEnd) with NO in-flight request
// to attach it to. That async error escapes every request-level try/catch and
// reaches process 'uncaughtException' → crash-handlers exit(1) → the process dies
// (observed: the worker crashing ~2×/day on the flaky Reddit proxy). Over HTTP/1.1
// undici instead drops an idle-closed socket from the pool and rejects the NEXT
// reuse inside the awaited request — a recoverable, catchable path.
//
// The Reddit ProxyAgent sets allowH2:false on its own dispatcher; this covers the
// GLOBAL fetch path used by YouTube/Steam/Reddit-direct, so no h2 upstream idle
// close can crash the process. Every upstream supports h1; h2 multiplexing is
// irrelevant at this app's QPS.
//
// Side-effect on import, set once per process before the first fetch — mirrors
// dns-bootstrap. Imported from src/server.ts and src/hooks.server.ts; Node's
// module cache dedupes the single setGlobalDispatcher call. Server-only by
// placement under $lib/server/. Only `allowH2` is overridden; every other undici
// Agent default (keep-alive timeouts, pool sizing) is preserved.
//
// MAINTAINER NOTE — this REPLACES the entire global dispatcher (undici has no
// compose), and it runs very early at module load. Any future code that also
// installs a global dispatcher must account for the ordering and preserve the
// allowH2:false intent, or it silently reintroduces the worker-crash bug:
//   - env outbound proxy (honoring HTTP(S)_PROXY): build it with
//     `new ProxyAgent({ uri, ...GLOBAL_UNDICI_OPTIONS })` and run it AFTER this
//     bootstrap (it intentionally supersedes this Agent, keeping allowH2:false).
//   - MockAgent in tests: call `setGlobalDispatcher(mockAgent)` AFTER the import
//     that pulls in this module, else this one-shot side effect clobbers the mock.
// `GLOBAL_UNDICI_OPTIONS` is exported so those call sites can spread the same
// intent instead of re-deciding it.

import { Agent, setGlobalDispatcher } from "undici";

export const GLOBAL_UNDICI_OPTIONS = { allowH2: false } as const;

setGlobalDispatcher(new Agent(GLOBAL_UNDICI_OPTIONS));
