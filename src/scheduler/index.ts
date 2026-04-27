// Phase 1 scheduler STUB. Plan 08 replaces this file with a real pg-boss
// scheduler that enqueues poll jobs via cron schedules registered in
// src/lib/server/queues.ts.
//
// This stub exists so that `node build/server.js` with APP_ROLE=scheduler
// boots cleanly during Plan 06's smoke tests / docker run sanity checks.
// Plan 10's smoke test greps stdout for 'scheduler stub ready' until
// Plan 08 lands; after Plan 08, the grep target switches to 'scheduler ready'.
//
// D-01 locks this path: src/scheduler/index.ts. Plan 08 OVERWRITES this file.

import { logger } from '../lib/server/logger.js';

export async function startScheduler(): Promise<void> {
  logger.info(
    { role: 'scheduler', stub: true },
    'scheduler stub ready (replaced by Plan 08)',
  );
  // eslint-disable-next-line no-console
  console.log('scheduler stub ready');
  await new Promise<void>(() => {
    /* never resolves */
  });
}
