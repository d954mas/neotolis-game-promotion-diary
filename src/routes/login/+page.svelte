<script lang="ts">
  // Explicit /login route used as a redirect target by Plan 07's tenantScope
  // when an unauthenticated browser request hits a protected page. Plan 07
  // wires the redirect; this page just renders the Google sign-in button.
  // Plan 01-09: strings sourced from Paraglide (UX-04, D-17/D-18).
  import { m } from "$lib/paraglide/messages.js";
  import { signIn } from "$lib/auth-client";
</script>

<h1>{m.login_page_title()}</h1>
<button onclick={() => signIn.social({ provider: "google", callbackURL: "/" })}>
  {m.login_continue()}
</button>
