// YouTube credentials wrapper — Phase 03.0.1 Plan 08 (D-06).
//
// The adapter HTTP wrapper (./http.ts chargedFetch) and the worker handlers
// that pre-pick a key (poll-active / poll-cold / poll-user / rehab-unavailable
// / channel-context-backfill) call pickCredentials(ctx) instead of
// pickKeyForJob() directly. This keeps the credential-picking decision
// behind a single contract surface so Phase 6 can add per-user credential
// override (D-05 future) by extending THIS file rather than touching every
// caller.
//
// Today (v0.1, post-Plan-08):
//   - ctx.userId is informational only — operator keys are picked from
//     env.SERVICE_YOUTUBE_API_KEYS via round-robin (./quota.ts.pickKeyForJob).
//   - ctx.origin distinguishes cron vs user pools at the rate-limit
//     reservoir layer (./http.ts) but does NOT change WHICH key is picked
//     (operator keys are pooled, not split by origin).
//
// Phase 6+ (per-user credentials, D-05 unblock):
//   - Check for a per-user override row (users may bring their own YouTube
//     API key for higher quotas / privacy parity with self-host).
//   - Fall back to operator keys if no override exists.
//   - Single edit point: this function. Cross-source code (worker handlers,
//     scheduler, /admin/quota) is unaffected.
//
// Rationale (D-06 encapsulation): without this wrapper, every caller would
// either (a) call pickKeyForJob() directly today and need an edit in Phase 6
// to thread userId through, OR (b) take an early dependency on per-user
// override code that doesn't exist yet. The wrapper makes today's
// behavior explicit ("operator keys only — see callers' usage") and keeps
// the future migration path local.

import type { AdapterContext } from "$lib/sources/adapter.js";
import { pickKeyForJob, type PickedKey } from "./quota.js";

/**
 * D-06 wrapper around pickKeyForJob. v0.1: operator keys only, ctx is
 * informational. Returns null when env.SERVICE_YOUTUBE_API_KEYS is empty
 * (smoke parity / self-hoster who never configured keys — graceful no-op
 * at the call site).
 *
 * Synchronous-under-the-hood today (pickKeyForJob is sync); the async
 * signature future-proofs Phase 6's per-user override which will need a
 * DB lookup.
 */
export async function pickCredentials(_ctx: AdapterContext): Promise<PickedKey | null> {
  // v0.1: operator keys only. Phase 6 will add a per-user override branch
  // here that consults a future api_keys_youtube table — that's where the
  // async signature pays off (DB lookup); today the await resolves
  // immediately around the synchronous pickKeyForJob.
  return Promise.resolve(pickKeyForJob());
}
