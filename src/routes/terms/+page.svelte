<script lang="ts">
  // Phase 02.2 Plan 02.2-05 — Terms of Service (D-10, D-11, D-S4).
  //
  // 10 sections per RESEARCH §6 ToS structure. SUPPORT_EMAIL + per-user
  // limits come from `+page.server.ts`; the "early access" magic phrase
  // in terms_section_early_access_body is load-bearing — the integration
  // test asserts it (case-insensitive grep).
  import { m } from "$lib/paraglide/messages.js";
  let { data } = $props();
  const supportCtx = {
    supportEmail: data.supportEmail || "(support email not configured)",
  };
  const limitsCtx = {
    gamesLimit: String(data.gamesLimit),
    sourcesLimit: String(data.sourcesLimit),
    eventsLimit: String(data.eventsLimit),
    supportEmail: supportCtx.supportEmail,
  };
</script>

<svelte:head>
  <title>{m.terms_title()}</title>
</svelte:head>

<main class="legal-page">
  <h1>{m.terms_title()}</h1>
  <p class="last-updated">{m.terms_last_updated({ date: data.lastUpdated })}</p>

  <h2>{m.terms_section_service_description_title()}</h2>
  <p>{m.terms_section_service_description_body()}</p>

  <h2>{m.terms_section_account_title()}</h2>
  <p>{m.terms_section_account_body()}</p>

  <h2>{m.terms_section_acceptable_use_title()}</h2>
  <p>{m.terms_section_acceptable_use_body()}</p>

  <h2>{m.terms_section_limits_title()}</h2>
  <p>{m.terms_section_limits_body(limitsCtx)}</p>

  <h2>{m.terms_section_early_access_title()}</h2>
  <p>{m.terms_section_early_access_body()}</p>

  <h2>{m.terms_section_open_source_title()}</h2>
  <p>{m.terms_section_open_source_body()}</p>

  <h2>{m.terms_section_warranty_title()}</h2>
  <p>{m.terms_section_warranty_body()}</p>

  <h2>{m.terms_section_termination_title()}</h2>
  <p>{m.terms_section_termination_body()}</p>

  <h2>{m.terms_section_changes_title()}</h2>
  <p>{m.terms_section_changes_body()}</p>

  <h2>{m.terms_section_contact_title()}</h2>
  <p>{m.terms_section_contact_body(supportCtx)}</p>
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
