// Shared SQL lane worker for adapter-owned refresh queues.
//
// `createAdapterBatchLaneWorker` is the single factory every adapter
// uses. Each tick claims up to `maxBatchSize` rows from a lane and
// dispatches them together. `maxBatchSize` can be a number (uniform
// across lanes — YouTube's videos.list always takes ≤50 ids) or a
// per-lane record (Reddit's post lanes batch up to 100 via /api/info
// while listing lanes stay at 1 because each row needs its own
// endpoint).
//
// A previous `createAdapterLaneWorker` (single-row factory, retired
// in Phase 03.1) was a duplicate of the batch factory with the
// implicit constraint maxBatchSize=1; the per-lane batch shape covers
// both cases by setting the lane to 1 when no batching is appropriate.
//
// The factory owns common lifecycle and retry behavior over
// adapter_refresh_queue; adapters own lane names, payload shape,
// dispatch, and optional claim gates. `claimGate` runs inside the
// claim transaction before attempts/status are touched. That is the
// load-bearing extension for DB-backed global limits: a denied gate
// leaves the row pending and does not burn attempts.

import { sql } from "drizzle-orm";
import { db, type Tx } from "../db/client.js";
import { logger } from "../logger.js";
import { AdapterError } from "$lib/sources/errors.js";

export interface AdapterLaneWorkerRow {
  id: number;
  adapterKind: string;
  queueName: string;
  type: string;
  payload: Record<string, unknown>;
  userId: string | null;
  attempts: number;
}

export interface AdapterLaneWorkerTickResult {
  processedQueue: string | null;
  processedType: string | null;
  processedId: number | null;
}

export interface AdapterLaneWorkerRetryContext<TLane extends string> {
  queueName: TLane;
  type: string;
  id: number;
  attempts: number;
  error: unknown;
}

export type AdapterLaneGuardResult =
  | { action: "run" }
  | { action: "defer"; retryAfterMs: number; reason: string };

export interface AdapterLaneGuardContext<TLane extends string> {
  queueName: TLane;
  rows: readonly AdapterLaneWorkerRow[];
  now: Date;
}

export type AdapterLaneClaimGateResult<TPermit = unknown> =
  | { action: "run"; permit?: TPermit }
  | { action: "defer"; retryAfterMs: number; reason: string };

export interface AdapterLaneClaimGateContext<TLane extends string> {
  adapterKind: string;
  queueName: TLane;
  rows: readonly AdapterLaneWorkerRow[];
  now: Date;
  // tryClaimAndDispatch always invokes claimGate inside an open
  // transaction (FOR UPDATE SKIP LOCKED has already pinned the row),
  // so the gate sees a real Tx, not a top-level db handle. Narrow type
  // makes that contract explicit.
  tx: Tx;
}

export interface AdapterLaneDispatchContext<TPermit = unknown> {
  permit?: TPermit;
}

export type AdapterBatchScope = "global" | "user";

export interface AdapterBatchLaneWorkerTickResult {
  processedQueue: string | null;
  processedTypes: string[];
  processedIds: number[];
}

