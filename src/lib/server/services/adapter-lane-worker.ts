// Shared SQL lane workers for adapter-owned refresh queues.
//
// Use `createAdapterLaneWorker` when one queue row maps to one upstream
// request. Use `createAdapterBatchLaneWorker` when one upstream request can
// process several rows from the same lane, such as YouTube videos.list.
//
// The worker owns common lifecycle and retry behavior over
// adapter_refresh_queue; adapters own lane names, payload shape, dispatch,
// and optional claim gates. `claimGate` runs inside the claim transaction
// before attempts/status are touched. That is the load-bearing extension for
// DB-backed global limits: a denied gate leaves the row pending and does not
// burn attempts.

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

export interface AdapterLaneWorkerPolicy<TLane extends string, TPermit = unknown> {
  adapterKind: string;
  slots: readonly TLane[];
  fallthrough: readonly TLane[];
  maxAttempts: number;
  staleProcessingMs: number;
  staleRecoveryIntervalMs: number;
  retryBackoffMs?(ctx: AdapterLaneWorkerRetryContext<TLane>): number;
  claimGate?(ctx: AdapterLaneClaimGateContext<TLane>): Promise<AdapterLaneClaimGateResult<TPermit>>;
  guardDispatch?(ctx: AdapterLaneGuardContext<TLane>): Promise<AdapterLaneGuardResult>;
  dispatch(row: AdapterLaneWorkerRow, ctx: AdapterLaneDispatchContext<TPermit>): Promise<void>;
  emitDrained?(stats: { queueName: TLane; entriesProcessed: number; durationMs: number }): void;
}

export type AdapterBatchScope = "global" | "user";

export interface AdapterLaneWorker {
  tick(): Promise<AdapterLaneWorkerTickResult>;
  resetForTest(): void;
  setSlotForTest(slotIndex: number): void;
}

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
  maxBatchSize: number;
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

function validateLaneWorkerPolicy<TLane extends string>(
  policy: AdapterLaneWorkerPolicy<TLane>,
): void {
  validateLaneShape(policy);
  assertPositiveInteger("maxAttempts", policy.maxAttempts);
  assertPositiveInteger("staleProcessingMs", policy.staleProcessingMs);
  assertPositiveInteger("staleRecoveryIntervalMs", policy.staleRecoveryIntervalMs);
}

