// Reddit service-sources enqueue cron handler.
//
// Schedule: 0/6/12/18 UTC daily — 4 ticks per day.
//
// SCANS data_sources for every reddit_account / reddit_subreddit row
// with auto_import=true AND deleted_at IS NULL, then INSERTS one row
// per source into adapter_refresh_queue:
//   - queue_name = 'service_source'
//   - type       = 'author_poll' (reddit_account) | 'sub_poll' (reddit_subreddit)
//   - payload    = { handle: <username> } | { sub: <subreddit> }
//   - user_id    = NULL  (cron-lane marker; user-driven enqueues set it)
//   - priority   = 0
//
// ZERO Reddit HTTP here — pure DB enqueue. The 8-tick worker drains
// the queue at the 8 req/min ceiling.
//
// Cross-tenant by design: the SELECT walks every user's sources to
// enqueue one service-pool job per source. Per-source tenant identity
// is preserved inside the worker handler when it fans out events
// INSERTs.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { adapterRefreshQueue } from "$lib/server/db/schema/index.js";
import { logger } from "$lib/server/logger.js";
import {
  markSourceNeedsReconnect,
  clearNeedsReconnect,
} from "$lib/server/services/data-sources.js";

interface RedditSourceMetadata {
  username?: string;
  subreddit?: string;
}

