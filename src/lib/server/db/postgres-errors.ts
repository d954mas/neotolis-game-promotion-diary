// Shared Postgres error predicates (Plan 02.1-29 — extracted from
// services/data-sources.ts isPgUniqueViolation).
//
// Why a shared module: Plan 02.1-29 introduces a SECOND consumer
// (services/game-steam-listings.ts addSteamListing's 23505 → AppError 422
// translation for `steam_listing_duplicate`). The events.ts variant is a
// shallow check that only inspects the top-level error; data-sources.ts
// added the cause-chain walk (drizzle-orm 0.45 wraps the original pg error
// in DrizzleQueryError whose `.cause` carries the original error with
// `.code === '23505'`). Game-steam-listings hits the same wrapped shape
// (drizzle queries) so it needs the cause-chain walker, not the shallow
// check.
//
// Depth-bounded to 5 (defensive — the walker tolerates arbitrarily deep
// `.cause` chains but never spins forever on a self-referential cycle).

/**
 * Returns true if `err` (or any error in its `.cause` chain, up to `depth`
 * levels deep) carries `.code === '23505'` (Postgres unique_violation).
 *
 * Use at the service-layer try/catch around an INSERT/UPDATE you expect a
 * partial-unique-index to potentially reject; translate the boolean true
 * into a clean `AppError(422, '<resource>_duplicate', metadata)` per the
 * Plan 02.1-04 / 02.1-29 precedent. The route layer's mapErr surfaces the
 * AppError + metadata to the client without parsing message strings (the
 * anti-pattern this helper exists to avoid).
 */
export function isPgUniqueViolation(err: unknown, depth = 5): boolean {
  let current: unknown = err;
  for (let d = 0; d < depth && current; d++) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      (current as { code: unknown }).code === "23505"
    ) {
      return true;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause: unknown }).cause
        : undefined;
  }
  return false;
}
