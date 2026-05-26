// formatFeedDate — compact / relative date format for the feed surface.
// This helper buckets dates into 4 surfaces:
//   - same calendar day → "Today, HH:MM" (24h locale)
//   - one calendar day back → "Yesterday"
//   - same calendar year, older than yesterday → "Ddd, MMM D" (Mon, Apr 25)
//   - earlier years → "Ddd, MMM D, YYYY" (Mon, Apr 25, 2025)
//
// Weekday prefix on the older-than-yesterday buckets matches the
// prototype's FeedDateGroupHeader which leads with the weekday name
// (e.g. "Mon, May 12") — it's a strong scanning anchor when the user
// scrolls past several days of activity.
//
// Locale: fixed `"en"`. Date format conventions (Apr 15, Dec 25, 2025) are
// a brand choice, NOT a translation target — Paraglide handles all
// user-facing copy elsewhere. Locking the locale keeps assertions stable
// on any host machine (a Russian-locale dev box would otherwise produce
// "15 апр." and trip CI). Per-user date-format preference can be added
// as a user setting later.
//
// All four buckets compare local calendar dates (getFullYear/getMonth/
// getDate), not raw millis, so DST transitions don't flip "Yesterday" to
// "Today" or vice versa at the boundary day.
//
// Returns "—" on null / undefined / invalid input so the feed never
// renders "Invalid Date" (defensive fallback — no test should ever hit
// this branch with valid wire data, but the projection layer can carry
// nulls through and the UI still needs to render something).

export function formatFeedDate(input: Date | string | null | undefined): string {
  if (input == null) return "—";
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "—";

  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `Today, ${hh}:${mm}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return "Yesterday";

  const sameYear = d.getFullYear() === now.getFullYear();
  if (sameYear) {
    return d.toLocaleDateString("en", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }
  return d.toLocaleDateString("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
