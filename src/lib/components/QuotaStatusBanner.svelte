<script lang="ts">
  // QuotaStatusBanner — always-visible banner on /sources +
  // /sources/[id] showing per-platform API usage today + lifetime
  // totals. Designed for multi-platform expansion: each platform gets a
  // row; per-axis bar shows progress vs cap or "no limit" when the
  // adapter doesn't declare a cap.
  //
  // Color zones (per capped axis):
  //   < 80% — neutral.
  //   80-99% — warning.
  //   ≥ 100% — error (refresh button disables in caller via parent state).
  //
  // Loader passes per-platform stats via prop. Lifetime is consumption story
  // (audit_log SUM with all flow values); does NOT equal "events in feed"
  // because (a) auto-import via cron не считается here, (b) deletes reduce
  // feed но preserve lifetime audit count.

  import { m } from "$lib/paraglide/messages.js";

  interface QuotaPlatform {
    /** SourceKind — used as i18n / display key. */
    kind: string;
    today: { requests: number; events: number };
    lifetime: { requests: number; events: number };
    cap: { requestsPerDay?: number; eventsPerDay?: number };
    /** ms until 00:00 Pacific tomorrow. */
    resetsInMs: number;
  }

  /** Reddit-specific quota block (Phase 03.1 plan 08, D-RDT-QUOTA-UI).
   *  Shape differs from QuotaPlatform's two-axis (requests/events per
   *  day) because Reddit's cap is a two-axis SLIDING-window
   *  (source-actions + post-refreshes per 5 min) plus a service-load
   *  gauge (used / 6 user slots per minute). When the operator hasn't
   *  configured REDDIT_USER_AGENT, only `isOperatorConfigured: false`
   *  is set and the banner shows the empty state per D-RDT-AUTH-EMPTY. */
  type RedditQuota =
    | {
        isOperatorConfigured: true;
        sourceActions: { used: number; cap: number; windowMinutes: number };
        postRefreshes: { used: number; cap: number; windowMinutes: number };
        serviceLoad: { used: number; capacity: number };
      }
    | { isOperatorConfigured: false };

  let {
    platforms,
    redditQuota,
  }: {
    platforms: QuotaPlatform[];
    /** Optional — Reddit tab renders only when the loader supplied it
     *  (e.g. /sources). Loaders that don't yet pass it (older pages) skip
     *  the Reddit tab; the YouTube + other rows still render. */
    redditQuota?: RedditQuota;
  } = $props();

  function humanizeDuration(ms: number): string {
    if (ms <= 0) return "0m";
    const totalMin = Math.floor(ms / 60_000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function pct(used: number, cap: number): number {
    if (cap <= 0) return 0;
    return Math.min(100, Math.round((used / cap) * 100));
  }

  function zone(p: number): "ok" | "warning" | "error" {
    if (p >= 100) return "error";
    if (p >= 80) return "warning";
    return "ok";
  }

  function formatPlatformLabel(kind: string): string {
    // Capitalize first letter, replace _ with space.
    return kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  }

  // Reddit's two-axis sliding cap doesn't fit the YouTube per-day-cap
  // shape. We render Reddit via its dedicated 3-line section below; the
  // generic per-platform loop SKIPS reddit_account / reddit_subreddit
  // rows (they'd surface as "no limit" using stale 24h-flow audit, which
  // doesn't reflect the actual 5-min sliding cap). Other platforms
  // (twitter / telegram / discord) still flow through the default loop.
  const nonRedditPlatforms = $derived(
    platforms.filter((p) => p.kind !== "reddit_account" && p.kind !== "reddit_subreddit"),
  );
</script>

<aside class="quota-banner" aria-label={m.quota_banner_title()}>
  <header class="quota-banner__header">
    <h2 class="quota-banner__title">{m.quota_banner_title()}</h2>
    <p class="quota-banner__subtitle">{m.quota_banner_subtitle()}</p>
  </header>

  {#each nonRedditPlatforms as p (p.kind)}
    <section class="quota-banner__platform">
      <h3 class="quota-banner__platform-name">{formatPlatformLabel(p.kind)}</h3>

      <!-- Requests axis -->
      <div class="quota-banner__axis">
        <span class="quota-banner__axis-label">{m.quota_banner_axis_requests()}:</span>
        {#if p.cap.requestsPerDay !== undefined}
          {@const z = zone(pct(p.today.requests, p.cap.requestsPerDay))}
          <span class="quota-banner__axis-value">
            {p.today.requests}/{p.cap.requestsPerDay}
          </span>
          <div class="quota-banner__bar quota-banner__bar--{z}" aria-hidden="true">
            <div
              class="quota-banner__bar-fill"
              style="width: {pct(p.today.requests, p.cap.requestsPerDay)}%"
            ></div>
          </div>
          <span class="quota-banner__reset">
            · {m.quota_banner_resets_in({ time: humanizeDuration(p.resetsInMs) })}
          </span>
        {:else}
          <span class="quota-banner__axis-value">
            {p.today.requests}
            <span class="quota-banner__no-limit">/ {m.quota_banner_no_limit()}</span>
          </span>
        {/if}
      </div>

      <!-- Items axis -->
      <div class="quota-banner__axis">
        <span class="quota-banner__axis-label">{m.quota_banner_axis_items()}:</span>
        {#if p.cap.eventsPerDay !== undefined}
          {@const z = zone(pct(p.today.events, p.cap.eventsPerDay))}
          <span class="quota-banner__axis-value">
            {p.today.events}/{p.cap.eventsPerDay}
          </span>
          <div class="quota-banner__bar quota-banner__bar--{z}" aria-hidden="true">
            <div
              class="quota-banner__bar-fill"
              style="width: {pct(p.today.events, p.cap.eventsPerDay)}%"
            ></div>
          </div>
        {:else}
          <span class="quota-banner__axis-value">
            {p.today.events}
            <span class="quota-banner__no-limit">/ {m.quota_banner_no_limit()}</span>
          </span>
        {/if}
      </div>
    </section>
  {/each}

  {#if redditQuota}
    <!-- Reddit section (Phase 03.1 plan 08, D-RDT-QUOTA-UI).
         Two-axis sliding cap (source-actions + post-refreshes / 5min) +
         service-load gauge (used / 6 user slots per minute). Not a
         tab in the technical sense — the banner stacks sections
         vertically; "Reddit tab" in the plan refers to the
         conceptual segregation from YouTube's per-day axis.
         Empty state when operator hasn't configured REDDIT_USER_AGENT
         (D-RDT-AUTH-EMPTY). -->
    <section class="quota-banner__platform">
      <h3 class="quota-banner__platform-name">{m.quota_banner_reddit_tab_title()}</h3>
      {#if !redditQuota.isOperatorConfigured}
        <p class="quota-banner__not-configured">{m.quota_banner_reddit_not_configured()}</p>
      {:else}
        {@const sa = redditQuota.sourceActions}
        {@const pr = redditQuota.postRefreshes}
        {@const sl = redditQuota.serviceLoad}
        {@const saZone = zone(pct(sa.used, sa.cap))}
        {@const prZone = zone(pct(pr.used, pr.cap))}
        <div class="quota-banner__axis">
          <span class="quota-banner__axis-value">
            {m.quota_banner_reddit_source_actions({
              used: sa.used,
              cap: sa.cap,
              window: sa.windowMinutes,
            })}
          </span>
          <div class="quota-banner__bar quota-banner__bar--{saZone}" aria-hidden="true">
            <div
              class="quota-banner__bar-fill"
              style="width: {pct(sa.used, sa.cap)}%"
            ></div>
          </div>
        </div>
        <div class="quota-banner__axis">
          <span class="quota-banner__axis-value">
            {m.quota_banner_reddit_post_refreshes({
              used: pr.used,
              cap: pr.cap,
              window: pr.windowMinutes,
            })}
          </span>
          <div class="quota-banner__bar quota-banner__bar--{prZone}" aria-hidden="true">
            <div
              class="quota-banner__bar-fill"
              style="width: {pct(pr.used, pr.cap)}%"
            ></div>
          </div>
        </div>
        <div class="quota-banner__axis">
          <span class="quota-banner__axis-value">
            {m.quota_banner_reddit_service_load({ used: sl.used, capacity: sl.capacity })}
          </span>
        </div>
        <small class="quota-banner__reddit-explainer">{m.quota_banner_reddit_limits_explainer()}</small>
      {/if}
    </section>
  {/if}

  {#if nonRedditPlatforms.length > 0}
    <footer class="quota-banner__lifetime">
      <h3 class="quota-banner__lifetime-title">{m.quota_banner_lifetime()}</h3>
      {#each nonRedditPlatforms as p (p.kind)}
        <div class="quota-banner__lifetime-row">
          <span>{formatPlatformLabel(p.kind)}:</span>
          <span>{p.lifetime.requests} requests, {p.lifetime.events} items</span>
        </div>
      {/each}
    </footer>
  {/if}
</aside>

<style>
  .quota-banner {
    display: grid;
    gap: var(--space-sm, 0.5rem);
    padding: var(--space-md, 1rem);
    border: 1px solid var(--color-border, #e0e0e0);
    border-radius: var(--radius-md, 0.5rem);
    background: var(--color-surface, #f7f7f7);
    margin-bottom: var(--space-md, 1rem);
  }
  .quota-banner__header {
    display: grid;
    gap: var(--space-2xs, 0.125rem);
  }
  .quota-banner__title {
    margin: 0;
    font-size: var(--font-size-h3, 1.1rem);
    font-weight: 600;
  }
  .quota-banner__subtitle {
    margin: 0;
    font-size: var(--font-size-label, 0.875rem);
    color: var(--color-text-muted, #666);
  }
  .quota-banner__platform {
    display: grid;
    gap: var(--space-2xs, 0.125rem);
    padding: var(--space-xs, 0.25rem) 0;
    border-top: 1px solid var(--color-border-subtle, #efefef);
  }
  .quota-banner__platform-name {
    margin: 0;
    font-size: var(--font-size-body, 1rem);
    font-weight: 500;
  }
  .quota-banner__axis {
    display: flex;
    align-items: center;
    gap: var(--space-xs, 0.5rem);
    font-size: var(--font-size-label, 0.875rem);
  }
  .quota-banner__axis-label {
    min-width: 8em;
    color: var(--color-text-muted, #666);
  }
  .quota-banner__axis-value {
    font-variant-numeric: tabular-nums;
  }
  .quota-banner__no-limit {
    color: var(--color-text-muted, #888);
  }
  .quota-banner__bar {
    flex: 1;
    height: 6px;
    background: var(--color-border-subtle, #efefef);
    border-radius: 3px;
    overflow: hidden;
    max-width: 200px;
  }
  .quota-banner__bar-fill {
    height: 100%;
    transition: width 0.2s ease;
  }
  .quota-banner__bar--ok .quota-banner__bar-fill {
    background: var(--color-accent, #4a7);
  }
  .quota-banner__bar--warning .quota-banner__bar-fill {
    background: var(--color-warning, #d90);
  }
  .quota-banner__bar--error .quota-banner__bar-fill {
    background: var(--color-destructive, #d33);
  }
  .quota-banner__reset {
    color: var(--color-text-muted, #666);
    font-size: var(--font-size-label, 0.875rem);
  }
  .quota-banner__lifetime {
    margin-top: var(--space-xs, 0.5rem);
    padding-top: var(--space-xs, 0.5rem);
    border-top: 1px solid var(--color-border-subtle, #efefef);
    font-size: var(--font-size-label, 0.875rem);
    color: var(--color-text-muted, #666);
  }
  .quota-banner__lifetime-title {
    margin: 0 0 var(--space-2xs, 0.125rem) 0;
    font-size: var(--font-size-label, 0.875rem);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .quota-banner__lifetime-row {
    display: flex;
    gap: var(--space-xs, 0.5rem);
    font-variant-numeric: tabular-nums;
  }
  /* Reddit-specific surfaces (Phase 03.1 plan 08).
   * "Not configured" empty state when REDDIT_USER_AGENT is empty —
   * muted, single line; no axis bars (D-RDT-AUTH-EMPTY).
   * Explainer line under the 3-axis block — small + muted; surfaces
   * the per-minute / per-5-min cap rationale without bloating the
   * three axis lines themselves. */
  .quota-banner__not-configured {
    margin: 0;
    color: var(--color-text-muted, #888);
    font-size: var(--font-size-label, 0.875rem);
    font-style: italic;
  }
  .quota-banner__reddit-explainer {
    display: block;
    margin-top: var(--space-xs, 0.25rem);
    color: var(--color-text-muted, #888);
    font-size: var(--font-size-label, 0.8125rem);
    line-height: 1.4;
  }
</style>
