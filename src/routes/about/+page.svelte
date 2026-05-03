<script lang="ts">
  // Phase 02.2 Plan 02.2-05 — public /about page (D-S4).
  //
  // Thin project description + GitHub repo link + privacy/terms links +
  // canonical-instance link (only when DOMAIN is configured) + footer
  // contact email injected from env (D-30 — never hardcoded).
  import { m } from "$lib/paraglide/messages.js";
  let { data } = $props();
  const footerCtx = {
    supportEmail: data.supportEmail || "(support email not configured)",
  };
</script>

<svelte:head>
  <title>{m.about_title()}</title>
</svelte:head>

<main class="about-page">
  <h1>{m.about_title()}</h1>
  <p>{m.about_intro_body()}</p>
  <ul>
    <li>
      <a href="https://github.com/d954mas/neotolis-diary">{m.about_repo_link_label()}</a>
    </li>
    {#if data.domain}
      <li>
        <a href="https://{data.domain}">{m.about_canonical_instance_label()}</a>
      </li>
    {/if}
    <li><a href="/privacy">{m.about_links_privacy()}</a></li>
    <li><a href="/terms">{m.about_links_terms()}</a></li>
  </ul>
  <footer>{m.about_footer_contact(footerCtx)}</footer>
</main>

<style>
  .about-page {
    max-width: 720px;
    margin: 0 auto;
    line-height: 1.6;
  }
  .about-page ul {
    margin: var(--space-md) 0;
    padding-left: var(--space-lg);
  }
  .about-page footer {
    margin-top: var(--space-xl);
    color: var(--color-muted, #666);
    font-size: 0.9em;
  }
</style>
