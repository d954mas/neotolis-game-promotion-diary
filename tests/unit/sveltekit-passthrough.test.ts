// SvelteKit pass-through resolve-path tests.
//
// Locks the fix for ERR_HTTP_HEADERS_SENT: when SvelteKit writes the response
// to the raw `outgoing` and fires finish/close, the handler must resolve with
// the injected already-sent sentinel (in prod, @hono/node-server's
// RESPONSE_ALREADY_SENT, which carries the `x-hono-already-sent` header) so
// node-server does NOT writeHead a second time. When SvelteKit declines via
// next(), a real 404 is returned instead.
//
// The sentinel is injected (see createSvelteKitPassthrough's signature), so
// this test never imports @hono/node-server — it uses a marker Response and
// asserts identity.

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { Context } from "hono";
import { createSvelteKitPassthrough } from "../../src/lib/server/http/sveltekit-passthrough.js";

// Stand-in for @hono/node-server's RESPONSE_ALREADY_SENT — identity is what
// the handler must return on finish/close.
const ALREADY_SENT = new Response(null, { headers: { "x-hono-already-sent": "true" } });

// Minimal Hono Context: the handler only reads c.env (incoming/outgoing) and
// calls c.text(body, status).
function fakeContext(env: unknown): Context {
  return {
    env,
    text: (body: string, status?: number) => new Response(body, { status: status ?? 200 }),
  } as unknown as Context;
}

function fakeOutgoing() {
  return Object.assign(new EventEmitter(), { statusCode: 200 });
}

describe("createSvelteKitPassthrough", () => {
  it("returns the already-sent sentinel when SvelteKit wrote the response (finish)", async () => {
    const outgoing = fakeOutgoing();
    // SvelteKit writes directly and fires 'finish' on a later tick (after the
    // handler has attached its listeners).
    const svelteHandler = (_req: unknown, res: unknown) => {
      setImmediate(() => (res as EventEmitter).emit("finish"));
    };
    const handler = createSvelteKitPassthrough(svelteHandler as never, ALREADY_SENT);

    const res = await handler(fakeContext({ incoming: {}, outgoing }));

    expect(res).toBe(ALREADY_SENT);
    expect(res.headers.get("x-hono-already-sent")).toBe("true");
  });

  it("returns the already-sent sentinel on 'close' too", async () => {
    const outgoing = fakeOutgoing();
    const svelteHandler = (_req: unknown, res: unknown) => {
      setImmediate(() => (res as EventEmitter).emit("close"));
    };
    const handler = createSvelteKitPassthrough(svelteHandler as never, ALREADY_SENT);

    const res = await handler(fakeContext({ incoming: {}, outgoing }));

    expect(res).toBe(ALREADY_SENT);
  });

  it("returns a real 404 when SvelteKit declines the route (next)", async () => {
    const outgoing = fakeOutgoing();
    const svelteHandler = (_req: unknown, _res: unknown, next?: () => void) => {
      next?.();
    };
    const handler = createSvelteKitPassthrough(svelteHandler as never, ALREADY_SENT);

    const res = await handler(fakeContext({ incoming: {}, outgoing }));

    expect(res).not.toBe(ALREADY_SENT);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });

  it("first signal wins — a later finish does not override the next() 404", async () => {
    const outgoing = fakeOutgoing();
    const svelteHandler = (_req: unknown, res: unknown, next?: () => void) => {
      next?.();
      setImmediate(() => (res as EventEmitter).emit("finish"));
    };
    const handler = createSvelteKitPassthrough(svelteHandler as never, ALREADY_SENT);

    const res = await handler(fakeContext({ incoming: {}, outgoing }));

    expect(res.status).toBe(404);
  });

  it("returns 500 when the node adapter context is missing", async () => {
    const handler = createSvelteKitPassthrough(((): void => {}) as never, ALREADY_SENT);

    const res = await handler(fakeContext(undefined));

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("node adapter context missing");
  });
});
