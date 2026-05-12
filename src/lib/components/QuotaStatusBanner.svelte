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

  let { platforms }: { platforms: QuotaPlatform[] } = $props();

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
</script>

<aside class="quota-banner" aria-label={m.quota_banner_title()}>
  <header class="quota-banner__header">
    <h2 class="quota-banner__title">{m.quota_banner_title()}</h2>
    <p class="quota-banner__subtitle">{m.quota_banner_subtitle()}</p>
  </header>

  {#each platforms as p (p.kind)}
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

  {#if platforms.length > 0}
    <footer class="quota-banner__lifetime">
      <h3 class="quota-banner__lifetime-title">{m.quota_banner_lifetime()}</h3>
      {#each platforms as p (p.kind)}
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
</style>
