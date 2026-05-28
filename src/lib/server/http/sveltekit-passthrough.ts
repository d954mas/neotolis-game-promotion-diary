// SvelteKit pass-through for the Hono catch-all (`app.all("*")`).
//
// SvelteKit's adapter-node handler writes its response DIRECTLY to the Node
// `ServerResponse` (`outgoing`). @hono/node-server then inspects whatever
// Response our handler returns and decides whether to write it. It skips
// writing ONLY when the Response carries the `x-hono-already-sent` header
// (dist/index.mjs:751 → `else if (resHeaderRecord[X_ALREADY_SENT]) {}`).
//
// The library exports exactly that sentinel as `RESPONSE_ALREADY_SENT`. The
// previous implementation returned a bare `new Response(null, { status })`
// instead — which lacks the header, so node-server fell through to
// `outgoing.writeHead(...)` a SECOND time (adapter-node already sent the
// headers) and threw `ERR_HTTP_HEADERS_SENT`. (The old comment claimed
// node-server "checks outgoing.writableEnded before writing" — there is no
// such check; the header is the only signal.)
//
// The sentinel is INJECTED rather than imported here: this keeps the module a
// pure, dependency-light unit (no `@hono/node-server` import) that unit tests
// can drive with a marker Response. The composition root (roles/app.ts) owns
// the `@hono/node-server` import and passes the real RESPONSE_ALREADY_SENT in.

import type { Context } from "hono";
import type { IncomingMessage, ServerResponse } from "node:http";

export type SvelteHandler = (req: IncomingMessage, res: ServerResponse, next?: () => void) => void;

/**
 * Build the Hono catch-all handler that delegates to SvelteKit's adapter-node
 * handler. Extracted from roles/app.ts so the resolve-path logic (sentinel vs
 * 404 vs missing-context) is unit-testable without booting the server.
 *
 * @param svelteHandler adapter-node's (req,res,next) handler.
 * @param alreadySent   the `RESPONSE_ALREADY_SENT` sentinel from
 *   `@hono/node-server/utils/response` — returned once SvelteKit has written
 *   directly to `outgoing`, so @hono/node-server does NOT writeHead again.
 */
export function createSvelteKitPassthrough(
  svelteHandler: SvelteHandler,
  alreadySent: Response,
): (c: Context) => Promise<Response> {
  return (c) => {
    const ctx = c.env as { incoming?: IncomingMessage; outgoing?: ServerResponse } | undefined;
    const incoming = ctx?.incoming;
    const outgoing = ctx?.outgoing;
    if (!incoming || !outgoing) {
      return Promise.resolve(c.text("node adapter context missing", 500));
    }
    return new Promise<Response>((resolve) => {
      let resolved = false;
      const settle = (resp: Response): void => {
        if (resolved) return;
        resolved = true;
        resolve(resp);
      };
      svelteHandler(incoming, outgoing, () => {
        // SvelteKit declined this route; `outgoing` is untouched, so a real
        // Hono 404 is safe for node-server to write. NOTE: adapter-node 5.x's
        // terminal `ssr` middleware always writes to `outgoing` and never
        // calls next(), so this branch is a forward-compat affordance for
        // other/custom handlers — not a live path under the current adapter.
        settle(c.text("not found", 404));
      });
      // SvelteKit handled it and wrote directly to `outgoing`. Hand node-server
      // the already-sent sentinel so it does NOT writeHead again.
      outgoing.on("close", () => settle(alreadySent));
      outgoing.on("finish", () => settle(alreadySent));
    });
  };
}