export interface AdapterBatchLaneWorkerPolicy<TLane extends string, TPermit = unknown> {
  adapterKind: string;
  slots: readonly TLane[];
  fallthrough: readonly TLane[];
  maxAttempts: number;
  /** Max rows claimed per tick.
   *
   *  - `number`: applies to ALL lanes uniformly (the common case;
   *    YouTube videos.list takes ≤50 IDs regardless of lane).
   *  - `Partial<Record<Lane, number>>`: per-lane limits, used when
   *    different lanes call different upstream endpoints with different
   *    batch tolerances. Reddit's `service_post`/`user_post` lanes can
   *    claim 100 (one `/api/info` call), but `service_source`/
   *    `user_source` MUST stay at 1 because each row needs its own
   *    `/r/<sub>/new.json` or `/user/<h>/submitted.json` listing fetch
   *    and a single tick only acquires one pacer slot.
   *
   *  Lanes not present in the record default to 1 (no batching).
   *  Every value must be a positive integer. */
  maxBatchSize: number | Partial<Record<TLane, number>>;
  /** Batch claim strategy.
   *
   *  - "global": claim rows across users inside the same lane. Use when the
   *    upstream API supports multi-resource requests and one request can
   *    safely serve multiple tenants. Tenant fairness must be enforced before
   *    enqueue via cooldown/cap gates. YouTube user_video uses this so up to
   *    50 videos can share one videos.list quota unit.
   *  - "user": claim only rows with the first row's user_id. Use when the
   *    upstream request identity is tenant-bound, such as per-user OAuth
   *    tokens or APIs where one request cannot mix tenants. */
  batchScope: AdapterBatchScope;
  staleProcessingMs: number;
  staleRecoveryIntervalMs: number;
  retryBackoffMs?(ctx: AdapterLaneWorkerRetryContext<TLane>): number;
  claimGate?(ctx: AdapterLaneClaimGateContext<TLane>): Promise<AdapterLaneClaimGateResult<TPermit>>;
  guardDispatch?(ctx: AdapterLaneGuardContext<TLane>): Promise<AdapterLaneGuardResult>;
  dispatch(rows: AdapterLaneWorkerRow[], ctx: AdapterLaneDispatchContext<TPermit>): Promise<void>;
  emitDrained?(stats: { queueName: TLane; entriesProcessed: number; durationMs: number }): void;
}

export interface AdapterBatchLaneWorker {
  tick(): Promise<AdapterBatchLaneWorkerTickResult>;
  resetForTest(): void;
  setSlotForTest(slotIndex: number): void;
}

interface ClaimedRow {
  id: number;
  adapter_kind: string;
  type: string;
  payload: Record<string, unknown>;
  user_id: string | null;
  attempts: number;
}

const ADAPTER_REFRESH_QUEUE_TABLE = "adapter_refresh_queue";

export function adapterRefreshQueueLabel(adapterKind: string, queueName: string): string {
  assertNonEmptyString("adapterKind", adapterKind);
  assertNonEmptyString("queueName", queueName);
  return `${ADAPTER_REFRESH_QUEUE_TABLE}:${adapterKind}:${queueName}`;
}

function defaultRetryBackoffMs(attempts: number): number {
  return Math.min(5 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1));
}

/** Resolve the effective batch size for a specific lane.
 *
 *  - When `maxBatchSize` is a number → that's the limit for every lane.
 *  - When it's a record → look up the lane; unmapped lanes default to 1
 *    (no batching, single-row tick). Default-to-1 makes "I forgot to
 *    declare batch size for this lane" the safe behavior — at worst the
 *    lane processes one row at a time, never claiming more than the
 *    pacer/quota can support.
 */
function resolveMaxBatchSizeForLane<TLane extends string>(
  maxBatchSize: number | Partial<Record<TLane, number>>,
  lane: TLane,
): number {
  if (typeof maxBatchSize === "number") return maxBatchSize;
  return maxBatchSize[lane] ?? 1;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertNonEmptyString(name: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`${name} must not be empty`);
  }
}

function validateLaneShape<TLane extends string>(policy: {
  adapterKind: string;
  slots: readonly TLane[];
  fallthrough: readonly TLane[];
}): void {
  assertNonEmptyString("adapterKind", policy.adapterKind);
  if (policy.slots.length === 0) {
    throw new Error("slots must contain at least one lane");
  }
  if (policy.fallthrough.length === 0) {
    throw new Error("fallthrough must contain at least one lane");
  }
  const slotLanes = new Set(policy.slots);
  const fallthroughLanes = new Set(policy.fallthrough);
  if (fallthroughLanes.size !== policy.fallthrough.length) {
    throw new Error("fallthrough lanes must be unique");
  }
  for (const lane of fallthroughLanes) {
    if (!slotLanes.has(lane)) {
      throw new Error(`fallthrough lane '${lane}' is not present in slots`);
    }
  }
  for (const lane of slotLanes) {
    if (!fallthroughLanes.has(lane)) {
      throw new Error(`slot lane '${lane}' is missing from fallthrough`);
    }
  }
}

