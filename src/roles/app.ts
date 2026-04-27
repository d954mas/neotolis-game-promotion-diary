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
import { env } from "../lib/server/config/env.js";
import { logger } from "../lib/server/logger.js";
import { pool } from "../lib/server/db/client.js";

export async function start(): Promise<void> {
  const app = createApp();

  // SvelteKit adapter-node handler is built into ./build/handler.js by
  // `pnpm build`. In dev (vite dev), SvelteKit serves itself — this server
  // is for production. We import dynamically so dev-mode does not require
  // build/handler.js to exist.
  let svelteHandler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    next?: () => void,
  ) => void;
  try {
    const built = (await import(/* @vite-ignore */ "../../build/handler.js" as string)) as {
      handler: typeof svelteHandler;
    };
    svelteHandler = built.handler;
  } catch {
    logger.warn("build/handler.js not found — SvelteKit pass-through disabled (dev mode?)");
    svelteHandler = (_req, res, next) => {
      res.statusCode = 404;
      res.end("SvelteKit dev server runs on a different port; build first");
      if (next) next();
    };
  }

  // SvelteKit pass-through: anything not matched above goes to SvelteKit.
  app.all("*", async (c) => {
    return new Promise<Response>((resolve) => {
      const ctx = c.env as
        | {
            incoming?: import("node:http").IncomingMessage;
            outgoing?: import("node:http").ServerResponse;
          }
        | undefined;
      const incoming = ctx?.incoming;
      const outgoing = ctx?.outgoing;
      if (!incoming || !outgoing) {
        resolve(c.text("node adapter context missing", 500));
        return;
      }
      let resolved = false;
      svelteHandler(incoming, outgoing, () => {
        if (!resolved) {
          resolved = true;
          resolve(c.text("not found", 404));
        }
      });
      // adapter-node writes directly to outgoing; we resolve a sentinel
      // Response once the response has been finished so Hono can settle.
      outgoing.on("finish", () => {
        if (!resolved) {
          resolved = true;
          resolve(new Response(null, { status: outgoing.statusCode }));
        }
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
