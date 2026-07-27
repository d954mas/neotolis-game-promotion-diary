// Reddit social-provider budget — a RE-EXPORT of the shared helpers, NOT a fork.
//
// Reddit does NOT fork the budget engine — these are platform-parameterized; pass
// platform="reddit", provider="scrapecreators". Unlike twitterapi.io (which has its
// OWN per-provider prepaid balance row), ScrapeCreators SHARES its prepaid balance
// row with Instagram + TikTok: the same key/pool (D-01). reserveSocialCredits
// decrements ONE social_provider_balance row keyed by PROVIDER, so a Reddit spend
// draws down the SAME ScrapeCreators balance an IG/TikTok spend does (Reddit is the
// 4th consumer of that pool, never a separate ledger).
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
  resolveOperatorUserId,
  todayPacific,
  type SocialThrottleState,
  type SocialQuotaPool,
  type SocialCreditPermit,
} from "$lib/server/services/social-provider-quota.js";
