// Calendar-day relative label for a YYYY-MM-DD date, relative to the local
// today: "today" / "yesterday" / "N days ago" / "a week ago" / "N weeks ago" /
// "a month ago" / "N months ago". Used for the wishlist data-recency line so
// the user reads freshness at a glance instead of a raw ISO date. Routed
// through m.* (i18n). Future / unparseable dates fall back to the raw string.

import { m } from "$lib/paraglide/messages.js";

export function relativeDate(ymd: string): string {
  const [y, mo, d] = ymd.split("-").map(Number);
  if (!y || !mo || !d) return ymd;
  const then = new Date(y, mo - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((today.getTime() - then.getTime()) / 86_400_000);
  if (days <= 0) return m.relative_date_today();
  if (days === 1) return m.relative_date_yesterday();
  if (days < 7) return m.relative_date_days_ago({ days });
  if (days < 14) return m.relative_date_week_ago();
  if (days < 30) return m.relative_date_weeks_ago({ weeks: Math.floor(days / 7) });
  if (days < 60) return m.relative_date_month_ago();
  return m.relative_date_months_ago({ months: Math.floor(days / 30) });
}
