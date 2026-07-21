// Admin /admin/quota loader.
//
// Service-layer reader (no Hono, no auth concerns): the route at
// `src/lib/server/http/routes/admin/quota.ts` calls
// `loadAdminQuotaPage()` after the auth + allowlist gates have fired.
// Returns the operator's view of today's per-key quota usage plus a tail
// of service-level audit rows.
//
// Allowlist-gated CROSS-TENANT reads:
//   The audit_log lookup intentionally aggregates across tenants.
//   /admin/quota is the operator's signal pane — they need to see purges
//   across all tenants, quota throttle transitions tied to the
//   operator's API keys, and adapter-level auto-import deferrals
//   regardless of which tenant triggered them. The security property is
//   the env allowlist: a non-allowlisted user never reaches this loader
//   (admin middleware throws NotFoundError before the route handler
//   runs). The audit_log table is in ESLint's TENANT_TABLES; the
//   cross-tenant query below carries an `eslint-disable-next-line` with
//   a `--` justification.
//
// Threshold derivation:
//   pctOfDaily = estimatedUnits / dailyLimit * 100, rounded to 1 decimal.
//   status: derived from per-key `throttleState` returned by the
//     adapter's observability surface
//     (`getDailyStats(now).keys[].throttleState`):
//       'ok'                    → status 'ok'
//       'eighty'                → status '80_throttle'
//       'ninetyfive'            → status '95_throttle'
//   Per-platform threshold values are an adapter-internal concern so
//   different source adapters can use their own (e.g. rolling-window)
//   thresholds without touching this loader.

