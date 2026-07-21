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
// The reddit adapter modules import these from HERE so the reddit tree reads its
// budget helpers from inside its own folder, while the single implementation still
// lives in instagram/server/quota.ts (the canonical home — moving it would be a
// no-op churn the no-fork rule forbids).
export {
  reserveSocialCredits,
  getSocialThrottleState,
  getSocialSpendToday,
  resetSocialDailyCap,
  markSocialThrottleTransition,
  markSocialBudgetExhausted,
  todayPacific,
  type SocialThrottleState,
  type SocialQuotaPool,
  type SocialCreditPermit,
} from "$lib/sources/instagram/server/quota.js";
