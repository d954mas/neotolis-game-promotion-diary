<script lang="ts">
  // Terms of Service. 10 sections.
  //
  // SUPPORT_EMAIL + per-user limits come from `+page.server.ts`; the
  // "early access" magic phrase in terms_section_early_access_body is
  // load-bearing — the integration test asserts it (case-insensitive grep).
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
  <p class="back-link"><a href="/about">{m.legal_back_to_about()}</a></p>
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
    color: var(--text);
  }
  .legal-page h1 {
    margin-bottom: var(--s-1);
    color: var(--text);
  }
  .legal-page h2 {
    margin-top: var(--s-7);
    color: var(--text);
  }
  .legal-page p {
    color: var(--text-2);
  }
  .last-updated {
    color: var(--text-3);
    font-size: 0.9em;
    margin-top: 0;
  }
  .back-link {
    margin: 0 0 var(--s-4);
    font-size: var(--t-13);
  }
  /* Anchor color aligned to the accent palette so it does not render as
   * the browser-default bright blue against the dark theme. */
  .legal-page a {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .legal-page a:hover {
    color: var(--accent-strong);
  }
</style>
