<script lang="ts">
  // Shared marketing landing rendered by both `/+page.svelte` (anonymous
  // canonical landing) and `/about/+page.svelte` (alias + Nav About tab +
  // back-links from /privacy /terms). `<link rel="canonical">` points both
  // to `/` so Google treats `/` as canonical and `/about` as an alias.
  //
  // The page is THEME-LOCKED dark (the product screenshots are dark and a
  // marketing surface reads best as one committed theme): the `.landing`
  // root redefines the dark design tokens locally, so it renders dark even
  // when the app theme is light.
  //
  // CTA is auth-adaptive: anonymous visitors get "Sign in with Google";
  // signed-in visitors (who can reach /about via Nav) get "Open the app".
  // Marketing copy is hardcoded English (single-locale app); the meta/footer
  // strings reuse the existing about_* paraglide keys.
  import { m } from "$lib/paraglide/messages.js";
  import { signIn } from "$lib/auth-client";

  type NewsTeaser = {
    slug: string;
    date: string;
    dateDisplay: string;
    title: string;
    summary: string;
    cover: string | null;
    coverAlt: string;
  };
  type AboutData = {
    supportEmail: string;
    domain: string;
    user: { id: string; email: string; name: string | null } | null;
    latestNews: NewsTeaser[];
  };

  let { data }: { data: AboutData } = $props();

  const GITHUB = "https://github.com/d954mas/neotolis-game-promotion-diary";
  const RUNBOOK = `${GITHUB}/blob/master/docs/deploy/install.md`;
  const loggedIn = $derived(!!data.user);
  const footerCtx = $derived({
    supportEmail: data.supportEmail || "(support email not configured)",
  });

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

