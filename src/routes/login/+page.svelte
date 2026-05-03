<script lang="ts">
  // Explicit /login route used as a redirect target by Plan 07's tenantScope
  // when an unauthenticated browser request hits a protected page. Plan 07
  // wires the redirect; this page just renders the Google sign-in button.
  // Plan 01-09: strings sourced from Paraglide (UX-04, D-17/D-18).
  // Plan 02.2-04 (D-12): early-access disclaimer below the CTA prevents the
  // "I added a YouTube channel and nothing happened" confusion that would
  // otherwise hit every new user pre-Phase-3 (auto-import lands in Phase 3).
  import { m } from "$lib/paraglide/messages.js";
  import { signIn } from "$lib/auth-client";
</script>

<h1>{m.login_page_title()}</h1>
<button onclick={() => signIn.social({ provider: "google", callbackURL: "/" })}>
  {m.login_continue()}
</button>
<p class="disclaimer">{m.login_early_access_disclaimer()}</p>

<style>
  .disclaimer {
    margin-top: var(--space-md);
    color: var(--color-text-muted);
    font-size: var(--font-size-label);
    line-height: var(--line-height-body);
    max-width: 60ch;
  }
</style>
