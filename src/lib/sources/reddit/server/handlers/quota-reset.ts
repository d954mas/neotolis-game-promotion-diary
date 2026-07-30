// Daily Reddit (social-provider) quota reset cron handler.
//
// Fires at 00:00 America/Los_Angeles. Resets the DAILY-CAP machinery ONLY (the shared
// resetSocialDailyCap helper): clears the audit-emission gate + seeds the new day's
// zero counter rows. MUST NOT touch the shared ScrapeCreators prepaid balance — that
// is the monotonic hard ceiling shared with IG/TikTok (D-01 / Pitfall 3) and is NEVER
// refilled by the cron. Idempotent: a re-run within the same Pacific day is harmless.

import { resetSocialDailyCap } from "../quota.js";
import { logger } from "$lib/server/logger.js";

export async function handleRedditQuotaReset(job: { id?: string; data: object }): Promise<void> {
  await resetSocialDailyCap();
  logger.info(
    { jobId: job.id },
    "reddit.quota_reset — daily-cap counter reset (shared ScrapeCreators prepaid balance untouched)",
  );
}
