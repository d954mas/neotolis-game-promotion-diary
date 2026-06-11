<script lang="ts">
  // /admin page — one page hosts every admin tool.
  //
  // Composes <PageHeader> + 2 sections (QuotaKeyTable + QuotaAuditList).
  // All copy sourced from messages/en.json (admin_quota_* keys); zero
  // inline English. Loader returns the response shape from
  // GET /api/admin/quota: { today, keys, audit }. Future admin tools land
  // as additional <section> siblings on this same page.
  //
  // Page <title> via <svelte:head>; admin pages inherit the sticky behavior
  // since the admin breadcrumb in +layout.svelte is NOT sticky and
  // PageHeader's sticky variant continues to anchor to the chrome wrapper.

  import { m } from "$lib/paraglide/messages.js";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import QuotaKeyTable from "$lib/components/QuotaKeyTable.svelte";
  import QuotaAuditList from "$lib/components/QuotaAuditList.svelte";
  import RedditOpsPanel from "$lib/components/RedditOpsPanel.svelte";
  import YoutubeOpsPanel from "$lib/components/YoutubeOpsPanel.svelte";
  import ProviderSpendPanel from "$lib/components/ProviderSpendPanel.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>{m.admin_quota_page_title()}</title>
</svelte:head>

<!-- Each <details open> opens by default; the operator can collapse
     sections they don't care about right now. <summary> doubles as a
     clickable header, and the native browser disclosure widget gives
     us the spoiler affordance without bespoke JS state. -->
<section class="admin-quota">
  <PageHeader title={m.admin_quota_page_title()} />
  <p class="intro">{m.admin_quota_page_intro()}</p>

  <details class="admin-quota__section" open>
    <summary><h2>{m.admin_quota_section_keys_title()}</h2></summary>
    <div class="admin-quota__section-body">
      <QuotaKeyTable rows={data.keys} />
    </div>
  </details>

  <details class="admin-quota__section" open>
    <summary><h2>YouTube Ops</h2></summary>
    <div class="admin-quota__section-body">
      <YoutubeOpsPanel data={data.youtube} />
    </div>
  </details>

  <details class="admin-quota__section" open>
    <summary><h2>{m.admin_reddit_section_title()}</h2></summary>
    <div class="admin-quota__section-body">
      <RedditOpsPanel data={data.reddit} />
    </div>
  </details>

  <details class="admin-quota__section" open>
    <summary><h2>{m.admin_quota_section_instagram_title()}</h2></summary>
    <div class="admin-quota__section-body">
      <ProviderSpendPanel
        block={data.instagram}
        heading={m.admin_quota_section_instagram_title()}
        disabledHint={m.sources_new_instagram_disabled_hint()}
      />
    </div>
  </details>

  <details class="admin-quota__section" open>
    <summary><h2>{m.admin_quota_section_tiktok_title()}</h2></summary>
    <div class="admin-quota__section-body">
      <ProviderSpendPanel
        block={data.tiktok}
        heading={m.admin_quota_section_tiktok_title()}
        disabledHint={m.sources_new_tiktok_disabled_hint()}
      />
    </div>
  </details>

  <details class="admin-quota__section">
    <summary><h2>{m.admin_quota_section_audit_title()}</h2></summary>
    <div class="admin-quota__section-body">
      <QuotaAuditList entries={data.audit} />
    </div>
  </details>
</section>

<style>
  .admin-quota {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    min-width: 0;
  }
  .intro {
    margin: 0;
    color: var(--text-2);
    font-size: var(--t-14);
    line-height: var(--lh-body);
    max-width: 60ch;
  }
  /* Each section is a <details> spoiler. The summary doubles as the
     header; the body slides in/out via the native disclosure widget. */
  .admin-quota__section {
    margin-top: var(--s-4);
    border-top: 1px solid var(--border-hairline);
    padding-top: var(--s-2);
  }
  .admin-quota__section > summary {
    list-style: none;
    cursor: pointer;
    padding: var(--s-1) 0;
    user-select: none;
  }
  .admin-quota__section > summary::-webkit-details-marker {
    display: none;
  }
  .admin-quota__section > summary::before {
    content: "▸";
    display: inline-block;
    margin-right: var(--s-1);
    color: var(--text-3);
    transition: transform var(--m-fast) var(--m-ease);
    transform: rotate(0deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .admin-quota__section > summary::before {
      transition: none;
    }
  }
  .admin-quota__section[open] > summary::before {
    transform: rotate(90deg);
  }
  .admin-quota__section > summary > h2 {
    display: inline;
    margin: 0;
    font-size: var(--t-14);
    font-weight: var(--w-sb);
  }
  .admin-quota__section-body {
    margin-top: var(--s-4);
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
</style>