export async function handleEnqueueServiceSourcesCron(): Promise<{ enqueued: number }> {
  // Cross-tenant SELECT — scheduler fan-out. The reddit-source set is
  // the full set of registered reddit_account + reddit_subreddit rows.
  // Each yields one queue row processed under the operator's worker
  // budget; the per-source fan-out to subscribers happens inside the
  // worker handlers (sub_poll, author_poll).
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- channel-scoped fan-out: cron picks across tenants by design
  const sources = await db
    .select({
      id: dataSources.id,
      userId: dataSources.userId,
      kind: dataSources.kind,
      metadata: dataSources.metadata,
      channelId: dataSources.channelId,
      needsReconnect: dataSources.needsReconnect,
      lastErrorKind: dataSources.lastErrorKind,
    })
    .from(dataSources)
    .where(
      and(
        sql`${dataSources.kind} IN ('reddit_account', 'reddit_subreddit')`,
        eq(dataSources.autoImport, true),
        isNull(dataSources.deletedAt),
      ),
    );

  if (sources.length === 0) {
    logger.info({ kind: "reddit" }, "reddit.enqueue_service_sources_cron: no sources to enqueue");
    return { enqueued: 0 };
  }

  // Build one queue row per source. Drop rows whose metadata is missing
  // the expected handle field — those are seed-data bugs (local dev
  // seeder, broken import) that the user must intervene on. They never
  // resolve themselves: every cron tick re-skips the same row forever.
  // Mark needs_reconnect on the source so /sources surfaces an
  // 'Error: Setup' pill — same UI affordance as a remote 404. The user
  // can either fix the metadata (Reconnect → edit handle URL) or delete
  // the source. Wrapped in try/catch because a single source's UPDATE
  // failure must not abort the cron tick for every other source.
  const values: Array<typeof adapterRefreshQueue.$inferInsert> = [];
  // B-2: track sources whose metadata is valid AND were currently flagged
  // with needs_reconnect=true / operator-issue (the only error category
  // this cron itself sets). Producing a valid queue row IS the recovery
  // signal — the operator-issue was "missing handle/sub metadata" and
  // that's now resolved. Cleared once after the bulk INSERT succeeds, so
  // a thrown enqueue doesn't prematurely declare recovery.
  const recoveredSourceIds: Array<{ userId: string; id: string }> = [];
  for (const s of sources) {
    const meta = (s.metadata ?? {}) as RedditSourceMetadata;
    if (s.kind === "reddit_account") {
      const handle = meta.username ?? s.channelId ?? null;
      if (handle === null) {
        // B-3: short-circuit — if this source is already flagged with the
        // same operator-issue kind, the UPDATE is a no-op write that
        // bumps updated_at on every tick (4×/day forever). Skip when the
        // current state already matches what we'd write.
        const alreadyFlagged = s.needsReconnect === true && s.lastErrorKind === "operator-issue";
        if (alreadyFlagged) {
          continue;
        }
        logger.warn(
          { sourceId: s.id, kind: s.kind },
          "reddit.enqueue_service_sources_cron: reddit_account missing username; skipping + marking needs_reconnect",
        );
        try {
          await markSourceNeedsReconnect(s.userId, s.id, "operator-issue");
        } catch (err) {
          logger.warn(
            { sourceId: s.id, err: String((err as Error)?.message ?? err) },
            "reddit.enqueue_service_sources_cron: markSourceNeedsReconnect failed for reddit_account; continuing",
          );
        }
        continue;
      }
      values.push({
        adapterKind: "reddit_account",
        queueName: "service_source",
        type: "author_poll",
        payload: { handle },
        userId: null,
        priority: 0,
      });
      if (s.needsReconnect === true && s.lastErrorKind === "operator-issue") {
        recoveredSourceIds.push({ userId: s.userId, id: s.id });
      }
    } else if (s.kind === "reddit_subreddit") {
      const sub = meta.subreddit ?? s.channelId ?? null;
      if (sub === null) {
        // B-3: short-circuit — see reddit_account branch above.
        const alreadyFlagged = s.needsReconnect === true && s.lastErrorKind === "operator-issue";
        if (alreadyFlagged) {
          continue;
        }
        logger.warn(
          { sourceId: s.id, kind: s.kind },
          "reddit.enqueue_service_sources_cron: reddit_subreddit missing subreddit; skipping + marking needs_reconnect",
        );
        try {
          await markSourceNeedsReconnect(s.userId, s.id, "operator-issue");
        } catch (err) {
          logger.warn(
            { sourceId: s.id, err: String((err as Error)?.message ?? err) },
            "reddit.enqueue_service_sources_cron: markSourceNeedsReconnect failed for reddit_subreddit; continuing",
          );
        }
        continue;
      }
      values.push({
        adapterKind: "reddit_account",
        queueName: "service_source",
        type: "sub_poll",
        payload: { sub },
        userId: null,
        priority: 0,
      });
      if (s.needsReconnect === true && s.lastErrorKind === "operator-issue") {
        recoveredSourceIds.push({ userId: s.userId, id: s.id });
      }
    }
  }

  if (values.length === 0) {
    return { enqueued: 0 };
  }

  // Dedup via atomic INSERT … SELECT … WHERE NOT EXISTS — no read-then-
  // insert race window (a second cron instance, or a user-driven
  // backfill, cannot slip a duplicate in between our snapshot and our
  // bulk INSERT). Single statement; ~milliseconds for hundreds of rows.
  // Each candidate's existence-check is keyed on (queue_name, type,
  // payload identifier); identifier comes from payload->>'handle' for
  // author_poll and payload->>'sub' for sub_poll.
  //
  // Under singleton-cron + batchSize=1 the previous read-then-insert
  // pattern was also safe in practice, but the atomic form is the
  // correct shape — one place to reason about, no implicit invariant
  // about cron parallelism.
  const insertedRows = await atomicallyInsertNonDuplicates(values);
  const skipped = values.length - insertedRows;

  // B-2: clear needs_reconnect on sources whose metadata is now valid AND
  // were previously flagged operator-issue by this cron. Idempotent
  // (clearNeedsReconnect filters WHERE needs_reconnect=true). Runs even
  // when insertedRows=0 — dedup means the queue row may already be pending
  // from a prior tick; the recovery state is the source row, not the queue.
  for (const r of recoveredSourceIds) {
    try {
      await clearNeedsReconnect(r.userId, r.id);
    } catch (err) {
      logger.warn(
        { sourceId: r.id, userId: r.userId, err: String((err as Error)?.message ?? err) },
        "reddit.enqueue_service_sources_cron: clearNeedsReconnect failed; continuing",
      );
    }
  }

  if (insertedRows === 0) {
    logger.info(
      { skipped, recovered: recoveredSourceIds.length },
      "reddit.enqueue_service_sources_cron: all candidates already pending; tick is a no-op",
    );
    return { enqueued: 0 };
  }
  logger.info(
    {
      enqueued: insertedRows,
      skipped,
      sourcesScanned: sources.length,
      recovered: recoveredSourceIds.length,
    },
    "reddit.enqueue_service_sources_cron: tick complete",
  );
  return { enqueued: insertedRows };
}

