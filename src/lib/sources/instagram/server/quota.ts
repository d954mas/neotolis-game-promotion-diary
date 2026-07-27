// Compatibility barrel for the Instagram feature tree. The shared implementation
// lives in the neutral server layer because Instagram, TikTok, Twitter, and Reddit all
// consume the same provider-funded ledger.
export * from "$lib/server/services/social-provider-quota.js";
