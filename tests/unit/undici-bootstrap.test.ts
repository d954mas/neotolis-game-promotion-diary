// undici-bootstrap forces HTTP/1.1 on the global dispatcher so an idle keep-alive
// h2 socket the upstream closes can't escape to uncaughtException and crash the
// process (the worker-socket-crash fix). Importing the module runs the one-shot
// setGlobalDispatcher side effect.

import { describe, it, expect } from "vitest";
import { Agent, getGlobalDispatcher } from "undici";
import { GLOBAL_UNDICI_OPTIONS } from "../../src/lib/server/integrations/undici-bootstrap.js";

describe("undici-bootstrap", () => {
  it("pins allowH2:false (HTTP/1.1) as the global outbound contract", () => {
    expect(GLOBAL_UNDICI_OPTIONS.allowH2).toBe(false);
  });

  it("installs an undici Agent as the global dispatcher", () => {
    // The import side effect already called setGlobalDispatcher(new Agent(...)).
    expect(getGlobalDispatcher()).toBeInstanceOf(Agent);
  });
});
