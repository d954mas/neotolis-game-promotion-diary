// YouTube credentials wrapper.
//
// The adapter HTTP wrapper (./http.ts chargedFetch) and the worker
// handlers that pre-pick a key (poll-active / poll-cold / poll-user /
// rehab-unavailable / channel-context-backfill) call pickCredentials(ctx)
// instead of pickKeyForJob() directly. This keeps the credential-picking
// decision behind a single contract surface so a future per-user
// credential override can extend THIS file rather than touching every
// caller.
//
// Today:
//   - ctx.userId is informational only — operator keys are picked from
//     env.SERVICE_YOUTUBE_API_KEYS via round-robin
//     (./quota.ts.pickKeyForJob).
//   - ctx.origin distinguishes cron vs user pools at the rate-limit
//     reservoir layer (./http.ts) but does NOT change WHICH key is picked
//     (operator keys are pooled, not split by origin).
//
// Future per-user credentials:
//   - Check for a per-user override row (users may bring their own
//     YouTube API key for higher quotas / privacy parity with self-host).
//   - Fall back to operator keys if no override exists.
//   - Single edit point: this function. Cross-source code (worker
//     handlers, scheduler, /admin/quota) is unaffected.
//
// Without this wrapper, every caller would either (a) call pickKeyForJob()
// directly today and need an edit later to thread userId through, OR (b)
// take an early dependency on per-user override code that doesn't exist
// yet. The wrapper makes today's behavior explicit ("operator keys only
// — see callers' usage") and keeps the future migration path local.

import type { AdapterContext } from "$lib/sources/adapter.js";
import { pickKeyForJob, type PickedKey } from "./quota.js";

/**
 * Wrapper around pickKeyForJob. Today: operator keys only, ctx is
 * informational. Returns null when env.SERVICE_YOUTUBE_API_KEYS is empty
 * (smoke parity / self-hoster who never configured keys — graceful no-op
 * at the call site).
 *
 * Synchronous-under-the-hood today (pickKeyForJob is sync); the async
 * signature future-proofs a per-user override which will need a DB
 * lookup.
 */
export async function pickCredentials(_ctx: AdapterContext): Promise<PickedKey | null> {
  // Operator keys only. A future per-user override branch here would
  // consult an api_keys_youtube table — that's where the async signature
  // pays off (DB lookup); today the await resolves immediately around
  // the synchronous pickKeyForJob.
  return Promise.resolve(pickKeyForJob());
}