function validateBatchLaneWorkerPolicy<TLane extends string>(
  policy: AdapterBatchLaneWorkerPolicy<TLane>,
): void {
  validateLaneShape(policy);
  assertPositiveInteger("maxAttempts", policy.maxAttempts);
  assertPositiveInteger("maxBatchSize", policy.maxBatchSize);
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

export function createAdapterLaneWorker<TLane extends string, TPermit = unknown>(
  policy: AdapterLaneWorkerPolicy<TLane, TPermit>,
): AdapterLaneWorker {
  validateLaneWorkerPolicy(policy);
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
    | { kind: "claimed"; id: number; type: string; dispatched: boolean }
  > {
    const claim = await db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
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
      const queryResult = rows as unknown as {
        rows?: Array<Omit<ClaimedRow, "id"> & { id: number | string }>;
      };
      const rawRow = queryResult.rows?.[0];
      if (!rawRow) return { kind: "none" as const };

      const claimed: ClaimedRow = { ...rawRow, id: Number(rawRow.id) };
      const normalized: AdapterLaneWorkerRow = {
        id: claimed.id,
        adapterKind: claimed.adapter_kind,
        queueName,
        type: claimed.type,
        payload: claimed.payload,
        userId: claimed.user_id,
        attempts: claimed.attempts,
      };
      let gate: AdapterLaneClaimGateResult<TPermit> | undefined;
      try {
        gate = await policy.claimGate?.({
          adapterKind: policy.adapterKind,
          queueName,
          rows: [normalized],
          now: new Date(),
          tx,
        });
      } catch (err) {
        const retryAfterMs = defaultRetryBackoffMs(1);
        await tx.execute(sql`
          UPDATE ${sql.raw(ADAPTER_REFRESH_QUEUE_TABLE)}
          SET next_attempt_at = NOW() + (${retryAfterMs} || ' milliseconds')::interval
          WHERE id = ${claimed.id}
            AND adapter_kind = ${policy.adapterKind}
        `);
        logger.warn(
          {
            adapter: policy.adapterKind,
            queueName,
            type: claimed.type,
            id: claimed.id,
            retryAfterMs,
            err: String((err as Error)?.message ?? err),
          },
          "adapter lane worker: claim gate failed; claim deferred",
        );
        return {
          kind: "gated" as const,
          retryAfterMs,
          reason: "claim_gate_error",
        };
      }
      if (gate?.action === "defer") {
        await tx.execute(sql`
          UPDATE ${sql.raw(ADAPTER_REFRESH_QUEUE_TABLE)}
          SET next_attempt_at = NOW() + (${gate.retryAfterMs} || ' milliseconds')::interval
          WHERE id = ${claimed.id}
            AND adapter_kind = ${policy.adapterKind}
        `);
        return {
          kind: "gated" as const,
          retryAfterMs: gate.retryAfterMs,
          reason: gate.reason,
        };
      }
      await tx.execute(sql`
        UPDATE ${sql.raw(ADAPTER_REFRESH_QUEUE_TABLE)}
        SET status = 'processing',
            last_attempt_at = NOW(),
            attempts = attempts + 1
        WHERE id = ${claimed.id}
          AND adapter_kind = ${policy.adapterKind}
      `);
      return { kind: "claimed" as const, row: claimed, permit: gate?.permit };
    });

    if (claim.kind === "none" || claim.kind === "gated") return claim;
    const row = claim.row;
    const newAttempts = row.attempts + 1;
    const normalized: AdapterLaneWorkerRow = {
      id: row.id,
      adapterKind: row.adapter_kind,
      queueName,
      type: row.type,
      payload: row.payload,
      userId: row.user_id,
      attempts: row.attempts,
    };

    let guard: AdapterLaneGuardResult | undefined;
    try {
      guard = await policy.guardDispatch?.({
        queueName,
        rows: [normalized],
        now: new Date(),
      });
    } catch (err) {
      const retryAfterMs = defaultRetryBackoffMs(1);
      await deferRows([normalized], retryAfterMs);
      logger.warn(
        {
          adapter: policy.adapterKind,
          queueName,
          type: row.type,
          id: row.id,
          retryAfterMs,
          err: String((err as Error)?.message ?? err),
        },
        "adapter lane worker: guard failed; dispatch deferred",
      );
      return { kind: "claimed", id: row.id, type: row.type, dispatched: false };
    }
    if (guard?.action === "defer") {
      await deferRows([normalized], guard.retryAfterMs);
      logger.info(
        {
          adapter: policy.adapterKind,
          queueName,
          type: row.type,
          id: row.id,
          retryAfterMs: guard.retryAfterMs,
          reason: guard.reason,
        },
        "adapter lane worker: dispatch deferred by guard",
      );
      return { kind: "claimed", id: row.id, type: row.type, dispatched: false };
    }

    try {
      await policy.dispatch(normalized, { permit: claim.permit });
      await db.execute(
        sql`UPDATE ${sql.raw(ADAPTER_REFRESH_QUEUE_TABLE)} SET status = 'done' WHERE id = ${row.id} AND adapter_kind = ${policy.adapterKind}`,
      );
    } catch (err) {
      const isPermanent =
        err instanceof AdapterError &&
        (err.category === "permanent" || err.category === "not-found");
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
      logger.warn(
        {
          adapter: policy.adapterKind,
          queueName,
          type: row.type,
          id: row.id,
          category: err instanceof AdapterError ? err.category : "non-adapter",
          attempts: newAttempts,
          err: String((err as Error)?.message ?? err),
        },
        "adapter lane worker: handler failed",
      );
    }

    return { kind: "claimed", id: row.id, type: row.type, dispatched: true };
  }

  return {
    async tick(): Promise<AdapterLaneWorkerTickResult> {
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
            "adapter lane worker: claim gate deferred tick",
          );
          return { processedQueue: null, processedType: null, processedId: null };
        }
        if (claimed.kind === "claimed") {
          if (claimed.dispatched) {
            policy.emitDrained?.({
              queueName,
              entriesProcessed: 1,
              durationMs: Date.now() - tickStartMs,
            });
          }
          return {
            processedQueue: queueName,
            processedType: claimed.type,
            processedId: claimed.id,
          };
        }
      }

      return { processedQueue: null, processedType: null, processedId: null };
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
      if (policy.maxBatchSize > 1) {
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
          LIMIT ${policy.maxBatchSize - 1}
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
