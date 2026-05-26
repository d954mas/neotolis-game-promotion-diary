<script lang="ts">
  // Shared marketing content rendered by both `/+page.svelte` (anonymous
  // canonical landing) and `/about/+page.svelte` (alias kept for backward
  // compat + Nav About tab + back-links from /privacy /terms).
  //
  // The previous shape was `/` → 303 → `/about` for anonymous, which is
  // non-standard SEO (search engines indexed /about as the landing
  // instead of /). This component lets both URLs render identical
  // content; `<link rel="canonical">` points both to `/`, so Google
  // treats `/` as the canonical landing and `/about` as an alias.
  //
  // The "Sign in with Google" CTA in the hero is gated by `!data.user`
  // so signed-in users opening `/about` directly (via Nav) don't see a
  // sign-in button they don't need. Signed-in users on `/` are redirected
  // to `/feed` upstream in `/+page.server.ts` and never see this content.
  import { m } from "$lib/paraglide/messages.js";
  import { signIn } from "$lib/auth-client";

  type AboutData = {
    supportEmail: string;
    domain: string;
    user: { id: string; email: string; name: string | null } | null;
  };

  let { data }: { data: AboutData } = $props();

  const footerCtx = {
    supportEmail: data.supportEmail || "(support email not configured)",
  };

  function handleSignIn() {
    void signIn.oauth2({ providerId: "google", callbackURL: "/feed" });
  }
</script>

<svelte:head>
  <title>{m.about_title()}</title>
  {#if data.domain}
    <link rel="canonical" href="https://{data.domain}/" />
  {:else}
    <link rel="canonical" href="/" />
  {/if}
</svelte:head>

<main class="about-page">
  <header class="hero">
    <h1>{m.about_title()}</h1>
    <p class="tagline">{m.about_hero_tagline()}</p>
    {#if !data.user}
      <p class="hero-cta">
        <button type="button" class="cta-button" onclick={handleSignIn}>
          {m.login_continue()}
        </button>
      </p>
    {/if}
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
      <a class="cta-link" href="https://github.com/d954mas/neotolis-game-promotion-diary">
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
        href="https://github.com/d954mas/neotolis-game-promotion-diary/blob/master/docs/deploy/install.md"
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
  /* v2 AboutContent — D-01 redraw via long-form copy with typography
   * hierarchy. h1 --t-22 (display sized up in the hero) / h2 --t-17 /
   * h3 --t-15 / body --t-14. */
  .about-page {
    max-width: 720px;
    margin: 0 auto;
    padding: var(--s-6) var(--s-4);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    line-height: var(--lh-body);
    color: var(--text-2);
  }
  .hero {
    margin-bottom: var(--s-8);
    text-align: center;
  }
  .hero h1 {
    margin: 0 0 var(--s-2);
    font-family: var(--f-sans);
    font-size: var(--t-30);
    font-weight: var(--w-sb);
    color: var(--text);
    line-height: var(--lh-tight);
  }
  .hero .tagline {
    margin: 0 0 var(--s-6);
    color: var(--text-2);
    font-size: var(--t-17);
    line-height: var(--lh-body);
  }
  .hero-cta {
    margin: 0;
  }
  .cta-button {
    display: inline-block;
    padding: var(--s-2) var(--s-6);
    background: var(--accent);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    text-decoration: none;
    font-family: var(--f-sans);
    font-weight: var(--w-sb);
    font-size: var(--t-14);
    min-height: var(--hit-lg);
    line-height: 28px;
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .cta-button:hover {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  section {
    margin-bottom: var(--s-8);
  }
  section h2 {
    margin: var(--s-6) 0 var(--s-3);
    font-family: var(--f-sans);
    font-size: var(--t-17);
    font-weight: var(--w-md);
    color: var(--text);
    line-height: var(--lh-tight);
    border-bottom: 1px solid var(--border-hairline);
    padding-bottom: var(--s-1);
  }
  section p {
    margin: 0 0 var(--s-3);
    color: var(--text-2);
  }
  section a {
    color: var(--accent);
    text-decoration: underline;
    transition: color var(--m-fast) var(--m-ease);
  }
  section a:hover {
    color: var(--accent-strong);
  }
  .steps {
    counter-reset: step;
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .steps li {
    margin-bottom: var(--s-6);
    padding-left: calc(var(--s-8) + var(--s-2));
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
    background: var(--accent);
    color: var(--accent-text);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--f-sans);
    font-weight: var(--w-sb);
  }
  .steps h3 {
    margin: var(--s-4) 0 var(--s-2);
    font-family: var(--f-sans);
    font-size: var(--t-15);
    font-weight: var(--w-sb);
    color: var(--text);
  }
  .steps p {
    margin: 0;
  }
  .cta-link {
    display: inline-block;
    margin-top: var(--s-1);
  }
  .legal-footer {
    margin-top: var(--s-8);
    padding-top: var(--s-6);
    border-top: 1px solid var(--border-hairline);
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-13);
  }
  .legal-footer strong {
    display: block;
    margin-bottom: var(--s-2);
    color: var(--text);
  }
  .legal-footer ul {
    list-style: none;
    padding: 0;
    margin: 0 0 var(--s-3);
    display: flex;
    gap: var(--s-3);
    flex-wrap: wrap;
  }
  .legal-footer ul li {
    margin: 0;
  }
  .legal-footer .contact {
    margin: 0;
  }
  @media (min-width: 768px) {
    .about-page {
      padding: var(--s-8) var(--s-6);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .cta-button,
    section a {
      transition: none;
    }
  }
</style>
