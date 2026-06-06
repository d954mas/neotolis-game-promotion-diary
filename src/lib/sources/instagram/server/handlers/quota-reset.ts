// Daily Instagram (social-provider) quota reset cron handler.
//
// Fires at 00:00 America/Los_Angeles. Resets the DAILY-CAP machinery ONLY:
// clears the audit-emission gate so a new day can re-emit throttle transitions,
// and seeds the new day's zero counter rows (resetSocialDailyCap, Plan 03).
//
// MUST NOT touch the prepaid balance — that is the monotonic hard ceiling and is
// NEVER refilled by the cron ("cannot spend what isn't there", D-16 / Pitfall 3).
// resetSocialDailyCap contains no write to social_provider_balance; the Plan 03
// budget-throttle integration test asserts the balance survives a reset
// unchanged. This handler is the SAME daily-reset machinery the YouTube
// quota_reset cron uses, retargeted to the prepaid-credit daily counter.
//
// Idempotent: a re-run within the same Pacific day is harmless (the Set clear is
// a no-op if already empty; the counter seed is ON CONFLICT DO NOTHING).

import { resetSocialDailyCap } from "../quota.js";
import { logger } from "$lib/server/logger.js";

export async function handleInstagramQuotaReset(job: { id?: string; data: object }): Promise<void> {
  await resetSocialDailyCap();
  logger.info(
    { jobId: job.id },
    "instagram.quota_reset — daily-cap counter reset (prepaid balance untouched, Pitfall 3)",
  );
}
