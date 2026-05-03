<script lang="ts">
  // Phase 02.2 Plan 02.2-05 — Privacy Policy (D-09, D-S4).
  //
  // 13 sections per RESEARCH §6 Privacy structure. Each {section_X_title,
  // section_X_body} pair is a Paraglide message; SUPPORT_EMAIL + RETENTION_DAYS
  // come from `+page.server.ts` so a self-host operator overrides via .env
  // without forking the template (D-30, D-31).
  //
  // The "Right to Erasure" magic phrase in privacy_section_rights_body is
  // load-bearing — tests/integration/public-pages.test.ts asserts it.
  import { m } from "$lib/paraglide/messages.js";
  let { data } = $props();
  const ctx = {
    supportEmail: data.supportEmail || "(support email not configured)",
    retentionDays: String(data.retentionDays),
    worstCaseDays: String(data.worstCaseDays),
  };
</script>

<svelte:head>
  <title>{m.privacy_title()}</title>
</svelte:head>

<main class="legal-page">
  <h1>{m.privacy_title()}</h1>
  <p class="last-updated">{m.privacy_last_updated({ date: data.lastUpdated })}</p>

  <h2>{m.privacy_section_who_we_are_title()}</h2>
  <p>{m.privacy_section_who_we_are_body(ctx)}</p>

  <h2>{m.privacy_section_data_collected_title()}</h2>
  <p>{m.privacy_section_data_collected_body()}</p>

  <h2>{m.privacy_section_lawful_basis_title()}</h2>
  <p>{m.privacy_section_lawful_basis_body()}</p>

  <h2>{m.privacy_section_processors_title()}</h2>
  <p>{m.privacy_section_processors_body()}</p>

  <h2>{m.privacy_section_storage_title()}</h2>
  <p>{m.privacy_section_storage_body()}</p>

  <h2>{m.privacy_section_retention_title()}</h2>
  <p>{m.privacy_section_retention_body(ctx)}</p>

  <h2>{m.privacy_section_rights_title()}</h2>
  <p>{m.privacy_section_rights_body(ctx)}</p>

  <h2>{m.privacy_section_cookies_title()}</h2>
  <p>{m.privacy_section_cookies_body()}</p>

  <h2>{m.privacy_section_children_title()}</h2>
  <p>{m.privacy_section_children_body(ctx)}</p>

  <h2>{m.privacy_section_security_title()}</h2>
  <p>{m.privacy_section_security_body()}</p>

  <h2>{m.privacy_section_changes_title()}</h2>
  <p>{m.privacy_section_changes_body()}</p>

  <h2>{m.privacy_section_complaints_title()}</h2>
  <p>{m.privacy_section_complaints_body()}</p>

  <h2>{m.privacy_section_contact_title()}</h2>
  <p>{m.privacy_section_contact_body(ctx)}</p>
</main>

<style>
  .legal-page {
    max-width: 720px;
    margin: 0 auto;
    line-height: 1.6;
  }
  .legal-page h1 {
    margin-bottom: var(--space-xs);
  }
  .legal-page h2 {
    margin-top: var(--space-xl);
  }
  .last-updated {
    color: var(--color-muted, #666);
    font-size: 0.9em;
    margin-top: 0;
  }
</style>
