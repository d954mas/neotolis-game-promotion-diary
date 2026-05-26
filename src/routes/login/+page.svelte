<script lang="ts">
  // Explicit /login route used as a redirect target by tenantScope when an
  // unauthenticated browser request hits a protected page. The middleware
  // wires the redirect; this page renders the Google sign-in button.
  // Strings sourced from Paraglide.
  // Early-access disclaimer below the CTA explains that auto-import isn't
  // yet wired so a new user doesn't expect "I added a YouTube channel and
  // nothing happened" to surface content immediately.
  import { m } from "$lib/paraglide/messages.js";
  import { signIn } from "$lib/auth-client";
</script>

<!--
  Centered card surface. Login is a transient page — the user sees it once
  before signing in and never again under normal flow, so the only design
  goal is "explain what's happening, do not look like a 1995 form". A
  single panel with the page title, the Google CTA, and the early-access
  disclaimer matches the visual vocabulary of every other surface in the
  app (surface + border + radius + accent CTA).
-->
<section class="login-shell">
  <article class="login-card">
    <h1 class="login-title">{m.login_page_title()}</h1>
    <button
      type="button"
      class="login-cta"
      onclick={() => signIn.oauth2({ providerId: "google", callbackURL: "/" })}
    >
      {m.login_continue()}
    </button>
    <p class="disclaimer">{m.login_early_access_disclaimer()}</p>
  </article>
</section>

<style>
  /* Login page chrome — center the card in the layout column. The shell
   * itself stretches the full layout width; the card is bounded at 420px
   * (typical sign-in card width). */
  .login-shell {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--s-8) var(--s-4);
    min-width: 0;
  }
  .login-card {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--s-4);
    width: 100%;
    max-width: 420px;
    padding: var(--s-7) var(--s-6);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-elev);
    color: var(--text);
  }
  .login-title {
    margin: 0;
    font-family: var(--f-sans);
    font-size: var(--t-22);
    font-weight: var(--w-sb);
    line-height: var(--lh-tight);
    letter-spacing: -0.01em;
    color: var(--text);
    text-align: center;
  }
  /* Primary accent CTA — solid because this is the single action on the
   * page, not an additive "+" affordance. Matches the prototype's `.btn.primary`
   * (docs/design/v2/ui-kit/index.html lines 444-449). */
  .login-cta {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: var(--hit-lg);
    padding: 0 var(--s-4);
    background: var(--accent);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-14);
    font-weight: var(--w-sb);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .login-cta:hover {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .disclaimer {
    margin: 0;
    color: var(--text-3);
    font-size: var(--t-13);
    line-height: var(--lh-body);
    text-align: center;
  }
  @media (prefers-reduced-motion: reduce) {
    .login-cta {
      transition: none;
    }
  }
</style>
