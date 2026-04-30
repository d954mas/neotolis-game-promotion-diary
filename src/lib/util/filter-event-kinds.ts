// Plan 02.1-37 (UAT-NOTES.md §5.13) — defensive filter for raw query-param
// `kind` values. Used by /feed loader to drop unknown kinds BEFORE they reach
// Drizzle's `inArray(events.kind, [...])` clause. Without this gate, a
// malformed URL like /feed?kind=foo would surface as a Postgres 500 (unknown
// enum value); silent drop matches the existing /feed?show=foo malformed-param
// fallback behavior in src/routes/feed/+page.server.ts.
//
// VALID_EVENT_KINDS is imported from the events service so service + route +
// page-loader all share one source of truth (defense-in-depth Pitfall 6).

import { VALID_EVENT_KINDS } from "$lib/server/services/events.js";
import type { EventKind } from "$lib/server/integrations/data-source-adapter.js";

export function filterValidKinds(raw: string[]): EventKind[] {
  return raw.filter((k): k is EventKind => (VALID_EVENT_KINDS as readonly string[]).includes(k));
}