function validateBatchLaneWorkerPolicy<TLane extends string>(
  policy: AdapterBatchLaneWorkerPolicy<TLane>,
): void {
  validateLaneShape(policy);
  assertPositiveInteger("maxAttempts", policy.maxAttempts);
  if (typeof policy.maxBatchSize === "number") {
    assertPositiveInteger("maxBatchSize", policy.maxBatchSize);
  } else {
    const slotLanes = new Set(policy.slots);
    for (const [lane, value] of Object.entries(policy.maxBatchSize)) {
      if (!slotLanes.has(lane as TLane)) {
        throw new Error(`maxBatchSize record contains lane '${lane}' not present in slots`);
      }
      assertPositiveInteger(`maxBatchSize[${lane}]`, value as number);
    }
  }
  assertPositiveInteger("staleProcessingMs", policy.staleProcessingMs);
  assertPositiveInteger("staleRecoveryIntervalMs", policy.staleRecoveryIntervalMs);
}

function retryDelayMs<TLane extends string>(
  policy: {
    retryBackoffMs?(ctx: AdapterLaneWorkerRetryContext<TLane>): number;
  },
  ctx: AdapterLaneWorkerRetryContext<TLane>,
): number {
  if (ctx.error instanceof AdapterError && ctx.error.retryAfterMs !== null) {
    return ctx.error.retryAfterMs;
  }
  return policy.retryBackoffMs?.(ctx) ?? defaultRetryBackoffMs(ctx.attempts);
}

async function deferRows(
  rows: readonly AdapterLaneWorkerRow[],
  retryAfterMs: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const row of rows) {
      await tx.execute(sql`
        UPDATE ${sql.raw(ADAPTER_REFRESH_QUEUE_TABLE)}
        SET status = 'pending',
            attempts = ${row.attempts},
            next_attempt_at = NOW() + (${retryAfterMs} || ' milliseconds')::interval
        WHERE id = ${row.id}
          AND adapter_kind = ${row.adapterKind}
      `);
    }
  });
}

