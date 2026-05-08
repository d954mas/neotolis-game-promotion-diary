// AdapterError — Phase 03.0.1 D-13 5-category taxonomy.
//
// Every adapter throws AdapterError on failure (transient | rate-limited |
// not-found | permanent | operator-issue). The adapter HTTP wrapper, queue
// handlers, and /admin/quota dashboard all key off `category` for retry,
// throttle, and surfacing decisions. Phase 6 adds a 6th category `user-auth`
// when per-user credentials land — adding a category is a breaking change
// that surfaces as a TypeScript exhaustiveness error in
// `categoryToSnapshotStatus` (the switch has no default branch).

import type { SnapshotStatus } from "./adapter.js";

export type AdapterErrorCategory =
  | "transient"
  | "rate-limited"
  | "not-found"
  | "permanent"
  | "operator-issue";

export interface AdapterErrorOptions {
  category: AdapterErrorCategory;
  retryAfterMs?: number;
  cause?: unknown;
  context?: Record<string, unknown>;
}

export class AdapterError extends Error {
  readonly category: AdapterErrorCategory;
  readonly retryAfterMs: number | null;
  readonly context: Record<string, unknown>;
  constructor(message: string, opts: AdapterErrorOptions) {
    super(message, { cause: opts.cause });
    this.category = opts.category;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.context = opts.context ?? {};
    this.name = "AdapterError";
  }
}

export function categoryToSnapshotStatus(c: AdapterErrorCategory): SnapshotStatus {
  switch (c) {
    case "transient":
      return "auth_error";
    case "rate-limited":
      return "rate_limited";
    case "not-found":
      return "not_found";
    case "permanent":
      return "auth_error";
    case "operator-issue":
      return "auth_error";
  }
}
