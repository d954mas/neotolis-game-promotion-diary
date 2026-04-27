<script lang="ts">
  // Phase 1 dashboard placeholder. Either prompts the user to sign in
  // (AUTH-01 happy path) or shows a "your dashboard is empty" stub for
  // returning users (AUTH-02 sign-out hook lives on the same page).
  // Phase 2 lands real game cards in this slot.
  // Plan 01-09: every user-facing string flows through Paraglide's compiled m.*
  // exports (UX-04, D-17 baseLocale only, D-18 single messages file at root).
  import { goto } from "$app/navigation";
  import { m } from "$lib/paraglide/messages.js";
  import { signIn, signOut } from "$lib/auth-client";
  let { data } = $props();

  // D-08: sign-out-from-all-devices. POSTs to /api/me/sessions/all (mounted in
  // src/lib/server/http/routes/sessions.ts behind tenantScope). The route
  // deletes every session row for the current user — including this one — so
  // the next page load sees no session and lands on the login flow. Force a
  // navigation to / immediately so the user isn't stuck on a stale dashboard.
  async function signOutAllDevices(): Promise<void> {
    await fetch("/api/me/sessions/all", { method: "POST" });
    await goto("/", { invalidateAll: true });
  }
</script>

{#if data.user}
  <h1>{m.dashboard_title()}</h1>
  <p>{m.dashboard_welcome_intro({ name: data.user.name })}</p>
  <button onclick={() => signOut()}>{m.sign_out()}</button>
  <button onclick={signOutAllDevices}>{m.sign_out_all_devices()}</button>
{:else}
  <h1>{m.dashboard_title()}</h1>
  <p>{m.dashboard_unauth_intro()}</p>
  <button onclick={() => signIn.social({ provider: "google", callbackURL: "/" })}>
    {m.login_button()}
  </button>
{/if}