{#snippet ctas()}
  <div class="ctas">
    {#if loggedIn}
      <a class="btn primary" href="/feed">Open the app</a>
    {:else}
      <button type="button" class="btn primary" onclick={handleSignIn}>Sign in with Google</button>
    {/if}
    <a class="btn ghost" href={GITHUB} target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" aria-hidden="true"
        ><path d="M12 3v12" /><path d="M7 11l5 4 5-4" /><path d="M4 20h16" /></svg
      >Self-host it</a
    >
  </div>
{/snippet}

<main class="landing">
  <!-- inline glyph defs (platform + trust icons) -->
  <svg width="0" height="0" style="position: absolute" aria-hidden="true"
    ><defs
      ><g
        id="g-yt"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        ><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M10 9.5l5 2.5-5 2.5z" /></g
      ><g
        id="g-ig"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        ><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle
          cx="17"
          cy="7"
          r="1.1"
          fill="currentColor"
          stroke="none"
        /></g
      ><g
        id="g-tg"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"><path d="M21 4L3 11l5 2 2 6 3-4 5 4z" /><path d="M8 13l8-5" /></g
      ><g id="g-x"
        ><path
          d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
          fill="currentColor"
        /></g
      ><g id="g-tt"
        ><path
          d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"
          fill="currentColor"
        /></g
      ><g id="g-snoo" fill="none" stroke="currentColor" stroke-width="1.75"
        ><circle cx="18.5" cy="5" r="1.4" fill="currentColor" stroke="none" /><path
          d="M14.7 11.2 17.5 6.5"
        /><circle cx="12" cy="13.5" r="6.5" fill="currentColor" stroke="none" /><circle
          cx="7"
          cy="9.5"
          r="1.6"
          fill="currentColor"
          stroke="none"
        /><circle cx="17" cy="9.5" r="1.6" fill="currentColor" stroke="none" /><circle
          cx="9.5"
          cy="13"
          r="1.1"
          fill="#0e0e10"
          stroke="none"
        /><circle cx="14.5" cy="13" r="1.1" fill="#0e0e10" stroke="none" /><path
          d="M9.5 16c1.5 1.2 3.5 1.2 5 0"
          stroke="#0e0e10"
          stroke-width="1.2"
        /></g
      ><g
        id="g-lock"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        ><rect x="4.5" y="10.5" width="15" height="10" rx="2" /><path
          d="M8 10.5V7a4 4 0 0 1 8 0v3.5"
        /></g
      ><g
        id="g-dl"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        ><path d="M12 3v12" /><path d="M7 11l5 4 5-4" /><path d="M4 20h16" /></g
      ><g
        id="g-code"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"><path d="M9 7l-5 5 5 5" /><path d="M15 7l5 5-5 5" /></g
      ></defs
    ></svg
  >

  <!-- HERO -->
  <section class="hero">
    <div class="hero-inner">
      <div class="hero-copy">
        <p class="eyebrow">Promo tracker for indie game devs</p>
        <h1>See what actually moved your <span class="hl">wishlists</span>.</h1>
        <p class="sub">
          One diary for every promo you run. Auto-import your channels, log the rest, watch the
          curve.
        </p>
        {@render ctas()}
      </div>
      <div class="hero-shot">
        <img
          src="/landing/wishlist-chart.webp"
          alt="Wishlist growth chart with promo events pinned along the curve"
          loading="eager"
          fetchpriority="high"
          width="1200"
          height="861"
        />
      </div>
    </div>
    <div class="works">
      <span class="works-label">Auto-imports from</span>
      <span class="pf"><svg viewBox="0 0 24 24"><use href="#g-yt" /></svg>YouTube</span>
      <span class="pf"><svg viewBox="0 0 24 24"><use href="#g-snoo" /></svg>Reddit</span>
      <span class="pf"><svg viewBox="0 0 24 24"><use href="#g-tg" /></svg>Telegram</span>
      <span class="pf"><svg viewBox="0 0 24 24"><use href="#g-ig" /></svg>Instagram</span>
      <span class="pf"><svg viewBox="0 0 24 24"><use href="#g-tt" /></svg>TikTok</span>
      <span class="pf"><svg viewBox="0 0 24 24"><use href="#g-x" /></svg>X</span>
      <span class="pf muted">plus press, conferences</span>
    </div>
  </section>

  <!-- PROBLEM + HOW IT WORKS -->
  <section class="band">
    <div class="shead">
      <h2>Your promo lives in ten places. Your results live nowhere.</h2>
      <p>
        A YouTube drop here, a Reddit thread there, a conference talk, a press hit. Weeks later: did
        any of it move wishlists? Promotion diary keeps every action in one feed, next to the
        numbers.
      </p>
    </div>
    <ol class="flow">
      <li class="fstep">
        <span class="n">1</span>
        <h3>Connect your channels</h3>
        <p>
          Add your YouTube, Reddit, Telegram, Instagram, TikTok or X. New posts auto-import with
          their stats.
        </p>
      </li>
      <li class="fstep">
        <span class="n">2</span>
        <h3>Log everything else</h3>
        <p>
          Conference talks, press features, Discord drops. Anything that does not auto-import,
          logged in two taps.
        </p>
      </li>
      <li class="fstep">
        <span class="n">3</span>
        <h3>See what moved the needle</h3>
        <p>
          Import your Steam wishlist CSV and watch promos pinned against the curve. Learn what
          actually worked.
        </p>
      </li>
    </ol>
  </section>

  <!-- FEED -->
  <section class="band">
    <div class="split">
      <div class="feed-shot">
        <img
          src="/landing/feed.webp"
          alt="Chronological feed of promo events, each with its per-post stats"
          loading="lazy"
          width="1000"
          height="877"
        />
      </div>
      <div class="split-copy">
        <h2>Every promo, one chronological feed.</h2>
        <ul class="feats">
          <li>
            <span class="ck" aria-hidden="true">&#10003;</span>Auto-imported posts arrive with
            views, likes, comments, score.
          </li>
          <li>
            <span class="ck" aria-hidden="true">&#10003;</span>Filter by game, platform, content
            type or date range.
          </li>
          <li>
            <span class="ck" aria-hidden="true">&#10003;</span>Tag each event to a game so the
            wishlist chart can pin it.
          </li>
        </ul>
      </div>
    </div>
  </section>

  <!-- TRUST -->
  <section class="band">
    <div class="shead"><h2>Private by default. Open source. Self-hostable.</h2></div>
    <div class="trust">
      <div class="tc">
        <h3>
          <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#g-lock" /></svg>Private by default
        </h3>
        <p>
          No public dashboards, no share links. Your data is scoped to you, secrets are
          envelope-encrypted at rest, Google sign-in only.
        </p>
      </div>
      <div class="tc">
        <h3>
          <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#g-dl" /></svg>Self-host in minutes
        </h3>
        <p>
          Same image, same schema, same code. Run it on a small VPS behind nginx, Caddy or a
          Cloudflare Tunnel. <a href={RUNBOOK} target="_blank" rel="noopener">Read the runbook</a>.
        </p>
      </div>
      <div class="tc">
        <h3>
          <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#g-code" /></svg>MIT open source
        </h3>
        <p>
          The whole thing is on <a href={GITHUB} target="_blank" rel="noopener">GitHub</a>. Read it,
          fork it, run it. No lock-in, no black box.
        </p>
      </div>
    </div>
  </section>

  {#if data.latestNews.length > 0}
    <!-- WHAT'S NEW -->
    <section class="news-teaser">
      <div class="nt-head">
        <h2>What's new</h2>
        <a class="nt-all" href="/news">All updates &rarr;</a>
      </div>
      <div class="nt-grid">
        {#each data.latestNews as post (post.slug)}
          <a class="nt-tile" href="/news/{post.slug}">
            {#if post.cover}
              <div class="nt-cover"><img src={post.cover} alt="" loading="lazy" /></div>
            {/if}
            <time datetime={post.date}>{post.dateDisplay}</time>
            <h3>{post.title}</h3>
          </a>
        {/each}
      </div>
    </section>
  {/if}

  <!-- FINAL CTA -->
  <section class="band">
    <div class="final">
      <h2>{loggedIn ? "Back to your diary." : "Start your promo diary."}</h2>
      <p>Free hosted, or self-host it yourself. Either way, your data stays yours.</p>
      {@render ctas()}
    </div>
  </section>

  <!-- FOOTER -->
  <footer class="foot">
    <span>&#169; 2026 Neotolis, Promotion diary</span>
    <nav>
      <a href="/news">News</a>
      <a href="/privacy">{m.about_links_privacy()}</a>
      <a href="/terms">{m.about_links_terms()}</a>
      <a href={GITHUB} target="_blank" rel="noopener">GitHub</a>
      {#if data.domain}<a href="https://{data.domain}">{m.about_canonical_instance_label()}</a>{/if}
    </nav>
    {#if data.supportEmail}<span class="contact">{m.about_footer_contact(footerCtx)}</span>{/if}
  </footer>
</main>

<style>
  /* THEME-LOCKED dark marketing landing. The `.landing` root redefines the
   * dark token values locally so the page is dark even under a light app
   * theme (the screenshots are dark; one committed theme reads best). */
  .landing {
    --bg: #0e0e10;
    --surface: #16161a;
    --surface-2: #1c1c21;
    --border: #2b2b31;
    --border-2: #393940;
    --hair: rgba(255, 255, 255, 0.07);
    --text: #ececee;
    --text-2: #b0b0b7;
    --text-3: #8a8a92;
    --accent: #e89b5e;
    --accent-strong: #f3ae73;
    --accent-soft: rgba(232, 155, 94, 0.12);
    --success: #6fb36a;
    background: var(--bg);
    color: var(--text);
    font-family: var(--f-sans);
  }
  .landing :global(a) {
    color: inherit;
  }
  .hero,
  .band {
    max-width: 1120px;
    margin: 0 auto;
    padding-left: 40px;
    padding-right: 40px;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 44px;
    padding: 0 20px;
    border-radius: 9px;
    font-family: var(--f-sans);
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
    text-decoration: none;
    white-space: nowrap;
  }
  .btn svg {
    width: 15px;
    height: 15px;
    stroke: currentColor;
  }
  .btn.primary {
    background: var(--accent);
    color: #0e0e10;
    box-shadow: 0 2px 10px rgba(232, 155, 94, 0.12);
    transition:
      background var(--m-fast) var(--m-ease),
      box-shadow var(--m-fast) var(--m-ease);
  }
  .btn.primary:hover {
    background: var(--accent-strong);
  }
  .btn.ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-2);
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .btn.ghost:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .ctas {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    align-items: center;
  }

  /* HERO */
  .hero {
    position: relative;
    overflow: hidden;
    padding-top: 36px;
    padding-bottom: 8px;
  }
  .hero::before {
    content: "";
    position: absolute;
    top: -300px;
    left: 46%;
    width: 820px;
    height: 640px;
    background: radial-gradient(closest-side, rgba(232, 155, 94, 0.13), transparent 72%);
    pointer-events: none;
  }
  .hero-inner {
    display: grid;
    grid-template-columns: 1fr 0.9fr;
    gap: 48px;
    align-items: center;
    padding: 26px 0 44px;
    position: relative;
  }
  .eyebrow {
    margin: 0 0 18px;
    font-family: var(--f-mono);
    font-size: 12px;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .hero h1 {
    margin: 0 0 20px;
    font-size: clamp(34px, 4.2vw, 48px);
    line-height: 1;
    letter-spacing: -0.03em;
    font-weight: 780;
    color: var(--text);
    text-wrap: balance;
  }
  .hero h1 .hl {
    color: var(--accent);
  }
  .sub {
    margin: 0 0 28px;
    font-size: 18px;
    line-height: 1.55;
    color: var(--text-2);
    max-width: 32ch;
  }
  .hero-shot,
  .feed-shot {
    border-radius: 14px;
    overflow: hidden;
    border: 1px solid var(--border-2);
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
  }
  .hero-shot img,
  .feed-shot img {
    display: block;
    width: 100%;
    height: auto;
  }
  /* works-with strip */
  .works {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
    padding: 20px 0 4px;
    border-top: 1px solid var(--hair);
  }
  .works-label {
    font-family: var(--f-mono);
    font-size: 12px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  .pf {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 13.5px;
    color: var(--text-2);
  }
  .pf svg {
    width: 16px;
    height: 16px;
    color: var(--text-3);
  }
  .pf.muted {
    color: var(--text-3);
  }

  /* sections */
  .band {
    padding-top: 70px;
    padding-bottom: 70px;
    border-top: 1px solid var(--hair);
  }
  .shead {
    max-width: 640px;
    margin-bottom: 42px;
  }
  .shead h2 {
    margin: 0 0 14px;
    font-size: clamp(26px, 3.4vw, 34px);
    line-height: 1.1;
    letter-spacing: -0.02em;
    font-weight: 720;
    color: var(--text);
    text-wrap: balance;
  }
  .shead p {
    margin: 0;
    font-size: 16px;
    line-height: 1.6;
    color: var(--text-2);
  }

  /* step flow (not boxed cards) */
  .flow {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0;
    position: relative;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .flow::before {
    content: "";
    position: absolute;
    top: 15px;
    left: 8%;
    right: 8%;
    height: 1px;
    background: var(--border);
  }
  .fstep {
    padding: 0 24px;
    position: relative;
  }
  .fstep:not(:last-child)::after {
    content: "";
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 1px;
    background: var(--hair);
  }
  .fstep .n {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--bg);
    border: 1px solid var(--accent);
    color: var(--accent-strong);
    display: grid;
    place-items: center;
    font-family: var(--f-mono);
    font-weight: 700;
    font-size: 13px;
    margin-bottom: 18px;
    position: relative;
  }
  .fstep h3 {
    margin: 0 0 8px;
    font-size: 17px;
    color: var(--text);
  }
  .fstep p {
    margin: 0;
    font-size: 14px;
    line-height: 1.55;
    color: var(--text-2);
  }

  /* feed split */
  .split {
    display: grid;
    grid-template-columns: 1.1fr 0.9fr;
    gap: 48px;
    align-items: center;
  }
  .split-copy h2 {
    margin: 0;
    font-size: clamp(26px, 3.2vw, 32px);
    letter-spacing: -0.02em;
    line-height: 1.12;
    font-weight: 720;
    color: var(--text);
  }
  .feats {
    list-style: none;
    padding: 0;
    margin: 18px 0 0;
    display: flex;
    flex-direction: column;
    gap: 13px;
  }
  .feats li {
    display: flex;
    gap: 11px;
    font-size: 15px;
    color: var(--text-2);
  }
  .feats .ck {
    color: var(--accent);
    flex: 0 0 auto;
  }

  /* trust strip — icon + title + text, generously gapped (no column dividers,
     so it reads differently from the numbered step-flow above). */
  .trust {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 32px;
  }
  .tc {
    padding: 0;
  }
  .tc h3 {
    margin: 0 0 9px;
    font-size: 16px;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .tc h3 svg {
    width: 17px;
    height: 17px;
    color: var(--accent);
  }
  .tc p {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--text-2);
  }
  .tc a {
    color: var(--accent);
    text-decoration: underline;
  }
  .tc a:hover {
    color: var(--accent-strong);
  }

  /* final cta */
  .final {
    position: relative;
    overflow: hidden;
    text-align: center;
    border-radius: 20px;
    border: 1px solid var(--border-2);
    padding: 60px 40px;
    background:
      radial-gradient(120% 140% at 50% 0%, rgba(232, 155, 94, 0.1), transparent 60%), var(--surface);
  }
  .final h2 {
    margin: 0 0 14px;
    font-size: clamp(28px, 3.6vw, 36px);
    letter-spacing: -0.02em;
    color: var(--text);
  }
  .final p {
    margin: 0 0 26px;
    color: var(--text-2);
    font-size: 16px;
  }
  .final .ctas {
    justify-content: center;
  }

  .foot {
    max-width: 1120px;
    margin: 0 auto;
    padding: 30px 40px 48px;
    border-top: 1px solid var(--hair);
    color: var(--text-3);
    font-size: 13px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
  }
  .foot nav {
    display: flex;
    gap: 20px;
    flex-wrap: wrap;
  }
  .foot a {
    color: var(--text-3);
    text-decoration: none;
  }
  .foot a:hover {
    color: var(--text);
  }
  .foot .contact {
    color: var(--text-3);
  }

  /* mobile: collapse every grid to a single column */
  @media (max-width: 860px) {
    .hero-inner,
    .split,
    .flow,
    .trust {
      grid-template-columns: 1fr;
      gap: 28px;
    }
    .flow::before {
      display: none;
    }
    .fstep,
    .tc {
      padding: 0;
    }
    .fstep:not(:last-child)::after {
      display: none;
    }
    .split .feed-shot {
      order: 2;
    }
    .hero,
    .band,
    .foot {
      padding-left: 22px;
      padding-right: 22px;
    }
  }

  /* WHAT'S NEW teaser */
  .news-teaser {
    max-width: 1120px;
    margin: 0 auto;
    padding: var(--s-8) var(--s-5);
  }
  .nt-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s-4);
    margin-bottom: var(--s-6);
  }
  .nt-head h2 {
    margin: 0;
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    letter-spacing: -0.01em;
  }
  .nt-all {
    font-size: var(--t-14);
    color: var(--text-2);
    text-decoration: none;
    white-space: nowrap;
  }
  .nt-all:hover {
    color: var(--text);
  }
  .nt-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 360px));
    justify-content: start;
    gap: var(--s-5);
  }
  .nt-tile {
    display: block;
    color: var(--text);
    text-decoration: none;
  }
  .nt-cover {
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border-radius: var(--r-md);
    border: 1px solid var(--border-hairline);
    margin-bottom: var(--s-3);
  }
  .nt-cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition: transform var(--m-med, 0.25s) var(--m-ease, ease);
  }
  .nt-tile:hover .nt-cover img {
    transform: scale(1.03);
  }
  .nt-tile time {
    display: block;
    color: var(--text-3);
    font-size: var(--t-13);
  }
  .nt-tile h3 {
    margin: var(--s-1) 0 0;
    font-size: var(--t-17);
    font-weight: var(--w-sb);
    line-height: 1.3;
  }
  .nt-tile:hover h3 {
    color: var(--accent);
  }

  @media (prefers-reduced-motion: reduce) {
    .btn.primary,
    .btn.ghost {
      transition: none;
    }
    .nt-cover img {
      transition: none;
    }
    .nt-tile:hover .nt-cover img {
      transform: none;
    }
  }
</style>
