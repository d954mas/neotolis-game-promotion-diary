// Phase 1 worker STUB. Plan 08 replaces this file with a real pg-boss worker
// implementation that subscribes to QUEUES.poll.{hot,warm,cold,user} and
// internal.healthcheck (declared by src/lib/server/queues.ts in Plan 03).
//
// This stub exists so that `node build/server.js` with APP_ROLE=worker boots
// cleanly during Plan 06's smoke tests / docker run sanity checks. Plan 10's
// smoke test greps stdout for 'worker stub ready' until Plan 08 lands; after
// Plan 08, the grep target switches to 'worker ready'.
//
// D-01 locks this path: src/worker/index.ts. Plan 08 OVERWRITES this file.

import { logger } from '../lib/server/logger.js';

export async function startWorker(): Promise<void> {
  logger.info(
    { role: 'worker', stub: true },
    'worker stub ready (replaced by Plan 08)',
  );
  // Match Plan 10's stdout grep contract while Plan 08 is pending.
  // eslint-disable-next-line no-console
  console.log('worker stub ready');
  // Keep the process alive so the smoke-test container does not exit
  // immediately. Plan 08 replaces this with pg-boss' own event loop.
  await new Promise<void>(() => {
    /* never resolves — process lives until SIGTERM */
  });
}