import { desc, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import type { AuditAction } from "../audit/actions.js";
import { todayPacific } from "./quota.js";
import { getAdapter } from "$lib/sources/registry.js";
import {
  getYoutubeQueueDepth,
  getYoutubeDailyByType,
  type YoutubeQueueDepthRow,
  type YoutubeDailyByType,
} from "$lib/sources/youtube/server/observability.js";
import { getInstagramProviderBlock } from "$lib/sources/instagram/server/observability.js";
import { getTikTokProviderBlock } from "$lib/sources/tiktok/server/observability.js";
import { getRedditProviderBlock } from "$lib/sources/reddit/server/observability.js";

// Re-export types so the /admin Svelte components (which can only
// type-import from this server-service module) can reference the same shapes
// the loader returns.
export type { YoutubeQueueDepthRow, YoutubeDailyByType };

export interface QuotaKeyRow {
  /** sha-8 hash of the operator's API key — stable identifier across boots. */
  apiKeyId: string;
  /** Estimated quota units consumed by this key today (Pacific). */
  estimatedUnits: number;
  /** estimatedUnits / dailyLimit * 100, rounded to 1 decimal. */
  pctOfDaily: number;
  /** UI status pill — translated from adapter's per-key throttleState. */
  status: "ok" | "80_throttle" | "95_throttle";
}

export interface ServiceAuditEntry {
  id: string;
  createdAt: Date;
  /** One of SERVICE_LEVEL_AUDIT_ACTIONS — the verbs surfaced on /admin/quota. */
  action: string;
  metadata: Record<string, unknown>;
}

/**
 * The audit verbs surfaced on /admin/quota — operator-facing signals
 * only. Per-tenant audit rows (session.signin / event.created / ...)
 * are NOT surfaced here; users see those in their own /audit page.
 */
const SERVICE_LEVEL_AUDIT_ACTIONS: readonly AuditAction[] = [
  "quota.service_throttled",
  "purge.completed",
  "auto_import.deferred",
  "poll.failed",
  // Phase 8 — social-provider cost guardrails (operator-side). The daily-cap
  // 80/95 throttle crossing + the prepaid-balance-hit-zero hard stop surface in
  // the operator's "what crossed our budget today" tail alongside the YouTube
  // quota.service_throttled verb (OBS-02).
  "social.provider_throttled",
  "social.budget_exhausted",
] as const;

/** How many tail audit rows to surface on /admin/quota. */
const ADMIN_AUDIT_TAIL_LIMIT = 50;

/**
 * Reddit (ScrapeCreators) provider block surfaced on /admin/quota — the twin of
 * AdminInstagramBlock/AdminTiktokBlock (same shape, same collapse-when-unconfigured
 * contract). The rebuilt Reddit adapter (Phase 12) is a PAID ScrapeCreators provider
 * behind the D-08 kill-switch, sharing the provider-wide prepaid balance with
 * Instagram + TikTok (D-01), so remainingBalance / prepaidBalance read the SAME
 * ceiling; the per-platform creditsUsed / requestsToday are Reddit's own daily spend.
 * When the operator hasn't opted in (isRedditConfigured() false — REDDIT_IMPORT_ENABLED
 * unset), the block collapses to `{ isConfigured: false }` and the page renders the
 * "Reddit import not configured by operator" placeholder.
 */
export type AdminRedditBlock =
  | {
      isConfigured: true;
      requestsToday: number;
      creditsUsed: number;
      dailyCap: number;
      remainingBalance: number;
      prepaidBalance: number;
      throttleState: "ok" | "eighty" | "ninetyfive";
    }
  | { isConfigured: false };

export interface AdminYoutubeBlock {
  queueDepth: YoutubeQueueDepthRow[];
  daily: YoutubeDailyByType;
}

/**
 * Instagram (ScrapeCreators) provider block surfaced on /admin/quota alongside
 * the YouTube + Reddit blocks (OBS-02, D-23). When the operator hasn't
 * configured a provider (INSTAGRAM_PROVIDER / SCRAPECREATORS_API_KEY empty), the
 * block collapses to `{ isConfigured: false }` — the page renders the
 * "Instagram import not configured by operator" placeholder instead of empty
 * spend tables (mirrors the AdminRedditBlock REDDIT_USER_AGENT-empty collapse,
 * SOC-05).
 *
 * Configured shape:
 *   - requestsToday  : credits spent today (1 credit/request, D-18).
 *   - creditsUsed    : same value, named for the spend-vs-cap view.
 *   - dailyCap       : the operator's daily-cap ceiling (credits).
 *   - remainingBalance = the prepaid funded balance (the absolute D-16 hard
 *                        ceiling — "cannot spend what isn't there").
 *   - prepaidBalance : the same funded balance, surfaced explicitly.
 *   - throttleState  : the adapter's worst-of 80/95 + exhausted-balance signal.
 */
export type AdminInstagramBlock =
  | {
      isConfigured: true;
      requestsToday: number;
      creditsUsed: number;
      dailyCap: number;
      remainingBalance: number;
      prepaidBalance: number;
      throttleState: "ok" | "eighty" | "ninetyfive";
    }
  | { isConfigured: false };

/**
 * TikTok (ScrapeCreators) provider block surfaced on /admin/quota — the twin of
 * AdminInstagramBlock (same shape, same collapse-when-unconfigured contract).
 * TikTok shares the provider-wide prepaid balance with Instagram (D-01), so the
 * remainingBalance / prepaidBalance fields read the SAME ceiling; the per-platform
 * creditsUsed / requestsToday are TikTok's own daily spend (visibility). When the
 * operator hasn't configured TIKTOK_PROVIDER, the block collapses to
 * `{ isConfigured: false }` and the page renders the placeholder.
 */
export type AdminTiktokBlock =
  | {
      isConfigured: true;
      requestsToday: number;
      creditsUsed: number;
      dailyCap: number;
      remainingBalance: number;
      prepaidBalance: number;
      throttleState: "ok" | "eighty" | "ninetyfive";
    }
  | { isConfigured: false };

export async function loadAdminQuotaPage(): Promise<{
  today: string;
  keys: QuotaKeyRow[];
  audit: ServiceAuditEntry[];
  reddit: AdminRedditBlock;
  youtube: AdminYoutubeBlock;
  instagram: AdminInstagramBlock;
  tiktok: AdminTiktokBlock;
}> {
  const today = todayPacific();
  const now = new Date();

  // Kind-decoupled key read via the adapter's observability surface.
  // Routes through getAdapter("youtube_channel").observability.quota.getDailyStats
  // so the /admin/quota page is decoupled from YouTube-specific schema.
  // Adding new sources extends this loader by iterating adapters that
  // surface observability, not by editing kind-specific reads.
  //
  // The `keys` projection still uses the existing { apiKeyId,
  // estimatedUnits, pctOfDaily (0-100 percent), status } shape for
  // backward compatibility with the /admin route + UI; the observability
  // stats surface returns a richer shape (unitsUsed total / dailyLimit /
  // pct fraction / throttleState) that we adapt at projection time.
  const stats = await getAdapter("youtube_channel").observability.quota.getDailyStats(now);

  // Per-key projection — convert observability stats.keys[] to
  // QuotaKeyRow[]. The keys array carries one entry per apiKeyId with
  // today's estimatedUnits AND a throttleState classification computed
  // by the adapter. Cross-source admin-read no longer hardcodes
  // thresholds — it trusts the adapter's per-key state.
  const keyRows: QuotaKeyRow[] = (stats.keys ?? []).map((k) =>
    toQuotaKeyRowFromObservability(k.apiKeyId, k.unitsUsed, k.throttleState, stats.dailyLimit),
  );

  // Audit aggregation is intentionally CROSS-SOURCE — it surfaces
  // purge.completed / auto_import.deferred / poll.failed (cross-cutting
  // verbs not owned by any single adapter) alongside
  // quota.service_throttled. The adapter's
  // observability.quota.getRecentAudit only carries YouTube-specific
  // verbs by contract; aggregating here keeps the operator's "what
  // crossed our system today" pane complete. The eslint-disable below
  // is justified — admin allowlist is the gate, not row-level userId.
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- /admin/quota is allowlist-gated; cross-tenant audit aggregation is the intended operator view. Adding a userId filter here would defeat the operator's signal pane (purges, quota transitions, adapter deferrals all live across tenants).
  const auditRows = await db
    .select()
    .from(auditLog)
    .where(inArray(auditLog.action, SERVICE_LEVEL_AUDIT_ACTIONS))
    .orderBy(desc(auditLog.createdAt))
    .limit(ADMIN_AUDIT_TAIL_LIMIT);

  // Reddit provider block — the twin of the Instagram/TikTok blocks (Phase 12
  // rebuilt adapter is a ScrapeCreators provider, NOT the old free-`.json` queue
  // model). getRedditProviderBlock reads isRedditConfigured() at call time (the D-08
  // kill-switch: REDDIT_IMPORT_ENABLED must be "true"); when off the block collapses
  // to { isConfigured: false } so the page renders the placeholder instead of a
  // zeroed spend table that looks like an outage.
  const rd = await getRedditProviderBlock(now);
  const reddit: AdminRedditBlock = rd.isConfigured
    ? {
        isConfigured: true,
        requestsToday: rd.requestsToday,
        creditsUsed: rd.creditsUsed,
        dailyCap: rd.dailyCap,
        remainingBalance: rd.remainingBalance,
        prepaidBalance: rd.prepaidBalance,
        throttleState: rd.throttleState,
      }
    : { isConfigured: false };

  // YouTube ops block. Read from the shared adapter_refresh_queue with
  // adapter_kind='youtube_channel' — same shape the Reddit panel uses,
  // surfacing queue depth + 24h breakdown + lifetime user-refresh total
  // so the operator has parity with the Reddit Ops view.
  const [ytQueueDepth, ytDaily] = await Promise.all([
    getYoutubeQueueDepth(),
    getYoutubeDailyByType(),
  ]);
  const youtube: AdminYoutubeBlock = { queueDepth: ytQueueDepth, daily: ytDaily };

  // Instagram provider block (OBS-02). getInstagramProviderBlock reads
  // isInstagramConfigured() at call time; when unconfigured the block collapses
  // to { isConfigured: false } so the page renders the placeholder instead of a
  // zeroed spend table that looks like an outage (mirror the reddit collapse).
  const ig = await getInstagramProviderBlock(now);
  const instagram: AdminInstagramBlock = ig.isConfigured
    ? {
        isConfigured: true,
        requestsToday: ig.requestsToday,
        creditsUsed: ig.creditsUsed,
        dailyCap: ig.dailyCap,
        remainingBalance: ig.remainingBalance,
        prepaidBalance: ig.prepaidBalance,
        throttleState: ig.throttleState,
      }
    : { isConfigured: false };

  // TikTok provider block — the twin of the Instagram block, mirroring its
  // collapse-when-unconfigured contract. getTikTokProviderBlock reads
  // isTikTokConfigured() at call time; when TIKTOK_PROVIDER is empty the block
  // collapses to { isConfigured: false } so the page renders the placeholder
  // instead of a zeroed spend table that looks like an outage.
  const tt = await getTikTokProviderBlock(now);
  const tiktok: AdminTiktokBlock = tt.isConfigured
    ? {
        isConfigured: true,
        requestsToday: tt.requestsToday,
        creditsUsed: tt.creditsUsed,
        dailyCap: tt.dailyCap,
        remainingBalance: tt.remainingBalance,
        prepaidBalance: tt.prepaidBalance,
        throttleState: tt.throttleState,
      }
    : { isConfigured: false };

  return {
    today,
    keys: keyRows,
    audit: auditRows.map(toServiceAuditEntry),
    reddit,
    youtube,
    instagram,
    tiktok,
  };
}

/**
 * Convert an observability key entry { apiKeyId, unitsUsed, throttleState }
 * to the legacy QuotaKeyRow shape (pctOfDaily as 0-100 percent + status pill).
 *
 * `throttleState` is computed by the adapter (per-platform thresholds).
 * This function only translates between observability shape
 * (`'ok' | 'eighty' | 'ninetyfive'`) and admin wire-format (`'ok' |
 * '80_throttle' | '95_throttle'`); it does not recompute thresholds.
 *
 * `dailyLimit` is the per-platform single-key budget used for the percent
 * denominator (YouTube = 10000). Falling back to 10000 keeps the legacy wire
 * format stable for the existing test + UI assertions.
 */
function toQuotaKeyRowFromObservability(
  apiKeyId: string,
  unitsUsed: number,
  throttleState: "ok" | "eighty" | "ninetyfive",
  dailyLimit: number,
): QuotaKeyRow {
  // 1 decimal — multiply by 1000, round, divide by 10. Float-safe at quota
  // scale (worst case: 99_999 / 10_000 * 100 = 999.99 → rounded 1000.0).
  const denom = dailyLimit > 0 ? dailyLimit : 10_000;
  const pct = Math.round((unitsUsed / denom) * 1000) / 10;
  const status: QuotaKeyRow["status"] =
    throttleState === "ninetyfive"
      ? "95_throttle"
      : throttleState === "eighty"
        ? "80_throttle"
        : "ok";
  return {
    apiKeyId,
    estimatedUnits: unitsUsed,
    pctOfDaily: pct,
    status,
  };
}

/**
 * DTO projection for service-level audit_log rows. Mirrors toAuditEntryDto
 * shape but includes the row id for de-dup on the client (the tail is
 * paginated-cap-only; clients re-query, no cursor needed at this scale).
 *
 * We intentionally do NOT project user_id even though the lookup is
 * cross-tenant — the operator UI shows verb + metadata + time only. If a
 * future operator screen needs the per-tenant id (e.g. for "which tenant
 * triggered this purge?") add the field explicitly with the same review
 * touchpoint discipline as the rest of dto.ts.
 */
export function toServiceAuditEntry(row: typeof auditLog.$inferSelect): ServiceAuditEntry {
  return {
    id: row.id,
    createdAt: row.createdAt,
    action: row.action,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}
