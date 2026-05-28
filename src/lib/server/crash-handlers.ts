// Process-level crash handlers — the last line of defense for log
// observability. Without these, an uncaughtException or unhandledRejection
// is printed by Node as a raw plain-text stack trace to stderr, which
// bypasses Pino entirely and is invisible to the Grafana "level >= 50"
// error panel. Routing both through the Pino logger emits structured JSON
// (level 60 = fatal) that the dashboard and alerts can see.
//
// Both handlers exit(1) after logging: an uncaught exception leaves the
// process in an undefined state, and Node's own default for an unhandled
// rejection has been "crash the process" since v15. We preserve that crash
// semantic (Docker `restart: unless-stopped` brings up a clean process)
// while guaranteeing the cause is logged structurally first.
//
// handleUncaught / handleRejection take an injectable `exit` so unit tests
// can assert the log + exit-code contract without killing the test runner.

import { logger } from "./logger.js";

type ExitFn = (code: number) => void;

const defaultExit: ExitFn = (code) => process.exit(code);

export function handleUncaught(err: unknown, exit: ExitFn = defaultExit): void {
  logger.fatal({ err }, "uncaughtException");
  exit(1);
}

export function handleRejection(reason: unknown, exit: ExitFn = defaultExit): void {
  logger.fatal({ err: reason }, "unhandledRejection");
  exit(1);
}

/**
 * Register the process-level crash handlers. Call once, as early as
 * possible in the entrypoint (src/server.ts), so a crash during boot or in
 * any role is captured as structured JSON before the process dies.
 */
export function registerCrashHandlers(): void {
  process.on("uncaughtException", (err) => handleUncaught(err));
  process.on("unhandledRejection", (reason) => handleRejection(reason));
}
