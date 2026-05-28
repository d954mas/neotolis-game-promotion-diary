// `app` role entrypoint — boots the Hono server and mounts the SvelteKit
// adapter-node handler so a single process serves /healthz, /readyz,
// /api/auth/* (Better Auth), /api/* (tenantScope target), and every
// SvelteKit page from one port.
//
// Hono is the outer server; SvelteKit's adapter-node handler is invoked
// as a Node middleware for the catch-all route. That keeps the auth and
// health layers Hono-native (web standards, fast) while letting SvelteKit
// own UI rendering and form actions.
//
// Graceful shutdown: SIGTERM drains the HTTP server, then closes the
// pg.Pool. Force-exit fallback at 60 s to keep an orchestrator from
// hanging on a wedged drain.

import { serve } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { createApp } from "../lib/server/http/app.js";
import { createSvelteKitPassthrough } from "../lib/server/http/sveltekit-passthrough.js";
import { env, scrubKekFromEnv } from "../lib/server/config/env.js";
import { logger } from "../lib/server/logger.js";
import { pool } from "../lib/server/db/client.js";

export async function start(): Promise<void> {
  const app = createApp();

  // SvelteKit adapter-node handler is built into ./build/handler.js by
  // `pnpm build` (vite build, before tsup). In dev (vite dev), SvelteKit
  // serves itself — this server is for production. We import dynamically so
  // dev-mode does not require build/handler.js to exist.
  //
  // `__SVELTEKIT_HANDLER__` is a tsup-injected constant (see tsup.config.ts
  // `define`). In the bundled build/server.js it is the string "./handler.js"
  // (a sibling of build/server.js). In dev (no tsup pass) the constant is
  // undefined and we fall back to the source-relative path. The `typeof`
  // guard makes both code paths typecheck with strict TS.
  let svelteHandler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    next?: () => void,
  ) => void;
  const handlerPath =
    typeof __SVELTEKIT_HANDLER__ !== "undefined" ? __SVELTEKIT_HANDLER__ : "../../build/handler.js";
  try {
    const built = (await import(/* @vite-ignore */ handlerPath)) as {
      handler: typeof svelteHandler;
    };
    svelteHandler = built.handler;
    logger.info({ handlerPath }, "SvelteKit handler loaded");
    // P2 scrub: run NOW that every bundle that needs APP_KEK_BASE64 has
    // already parsed it into its own kekVersions Map. See env.ts header.
    scrubKekFromEnv();
  } catch (err) {
    logger.error(
      { err, handlerPath },
      "SvelteKit handler import failed — falling back to dev-mode 404 stub",
    );
    svelteHandler = (_req, res, next) => {
      res.statusCode = 404;
      res.end("SvelteKit dev server runs on a different port; build first");
      if (next) next();
    };
  }

  // SvelteKit pass-through: anything not matched above goes to SvelteKit.
  // The resolve-path logic (RESPONSE_ALREADY_SENT once SvelteKit wrote to the
  // raw response vs. a Hono 404 when it declined) lives in — and is unit
  // tested by — sveltekit-passthrough.ts.
  app.all("*", createSvelteKitPassthrough(svelteHandler, RESPONSE_ALREADY_SENT));

  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    logger.info({ port: info.port, role: "app" }, "app role listening");
  });

  // Graceful shutdown.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "received shutdown signal, draining…");
    server.close(async () => {
      try {
        await pool.end();
      } catch (err) {
        logger.warn({ err }, "pool drain error");
      }
      process.exit(0);
    });
    // Force exit after 60 s if drain hangs.
    setTimeout(() => {
      logger.error("drain timed out, force-exit");
      process.exit(1);
    }, 60_000).unref();
  };
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}
