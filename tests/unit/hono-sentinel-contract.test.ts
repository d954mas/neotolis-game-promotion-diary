// Pins the upstream contract the SvelteKit pass-through fix depends on:
// @hono/node-server's RESPONSE_ALREADY_SENT must carry the
// `x-hono-already-sent` header (and a null body) — that header is the ONLY
// signal node-server uses to skip a second writeHead (dist/index.mjs:751).
// If an upstream rename/removal breaks this, fail here in <1ms rather than
// only in the Docker smoke gate.

import { describe, it, expect } from "vitest";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";

describe("@hono/node-server RESPONSE_ALREADY_SENT contract", () => {
  it("carries x-hono-already-sent:true and a null body", () => {
    expect(RESPONSE_ALREADY_SENT.headers.get("x-hono-already-sent")).toBe("true");
    expect(RESPONSE_ALREADY_SENT.body).toBeNull();
  });
});
