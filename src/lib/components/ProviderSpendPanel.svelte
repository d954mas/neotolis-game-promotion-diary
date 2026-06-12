<script lang="ts">
  // ProviderSpendPanel — /admin per-provider spend block (OBS-02, D-22/D-23).
  //
  // Operator-only (the /admin route is allowlist-gated). Renders the
  // Instagram provider's daily spend posture from the loader's
  // AdminInstagramBlock:
  //   - Requests today      (count, tabular-nums --f-mono)
  //   - Spend / cap         (the .quota-banner__bar progress bar with the
  //                          quotaZone() thresholds: --accent <80%, --warn
  //                          80-99%, --danger >=100%)
  //   - Remaining balance   (cap - tracked spend, D-23; the prepaid funded
  //                          ceiling shown additively as a second line) +
  //                          the balance-source caveat <small>.
  //
  // When the operator hasn't configured the provider env, the block collapses
  // to { isConfigured: false } and the panel renders the not-configured
  // placeholder (mirror RedditOpsPanel's EmptyState collapse). No spend table
  // that looks like an outage when there's simply no provider wired.
  //
  // Reuses existing admin/quota tokens + the QuotaStatusBanner bar + the
  // shared quotaZone() from $lib/quota-zone.js — invents no new visual
  // language (UI-SPEC §6).

  import { m } from "$lib/paraglide/messages.js";
  import EmptyState from "./EmptyState.svelte";
  import { quotaPct, quotaZone } from "$lib/quota-zone.js";
  import type {
    AdminInstagramBlock,
    AdminTiktokBlock,
  } from "$lib/server/services/admin-quota-read.js";

  // The IG + TikTok provider blocks are structurally identical (same spend/cap +
  // balance + throttle shape, same collapse-when-unconfigured contract), so this
  // one panel renders either. `heading` + `disabledHint` let each section title
  // its not-configured placeholder for the right platform; both default to the
  // generic "Provider spend" copy.
  let {
    block,
    heading = m.admin_quota_section_providers_title(),
    disabledHint = m.sources_new_instagram_disabled_hint(),
  }: {
    block: AdminInstagramBlock | AdminTiktokBlock;
    heading?: string;
    disabledHint?: string;
  } = $props();

  const spendPct = $derived(block.isConfigured ? quotaPct(block.creditsUsed, block.dailyCap) : 0);
  const spendZone = $derived(quotaZone(spendPct));
</script>

{#if !block.isConfigured}
  <EmptyState {heading} body={disabledHint} />
{:else}
  <div class="provider-spend">
    <div class="provider-spend__row">
      <span class="provider-spend__label">{m.admin_quota_provider_requests_label()}</span>
      <span class="provider-spend__num">{block.requestsToday.toLocaleString()}</span>
    </div>

    <div class="provider-spend__row provider-spend__row--bar">
      <span class="provider-spend__label">{m.admin_quota_provider_spend_label()}</span>
      <span class="provider-spend__num">
        {block.creditsUsed.toLocaleString()}/{block.dailyCap.toLocaleString()}
      </span>
      <div class="quota-banner__bar quota-banner__bar--{spendZone}" aria-hidden="true">
        <div class="quota-banner__bar-fill" style="width: {spendPct}%"></div>
      </div>
    </div>

    <div class="provider-spend__row">
      <span class="provider-spend__label">{m.admin_quota_provider_balance_label()}</span>
      <span class="provider-spend__num">{block.remainingBalance.toLocaleString()}</span>
    </div>
    {#if block.prepaidBalance !== block.remainingBalance}
      <div class="provider-spend__row provider-spend__row--sub">
        <span class="provider-spend__label">Prepaid balance</span>
        <span class="provider-spend__num">{block.prepaidBalance.toLocaleString()}</span>
      </div>
    {/if}
    <small class="quota-banner__reddit-explainer">{m.admin_quota_provider_balance_note()}</small>
  </div>
{/if}

<style>
  .provider-spend {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: var(--s-6);
  }
  .provider-spend__row {
    display: flex;
    align-items: center;
    gap: var(--s-3);
  }
  .provider-spend__row--bar {
    flex-wrap: wrap;
  }
  .provider-spend__row--sub {
    margin-top: calc(-1 * var(--s-2));
  }
  .provider-spend__label {
    color: var(--text-2);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    min-width: 11rem;
  }
  .provider-spend__row--sub .provider-spend__label {
    color: var(--text-3);
    font-size: var(--t-12);
  }
  .provider-spend__num {
    color: var(--text);
    font-family: var(--f-mono);
    font-size: var(--t-13);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  /* Reuse the QuotaStatusBanner bar markup + threshold-zone fill colors.
   * Declared :global because the .quota-banner__bar* classes are owned by
   * QuotaStatusBanner; here we just instantiate the same markup. */
  :global(.provider-spend .quota-banner__bar) {
    flex: 1;
    height: 6px;
    background: var(--surface-3);
    border-radius: var(--r-pill);
    overflow: hidden;
    max-width: 200px;
  }
  :global(.provider-spend .quota-banner__bar-fill) {
    height: 100%;
    transition: width var(--m-base) var(--m-ease);
  }
  :global(.provider-spend .quota-banner__bar--ok .quota-banner__bar-fill) {
    background: var(--accent);
  }
  :global(.provider-spend .quota-banner__bar--warning .quota-banner__bar-fill) {
    background: var(--warn);
  }
  :global(.provider-spend .quota-banner__bar--error .quota-banner__bar-fill) {
    background: var(--danger);
  }
  .quota-banner__reddit-explainer {
    display: block;
    margin-top: var(--s-1);
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    line-height: var(--lh-body);
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.provider-spend .quota-banner__bar-fill) {
      transition: none;
    }
  }
</style>
