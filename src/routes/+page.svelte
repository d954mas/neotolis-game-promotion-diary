<script lang="ts">
  // Phase 1 dashboard placeholder. Either prompts the user to sign in
  // (AUTH-01 happy path) or shows a "your dashboard is empty" stub for
  // returning users (AUTH-02 sign-out hook lives on the same page).
  // Phase 2 lands real game cards in this slot.
  // Plan 01-09: every user-facing string flows through Paraglide's compiled m.*
  // exports (UX-04, D-17 baseLocale only, D-18 single messages file at root).
  import { m } from "$lib/paraglide/messages.js";
  import { signIn, signOut } from "$lib/auth-client";
  let { data } = $props();
</script>

{#if data.user}
  <h1>{m.dashboard_title()}</h1>
  <p>{m.dashboard_welcome_intro({ name: data.user.name })}</p>
  <button onclick={() => signOut()}>{m.sign_out()}</button>
{:else}
  <h1>{m.dashboard_title()}</h1>
  <p>{m.dashboard_unauth_intro()}</p>
  <button onclick={() => signIn.social({ provider: "google", callbackURL: "/" })}>
    {m.login_button()}
  </button>
{/if}
