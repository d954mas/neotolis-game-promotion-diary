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

<h1>{m.login_page_title()}</h1>
<button onclick={() => signIn.oauth2({ providerId: "google", callbackURL: "/" })}>
  {m.login_continue()}
</button>
<p class="disclaimer">{m.login_early_access_disclaimer()}</p>

<style>
  .disclaimer {
    margin-top: var(--s-4);
    color: var(--text-2);
    font-size: var(--t-13);
    line-height: var(--lh-body);
    max-width: 60ch;
  }
</style>
