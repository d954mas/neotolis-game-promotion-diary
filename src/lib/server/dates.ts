// Pacific calendar day helpers — no-deps module so it can be imported by
// shared services AND per-platform adapter trees without creating cycles.
//
// Operator API quotas (YouTube Data API v3) reset at midnight Pacific;
// the per-user fair-share cap counter syncs to the same boundary;
// /admin/quota uses today's Pacific date string as the row key. All
// three consumers need the same DST-aware "today in PT" computation.
//
// Why this lives in `src/lib/server/dates.ts` rather than alongside other
// shared services: `src/lib/server/services/quota.ts` imports `allAdapters`
// from the source registry, which transitively loads each adapter's quota
// module. If those adapter modules imported helpers from
// `services/quota.ts`, we'd close a cycle (services → registry → youtube →
// services). Keeping these helpers in a leaf module breaks the cycle by
// construction.

/**
 * Returns 'YYYY-MM-DD' in America/Los_Angeles for the given instant.
 * sv-SE locale gives ISO-shape output without manual formatting; Intl
 * handles DST transitions automatically.
 */
export function todayPacific(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Returns the absolute UTC instant at which the current Pacific calendar day
 * began (00:00 PT today). Used as the cap window's lower bound.
 *
 * DST-aware: derives "00:00 in PT" via timezone offset rather than +24h
 * arithmetic, so spring-forward / fall-back days resolve correctly.
 */
export function pacificDayStart(now: Date = new Date()): Date {
  const datePT = todayPacific(now);
  const offsetParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "shortOffset",
  }).formatToParts(now);
  const offsetPart = offsetParts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-8";
  const offsetMatch = offsetPart.match(/GMT([+-]\d+)/);
  const offsetHours = offsetMatch?.[1] != null ? parseInt(offsetMatch[1], 10) : -8;
  const utcMs = Date.parse(`${datePT}T00:00:00Z`) - offsetHours * 3600_000;
  return new Date(utcMs);
}

/**
 * Returns 00:00 PT of the day AFTER `now`'s Pacific date — when the cap
 * window resets. UI displays "resets in {humanizeDuration(this - now)}".
 *
 * Computed via `pacificDayStart` of (now + 24h) to handle DST edges
 * correctly: spring-forward day pacific midnight is +23h after current
 * pacific midnight, fall-back is +25h. Both resolved by formatter.
 */
export function nextPacificMidnight(now: Date = new Date()): Date {
  const tomorrow = new Date(now.getTime() + 86_400_000);
  return pacificDayStart(tomorrow);
}
