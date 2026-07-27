// TikTok social-provider budget — a RE-EXPORT of the shared helpers, NOT a fork.
//
// TikTok does NOT fork the budget engine — these are platform-parameterized;
// pass platform="tiktok" (RESEARCH Anti-Patterns). The shared prepaid balance is
// per-provider (Plan 01 / D-01) so IG+TikTok share one ceiling. Re-exporting from
// the instagram tree (rather than copying) keeps ONE credit ledger:
// reserveSocialCredits decrements one social_provider_balance row keyed by
// provider, so a TikTok spend and an IG spend draw down the same funded pool.
//
// The implementation lives in the neutral server layer because the funded ledger is
// a cross-cutting concern shared by multiple feature modules.
export {
  reserveSocialCredits,
  getSocialThrottleState,
  getSocialSpendToday,
  getSocialProviderSpendToday,
  resetSocialDailyCap,
  markSocialThrottleTransition,
  markSocialBudgetExhausted,
  todayPacific,
  type SocialThrottleState,
  type SocialQuotaPool,
  type SocialCreditPermit,
} from "$lib/server/services/social-provider-quota.js";
