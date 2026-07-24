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

const pacificDateTimeFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function pacificOffsetAt(instant: Date): number {
  const values = Object.fromEntries(
    pacificDateTimeFormatter
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const representedAsUtc = Date.UTC(
    values.year!,
    values.month! - 1,
    values.day!,
    values.hour!,
    values.minute!,
    values.second!,
  );
  return representedAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

function pacificMidnightForDate(datePacific: string): Date {
  const localMidnightAsUtc = Date.parse(`${datePacific}T00:00:00Z`);
  let candidate = localMidnightAsUtc;
  for (let iteration = 0; iteration < 3; iteration++) {
    const adjusted = localMidnightAsUtc - pacificOffsetAt(new Date(candidate));
    if (adjusted === candidate) break;
    candidate = adjusted;
  }
  return new Date(candidate);
}

function nextIsoDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + 1)).toISOString().slice(0, 10);
}

/**
 * Returns the absolute UTC instant at which the current Pacific calendar day
 * began (00:00 PT today). Used as the cap window's lower bound.
 *
 * DST-aware: derives "00:00 in PT" via timezone offset rather than +24h
 * arithmetic, so spring-forward / fall-back days resolve correctly.
 */
export function pacificDayStart(now: Date = new Date()): Date {
  return pacificMidnightForDate(todayPacific(now));
}

/**
 * Returns 00:00 PT of the day AFTER `now`'s Pacific date — when the cap
 * window resets. UI displays "resets in {humanizeDuration(this - now)}".
 *
 * Advances the Pacific calendar date first, then resolves that local midnight.
 * This avoids `now + 24h`, which can remain on the same local date during the
 * 25-hour fall-back day.
 */
export function nextPacificMidnight(now: Date = new Date()): Date {
  return pacificMidnightForDate(nextIsoDate(todayPacific(now)));
}
