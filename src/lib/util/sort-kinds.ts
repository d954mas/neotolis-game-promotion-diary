/**
 * Plan 02.1-20: tiny utility for sorting items alphabetically by their
 * translated label. Used by:
 *   - /events/new kind picker (functional-only kinds, sorted by m.event_kind_label_*())
 *   - FiltersSheet kind checkbox-list (same)
 *   - FiltersSheet action checkbox-list (audit, sorted by m.audit_action_*())
 *
 * The sort runs at render time so it works across locales — if Paraglide
 * locale switches at runtime, the next render produces the new locale's
 * alphabetical order without any cache invalidation.
 *
 * Locale handling: Intl.Collator is constructed with `undefined` for the
 * locale arg so the runtime-current locale wins (en in MVP; whatever
 * Paraglide is set to post-locale-add). `sensitivity: "base"` gives
 * accent-insensitive primary collation (Á clusters with A, not after Z).
 *
 * Stability guarantee: V8 / SpiderMonkey / JSC implement a stable sort
 * since ES2019, so equal-label items retain input order. Callers that
 * need a deterministic ordering for equal labels should sort the input
 * by a tiebreaker BEFORE passing to sortByLabel.
 *
 * Does NOT mutate the input — spreads to a new array, then sorts.
 */
export function sortByLabel<T>(items: readonly T[], getLabel: (item: T) => string): T[] {
  const collator = new Intl.Collator(undefined, { sensitivity: "base" });
  return [...items].sort((a, b) => collator.compare(getLabel(a), getLabel(b)));
}