export function createAdapterBatchLaneWorker<TLane extends string, TPermit = unknown>(
  policy: AdapterBatchLaneWorkerPolicy<TLane, TPermit>,
): AdapterBatchLaneWorker {
  validateBatchLaneWorkerPolicy(policy);
  let tickCounter = 0;
  let nextStaleRecoveryAt = 0;

  async function runStaleRecovery(now: number): Promise<void> {
    if (now < nextStaleRecoveryAt) return;
    const staleSince = new Date(now - policy.staleProcessingMs);
    await db.execute(sql`
      UPDATE ${sql.raw(ADAPTER_REFRESH_QUEUE_TABLE)}
      SET status = 'pending'
      WHERE status = 'processing'
        AND adapter_kind = ${policy.adapterKind}
        AND last_attempt_at < ${staleSince}
    `);
    nextStaleRecoveryAt = now + policy.staleRecoveryIntervalMs;
  }

  async function tryClaimAndDispatch(
    queueName: TLane,
  ): Promise<
    | { kind: "none" }
    | { kind: "gated"; retryAfterMs: number; reason: string }
    | { kind: "claimed"; rows: AdapterLaneWorkerRow[]; dispatched: boolean }
  > {
    const claim = await db.transaction(async (tx) => {
      const firstResult = await tx.execute(sql`
        SELECT id, adapter_kind, type, payload, user_id, attempts
        FROM ${sql.raw(ADAPTER_REFRESH_QUEUE_TABLE)}
        WHERE adapter_kind = ${policy.adapterKind}
          AND queue_name = ${queueName}
          AND status = 'pending'
          AND next_attempt_at <= NOW()
        ORDER BY priority ASC, next_attempt_at ASC, enqueued_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
      const firstQuery = firstResult as unknown as {
        rows?: Array<Omit<ClaimedRow, "id"> & { id: number | string }>;
      };
      const firstRaw = firstQuery.rows?.[0];
      if (!firstRaw) return { status: "empty" as const };

      const first: ClaimedRow = { ...firstRaw, id: Number(firstRaw.id) };
      const batch: ClaimedRow[] = [first];
      const laneMaxBatch = resolveMaxBatchSizeForLane(policy.maxBatchSize, queueName);
      if (laneMaxBatch > 1) {
        const userFilter =
          policy.batchScope === "user"
            ? sql`AND user_id IS NOT DISTINCT FROM ${first.user_id}`
            : sql``;
        const restResult = await tx.execute(sql`
          SELECT id, adapter_kind, type, payload, user_id, attempts
          FROM ${sql.raw(ADAPTER_REFRESH_QUEUE_TABLE)}
          WHERE adapter_kind = ${policy.adapterKind}
            AND queue_name = ${queueName}
            AND status = 'pending'
            AND next_attempt_at <= NOW()
            ${userFilter}
            AND id <> ${first.id}
          ORDER BY priority ASC, next_attempt_at ASC, enqueued_at ASC
          LIMIT ${laneMaxBatch - 1}
          FOR UPDATE SKIP LOCKED
        `);
        const restQuery = restResult as unknown as {
          rows?: Array<Omit<ClaimedRow, "id"> & { id: number | string }>;
        };
        for (const raw of restQuery.rows ?? []) {
          batch.push({ ...raw, id: Number(raw.id) });
        }
      }

      const normalized = batch.map((row) => ({
        id: row.id,
        adapterKind: row.adapter_kind,
        queueName,
        type: row.type,
        payload: row.payload,
        userId: row.user_id,
        attempts: row.attempts,
      }));
      let gate: AdapterLaneClaimGateResult<TPermit> | undefined;
      try {
        gate = await policy.claimGate?.({
          adapterKind: policy.adapterKind,
          queueName,
          rows: normalized,
          now: new Date(),
          tx,
        });
      } catch (err) {
        const ids = batch.map((row) => row.id);
        const retryAfterMs = defaultRetryBackoffMs(1);
        await tx.execute(sql`
          UPDATE ${sql.raw(ADAPTER_REFRESH_QUEUE_TABLE)}
          SET next_attempt_at = NOW() + (${retryAfterMs} || ' milliseconds')::interval
          WHERE adapter_kind = ${policy.adapterKind}
            AND id IN (${sql.join(ids, sql`, `)})
        `);
        logger.warn(
          {
            adapter: policy.adapterKind,
            queueName,
            ids,
            retryAfterMs,
            err: String((err as Error)?.message ?? err),
          },
          "adapter batch lane worker: claim gate failed; claim deferred",
        );
        return {
          status: "gated" as const,
          retryAfterMs,
          reason: "claim_gate_error",
        };
      }
      if (gate?.action === "defer") {
        const ids = batch.map((row) => row.id);
        await tx.execute(sql`
          UPDATE ${sql.raw(ADAPTER_REFRESH_QUEUE_TABLE)}
          SET next_attempt_at = NOW() + (${gate.retryAfterMs} || ' milliseconds')::interval
          WHERE adapter_kind = ${policy.adapterKind}
            AND id IN (${sql.join(ids, sql`, `)})
        `);
        return {
          status: "gated" as const,
          retryAfterMs: gate.retryAfterMs,
          reason: gate.reason,
        };
      }

      const ids = batch.map((row) => row.id);
      await tx.execute(sql`
        UPDATE ${sql.raw(ADAPTER_REFRESH_QUEUE_TABLE)}
        SET status = 'processing',
            last_attempt_at = NOW(),
            attempts = attempts + 1
        WHERE adapter_kind = ${policy.adapterKind}
          AND id IN (${sql.join(ids, sql`, `)})
      `);
      return { status: "claimed" as const, rows: batch, permit: gate?.permit };
    });

    if (claim.status === "empty") return { kind: "none" };
    if (claim.status === "gated") {
      return { kind: "gated", retryAfterMs: claim.retryAfterMs, reason: claim.reason };
    }
    const rows = claim.rows;
    const normalized = rows.map((row) => ({
      id: row.id,
      adapterKind: row.adapter_kind,
      queueName,
      type: row.type,
      payload: row.payload,
      userId: row.user_id,
      attempts: row.attempts,
    }));

    let guard: AdapterLaneGuardResult | undefined;
    try {
      guard = await policy.guardDispatch?.({
        queueName,
        rows: normalized,
        now: new Date(),
      });
    } catch (err) {
      const retryAfterMs = defaultRetryBackoffMs(1);
      await deferRows(normalized, retryAfterMs);
      logger.warn(
        {
          adapter: policy.adapterKind,
          queueName,
          ids: normalized.map((row) => row.id),
          retryAfterMs,
          err: String((err as Error)?.message ?? err),
        },
        "adapter batch lane worker: guard failed; dispatch deferred",
      );
      return { kind: "claimed", rows: normalized, dispatched: false };
    }
    if (guard?.action === "defer") {
      await deferRows(normalized, guard.retryAfterMs);
      logger.info(
        {
          adapter: policy.adapterKind,
          queueName,
          ids: normalized.map((row) => row.id),
          retryAfterMs: guard.retryAfterMs,
          reason: guard.reason,
        },
        "adapter batch lane worker: dispatch deferred by guard",
      );
      return { kind: "claimed", rows: normalized, dispatched: false };
    }

    try {
      await policy.dispatch(normalized, { permit: claim.permit });
      const ids = normalized.map((row) => row.id);
      await db.execute(
        sql`UPDATE ${sql.raw(ADAPTER_REFRESH_QUEUE_TABLE)} SET status = 'done' WHERE adapter_kind = ${policy.adapterKind} AND id IN (${sql.join(ids, sql`, `)})`,
      );
    } catch (err) {
      const isPermanent =
        err instanceof AdapterError &&
        (err.category === "permanent" || err.category === "not-found");
      for (const row of normalized) {
        const newAttempts = row.attempts + 1;
        if (isPermanent || newAttempts >= policy.maxAttempts) {
          await db.execute(
            sql`UPDATE ${sql.raw(ADAPTER_REFRESH_QUEUE_TABLE)} SET status = 'dead_letter' WHERE id = ${row.id} AND adapter_kind = ${policy.adapterKind}`,
          );
        } else {
          const retryAfterMs = retryDelayMs(policy, {
            queueName,
            type: row.type,
            id: row.id,
            attempts: newAttempts,
            error: err,
          });
          await db.execute(sql`
            UPDATE ${sql.raw(ADAPTER_REFRESH_QUEUE_TABLE)}
            SET status = 'pending',
                next_attempt_at = NOW() + (${retryAfterMs} || ' milliseconds')::interval
            WHERE id = ${row.id}
              AND adapter_kind = ${policy.adapterKind}
          `);
        }
      }
      logger.warn(
        {
          adapter: policy.adapterKind,
          queueName,
          ids: normalized.map((row) => row.id),
          category: err instanceof AdapterError ? err.category : "non-adapter",
          err: String((err as Error)?.message ?? err),
        },
        "adapter batch lane worker: handler failed",
      );
    }

    return { kind: "claimed", rows: normalized, dispatched: true };
  }

  return {
    async tick(): Promise<AdapterBatchLaneWorkerTickResult> {
      await runStaleRecovery(Date.now());

      const tickStartMs = Date.now();
      const slot = policy.slots[tickCounter]!;
      tickCounter = (tickCounter + 1) % policy.slots.length;
      const queueOrder = [slot, ...policy.fallthrough.filter((q) => q !== slot)];

      for (const queueName of queueOrder) {
        const claimed = await tryClaimAndDispatch(queueName);
        if (claimed.kind === "gated") {
          logger.debug(
            {
              adapter: policy.adapterKind,
              queueName,
              retryAfterMs: claimed.retryAfterMs,
              reason: claimed.reason,
            },
            "adapter batch lane worker: claim gate deferred tick",
          );
          return { processedQueue: null, processedTypes: [], processedIds: [] };
        }
        if (claimed.kind === "claimed") {
          if (claimed.dispatched) {
            policy.emitDrained?.({
              queueName,
              entriesProcessed: claimed.rows.length,
              durationMs: Date.now() - tickStartMs,
            });
          }
          return {
            processedQueue: queueName,
            processedTypes: claimed.rows.map((row) => row.type),
            processedIds: claimed.rows.map((row) => row.id),
          };
        }
      }

      return { processedQueue: null, processedTypes: [], processedIds: [] };
    },
    resetForTest(): void {
      tickCounter = 0;
      nextStaleRecoveryAt = 0;
    },
    setSlotForTest(slotIndex: number): void {
      tickCounter = slotIndex;
    },
  };
}
