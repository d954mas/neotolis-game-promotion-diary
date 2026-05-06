<script lang="ts">
  // Phase 3.0 Plan 13 — /admin page. (Originally /admin/quota; flattened
  // to /admin per post-build feedback — one page hosts every admin tool.)
  //
  // Composes <PageHeader> + 2 sections (QuotaKeyTable + QuotaAuditList) per
  // UI-SPEC §"Layout & Responsive Contract → /admin page". All copy sourced
  // from messages/en.json (Plan 03.0-02 admin_quota_* keys); zero inline
  // English. Loader returns the response shape from GET /api/admin/quota:
  // { today, keys, audit }. Future admin tools land as additional <section>
  // siblings on this same page.
  //
  // Page <title> via <svelte:head> per Plan 02.1-39 §5.7 cross-page sticky
  // PageHeader pattern; admin pages inherit the sticky behavior since the
  // admin breadcrumb in +layout.svelte is NOT sticky and PageHeader's
  // sticky variant continues to anchor to the chrome wrapper.

  import { m } from "$lib/paraglide/messages.js";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import QuotaKeyTable from "$lib/components/QuotaKeyTable.svelte";
  import QuotaAuditList from "$lib/components/QuotaAuditList.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>{m.admin_quota_page_title()}</title>
</svelte:head>

<section class="admin-quota">
  <PageHeader title={m.admin_quota_page_title()} />
  <p class="intro">{m.admin_quota_page_intro()}</p>

  <section class="admin-quota__section">
    <h2>{m.admin_quota_section_keys_title()}</h2>
    <QuotaKeyTable rows={data.keys} />
  </section>

  <section class="admin-quota__section">
    <h2>{m.admin_quota_section_audit_title()}</h2>
    <QuotaAuditList entries={data.audit} />
  </section>
</section>

<style>
  .admin-quota {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    min-width: 0;
  }
  .intro {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--font-size-body);
    line-height: var(--line-height-body);
    max-width: 60ch;
  }
  /* UI-SPEC §"Spacing Scale → /admin/quota section break":
   * --space-lg (24px) between QuotaKeyTable and QuotaAuditList. */
  .admin-quota__section {
    margin-top: var(--space-lg);
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }
  .admin-quota__section h2 {
    margin: 0;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
  }
</style>
