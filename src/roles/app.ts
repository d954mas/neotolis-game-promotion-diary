// `app` role entrypoint — boots the Hono server and mounts the SvelteKit
// adapter-node handler so a single process serves /healthz, /readyz,
// /api/auth/* (Better Auth), /api/* (Plan 07 tenantScope target), and every
// SvelteKit page from one port.
//
// Pattern 1 (RESEARCH.md): Hono is the outer server; SvelteKit's
// adapter-node handler is invoked as a Node middleware for the catch-all
// route. That keeps the auth and health layers Hono-native (web standards,
// fast) while letting SvelteKit own UI rendering and form actions.
//
// Graceful shutdown (D-22): SIGTERM drains the HTTP server, then closes the
// pg.Pool. Force-exit fallback at 60 s to keep an orchestrator from hanging
// on a wedged drain.

import { serve } from "@hono/node-server";
import { createApp } from "../lib/server/http/app.js";
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
  //
  // adapter-node writes directly to `outgoing` (Node's http.ServerResponse),
  // so we cannot return a normal Hono Response — @hono/node-server would try
  // to writeHead again and trip ERR_HTTP_HEADERS_SENT. Instead we return a
  // sentinel Response and rely on @hono/node-server's outgoing.writableEnded
  // check to bail before writing. The `next` callback is the explicit
  // "SvelteKit didn't match this route" path — we serve a 404 in that case.
  app.all("*", async (c) => {
    const ctx = c.env as
      | {
          incoming?: import("node:http").IncomingMessage;
          outgoing?: import("node:http").ServerResponse;
        }
      | undefined;
    const incoming = ctx?.incoming;
    const outgoing = ctx?.outgoing;
    if (!incoming || !outgoing) {
      return c.text("node adapter context missing", 500);
    }
    return new Promise<Response>((resolve) => {
      let resolved = false;
      const settle = (resp: Response): void => {
        if (resolved) return;
        resolved = true;
        resolve(resp);
      };
      svelteHandler(incoming, outgoing, () => {
        // SvelteKit decided this request is not its responsibility.
        // outgoing has not been written; we can safely return a Hono 404.
        settle(c.text("not found", 404));
      });
      // SvelteKit handled the request and wrote directly to outgoing.
      // Return an empty Response — @hono/node-server checks
      // outgoing.writableEnded before writing, so this is a no-op.
      outgoing.on("close", () => {
        settle(new Response(null, { status: outgoing.statusCode || 200 }));
      });
      outgoing.on("finish", () => {
        settle(new Response(null, { status: outgoing.statusCode || 200 }));
      });
    });
  });

  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    logger.info({ port: info.port, role: "app" }, "app role listening");
  });

  // Graceful shutdown (D-22).
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
