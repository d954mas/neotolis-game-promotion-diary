// Shared relative-time bucketing for wishlist "updated X ago" labels.
//
// Extracted from the verbatim copies that lived in WishlistSummary.svelte and
// SteamListingRow.svelte. Every bucket routes through the same m.wishlist_ago_*
// messages so the i18n contract stays in one place.

import { m } from "$lib/paraglide/messages.js";

export function wishlistAgo(when: Date | string): string {
  const t = typeof when === "string" ? new Date(when) : when;
  const sec = Math.max(0, Math.floor((Date.now() - t.getTime()) / 1000));
  if (sec < 60) return m.wishlist_ago_just_now();
  const min = Math.floor(sec / 60);
  if (min < 60) return m.wishlist_ago_minutes({ minutes: min });
  const hour = Math.floor(min / 60);
  if (hour < 24) return m.wishlist_ago_hours({ hours: hour });
  return m.wishlist_ago_days({ days: Math.floor(hour / 24) });
}
