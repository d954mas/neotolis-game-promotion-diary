// Twitter/X social-provider budget — a RE-EXPORT of the shared helpers, NOT a fork.
//
// Twitter does NOT fork the budget engine — these are platform-parameterized; pass
// platform="twitter", provider="twitterapi.io". twitterapi.io has its OWN
// per-provider prepaid balance row (Plan 10-01 per-provider re-key / D-02) — it does
// NOT share the ScrapeCreators pool that IG+TikTok draw from. Re-exporting from the
// instagram tree (rather than copying) keeps ONE credit ledger:
// reserveSocialCredits decrements one social_provider_balance row keyed by provider,
// so a Twitter spend draws down the twitterapi.io balance while an IG/TikTok spend
// draws down the (separate) ScrapeCreators balance.
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
