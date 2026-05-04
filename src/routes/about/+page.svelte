<script lang="ts">
  // Phase 02.2 Plan 02.2-05 — public /about page (D-S4).
  //
  // Rich landing-style page that explains what the product is, how it works,
  // and links to /privacy + /terms + the GitHub repo + the deploy runbook.
  // SUPPORT_EMAIL injected from env (D-30 — never hardcoded).
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
  <header class="hero">
    <h1>{m.about_title()}</h1>
    <p class="tagline">{m.about_hero_tagline()}</p>
  </header>

  <section>
    <h2>{m.about_section_what_is_it_title()}</h2>
    <p>{m.about_section_what_is_it_body()}</p>
  </section>

  <section>
    <h2>{m.about_section_how_it_works_title()}</h2>
    <ol class="steps">
      <li>
        <h3>{m.about_section_how_it_works_step_1_title()}</h3>
        <p>{m.about_section_how_it_works_step_1_body()}</p>
      </li>
      <li>
        <h3>{m.about_section_how_it_works_step_2_title()}</h3>
        <p>{m.about_section_how_it_works_step_2_body()}</p>
      </li>
      <li>
        <h3>{m.about_section_how_it_works_step_3_title()}</h3>
        <p>{m.about_section_how_it_works_step_3_body()}</p>
      </li>
    </ol>
  </section>

  <section>
    <h2>{m.about_section_open_source_title()}</h2>
    <p>{m.about_section_open_source_body()}</p>
    <p>
      <a class="cta-link" href="https://github.com/d954mas/neotolis-diary">
        {m.about_repo_link_label()}
      </a>
    </p>
  </section>

  <section>
    <h2>{m.about_section_privacy_title()}</h2>
    <p>{m.about_section_privacy_body()}</p>
  </section>

  <section>
    <h2>{m.about_section_self_host_title()}</h2>
    <p>{m.about_section_self_host_body()}</p>
    <p>
      <a
        class="cta-link"
        href="https://github.com/d954mas/neotolis-diary/blob/master/docs/deploy/install.md"
      >
        {m.about_section_self_host_runbook_link()}
      </a>
    </p>
  </section>

  <footer class="legal-footer">
    <strong>{m.about_footer_links_label()}</strong>
    <ul>
      <li><a href="/privacy">{m.about_links_privacy()}</a></li>
      <li><a href="/terms">{m.about_links_terms()}</a></li>
      {#if data.domain}
        <li><a href="https://{data.domain}">{m.about_canonical_instance_label()}</a></li>
      {/if}
    </ul>
    <p class="contact">{m.about_footer_contact(footerCtx)}</p>
  </footer>
</main>

<style>
  .about-page {
    max-width: 760px;
    margin: 0 auto;
    padding: var(--space-xl) var(--space-md);
    line-height: var(--line-height-body);
  }
  .hero {
    margin-bottom: calc(var(--space-xl) * 2);
    text-align: center;
  }
  .hero h1 {
    margin: 0 0 var(--space-sm);
    font-size: 2.4rem;
    font-weight: var(--font-weight-semibold);
  }
  .hero .tagline {
    margin: 0;
    color: var(--color-text-muted);
    font-size: 1.15rem;
    line-height: 1.5;
  }
  section {
    margin-bottom: calc(var(--space-xl) * 1.5);
  }
  section h2 {
    margin: 0 0 var(--space-md);
    font-size: 1.5rem;
    font-weight: var(--font-weight-semibold);
    border-bottom: 1px solid var(--color-border);
    padding-bottom: var(--space-xs);
  }
  section p {
    margin: 0 0 var(--space-md);
  }
  .steps {
    counter-reset: step;
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .steps li {
    margin-bottom: var(--space-lg);
    padding-left: calc(var(--space-xl) + var(--space-sm));
    position: relative;
    counter-increment: step;
  }
  .steps li::before {
    content: counter(step);
    position: absolute;
    left: 0;
    top: 0;
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    background: var(--color-accent);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: var(--font-weight-semibold);
  }
  .steps h3 {
    margin: 0 0 var(--space-xs);
    font-size: 1.1rem;
    font-weight: var(--font-weight-semibold);
  }
  .steps p {
    margin: 0;
  }
  .cta-link {
    display: inline-block;
    margin-top: var(--space-xs);
  }
  .legal-footer {
    margin-top: calc(var(--space-xl) * 2);
    padding-top: var(--space-lg);
    border-top: 1px solid var(--color-border);
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
  }
  .legal-footer strong {
    display: block;
    margin-bottom: var(--space-sm);
    color: var(--color-text);
  }
  .legal-footer ul {
    list-style: none;
    padding: 0;
    margin: 0 0 var(--space-md);
    display: flex;
    gap: var(--space-md);
    flex-wrap: wrap;
  }
  .legal-footer ul li {
    margin: 0;
  }
  .legal-footer .contact {
    margin: 0;
  }
</style>
