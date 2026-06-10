// Daily TikTok (social-provider) quota reset cron handler.
//
// Fires at 00:00 America/Los_Angeles. Resets the DAILY-CAP machinery ONLY: clears
// the audit-emission gate so a new day can re-emit throttle transitions, and seeds
// the new day's zero counter rows (resetSocialDailyCap — the SHARED helper).
//
// MUST NOT touch the prepaid balance — that is the monotonic hard ceiling shared
// with Instagram (D-01) and is NEVER refilled by the cron ("cannot spend what
// isn't there", D-16 / Pitfall 3). resetSocialDailyCap contains no write to
// social_provider_balance. This is the SAME daily-reset machinery the Instagram
// quota_reset cron uses — both call the one shared helper, so the IG and TikTok
// crons cannot drift.
//
// Idempotent: a re-run within the same Pacific day is harmless.

import { resetSocialDailyCap } from "../quota.js";
import { logger } from "$lib/server/logger.js";

export async function handleTikTokQuotaReset(job: { id?: string; data: object }): Promise<void> {
  await resetSocialDailyCap();
  logger.info(
    { jobId: job.id },
    "tiktok.quota_reset — daily-cap counter reset (prepaid balance untouched, Pitfall 3)",
  );
}
