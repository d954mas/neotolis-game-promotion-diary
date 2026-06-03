// Regression guard: the pg Pool MUST have an 'error' listener. node-postgres
// emits 'error' on an idle pooled client whose backend connection drops; with no
// listener, Node's EventEmitter re-throws it as an uncaughtException and the
// process crashes for a recoverable event the pool already heals from. This was
// the second escape route found in the worker-socket-crash RCA (the first being
// undici h2 idle sockets).
//
// Real env/pool (integration project) — importing db/client constructs the Pool.

import { describe, it, expect } from "vitest";

const { pool } = await import("../../src/lib/server/db/client.js");

describe("db pool error handler", () => {
  it("has an 'error' listener so a dropped idle backend connection can't crash the process", () => {
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
  });

  it("a synthetic idle-client 'error' is absorbed, not thrown", () => {
    // Without the listener, emitting 'error' would throw (EventEmitter contract).
    // The handler logs and returns, so this must NOT throw.
    expect(() =>
      pool.emit("error", new Error("synthetic idle backend drop"), undefined as never),
    ).not.toThrow();
  });
});