/** Atomically INSERT candidates that aren't already pending/processing
 *  on the queue. Returns the count of rows actually inserted.
 *
 *  Implementation: two batch INSERTs (one per `type`), each driven by
 *  `unnest($1::text[])` over the identifier array. Postgres evaluates
 *  the per-row `NOT EXISTS` once per candidate inside the same
 *  statement — atomically, no read-then-insert race window. Replaces
 *  the prior per-candidate loop (N round-trips at indie scale was fine;
 *  at 500+ sources the round-trip overhead becomes the dominant cost
 *  of every cron tick).
 *
 *  Identifier key is `payload->>'handle'` for author_poll and
 *  `payload->>'sub'` for sub_poll — these are the only two `type`
 *  values this cron emits, so the type→key map is local + exhaustive. */
async function atomicallyInsertNonDuplicates(
  candidates: Array<typeof adapterRefreshQueue.$inferInsert>,
): Promise<number> {
  // De-duplicate within the input batch via Set. Two users subscribing
  // to the same subreddit (both auto_import=true) generate two
  // candidates with the same identifier. The walker fan-out treats one
  // queue row as serving every subscriber for the same lookup key (the
  // cache row is cross-tenant), so a single queue row is the correct
  // outcome. The OLD per-row loop got this right by accident — each
  // INSERT was its own statement, so the second row's NOT EXISTS saw
  // the first row already pending and skipped it. The batched INSERT
  // evaluates NOT EXISTS against pre-statement state for every row, so
  // duplicates within the input array would BOTH pass. Set dedup
  // restores the prior semantics.
  const handles = new Set<string>();
  const subs = new Set<string>();
  for (const row of candidates) {
    const payload = row.payload as { handle?: string; sub?: string };
    if (row.type === "author_poll" && payload.handle !== undefined) {
      handles.add(payload.handle);
    } else if (row.type === "sub_poll" && payload.sub !== undefined) {
      subs.add(payload.sub);
    }
  }

  let inserted = 0;
  if (handles.size > 0) {
    inserted += await insertNonDuplicateBatch("author_poll", "handle", [...handles]);
  }
  if (subs.size > 0) {
    inserted += await insertNonDuplicateBatch("sub_poll", "sub", [...subs]);
  }
  return inserted;
}

/** Single-statement bulk INSERT for one (type, identifier-key) pair.
 *  `VALUES (...)` projects the identifier array as rows; each row builds
 *  its own jsonb payload and checks `NOT EXISTS` against the queue.
 *  Returns RETURNING id rowcount.
 *
 *  Why VALUES + sql.join over `unnest($ids::text[])`: drizzle 0.45
 *  serializes the JS array parameter via the pg driver, which encodes
 *  it as a JSON-shaped parameter rather than the native pg array
 *  format. The downstream `::text[]` cast then fails with 42846. And
 *  `jsonb_build_object($key, value)` can't infer $key's type (variadic
 *  "any") so we'd hit 42P18 separately. Inline VALUES (one parameter
 *  per identifier) sidesteps both: each identifier is its own text-
 *  inferred parameter, and the payloadKey is cast explicitly to text. */
async function insertNonDuplicateBatch(
  type: "author_poll" | "sub_poll",
  payloadKey: "handle" | "sub",
  identifiers: string[],
): Promise<number> {
  const valuesList = identifiers.map((id) => sql`(${id})`);
  const result = await db.execute<{ id: number }>(sql`
    INSERT INTO adapter_refresh_queue
      (adapter_kind, queue_name, type, payload, user_id, priority)
    SELECT 'reddit_account', 'service_source', ${type},
           jsonb_build_object(${payloadKey}::text, c.identifier), NULL, 0
    FROM (VALUES ${sql.join(valuesList, sql`, `)}) AS c(identifier)
    WHERE NOT EXISTS (
      SELECT 1 FROM adapter_refresh_queue
      WHERE adapter_kind = 'reddit_account'
        AND queue_name = 'service_source'
        AND type = ${type}
        AND payload->>${payloadKey}::text = c.identifier
        AND status IN ('pending', 'processing')
    )
    RETURNING id
  `);
  const rows = (result as unknown as { rows?: Array<{ id: number }> }).rows ?? [];
  return rows.length;
}
