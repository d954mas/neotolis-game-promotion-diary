<script lang="ts">
  // Dashboard placeholder — Phase 1 shipped sign-in / sign-out plumbing here;
  // Plan 02-10 lightly extends with links to the four primary destinations
  // (Games / Events / Audit / Settings) per UI-SPEC §"/ (existing dashboard,
  // lightly extended)". The shared chrome (AppHeader + Nav) is rendered by
  // +layout.svelte for authenticated visitors.
  //
  // Plan 01-09: every user-facing string flows through Paraglide's compiled
  // m.* exports (UX-04, D-17 baseLocale only, D-18 single messages file at
  // root).
  import { m } from "$lib/paraglide/messages.js";
  import { signIn } from "$lib/auth-client";
  let { data } = $props();
</script>

{#if data.user}
  <h1>{m.dashboard_title()}</h1>
  <p>{m.dashboard_welcome_intro({ name: data.user.name })}</p>
  <nav class="dashboard-links" aria-label="Dashboard">
    <a href="/games">Games</a>
    <a href="/events">Events</a>
    <a href="/audit">Audit log</a>
    <a href="/settings">Settings</a>
  </nav>
{:else}
  <h1>{m.dashboard_title()}</h1>
  <p>{m.dashboard_unauth_intro()}</p>
  <button onclick={() => signIn.social({ provider: "google", callbackURL: "/" })}>
    {m.login_button()}
  </button>
{/if}

<style>
  .dashboard-links {
    display: flex;
    gap: var(--space-md);
    flex-wrap: wrap;
    margin-top: var(--space-md);
  }
  .dashboard-links a {
    color: var(--color-accent);
    text-decoration: none;
    padding: var(--space-sm) var(--space-md);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
  }
  .dashboard-links a:hover {
    text-decoration: underline;
  }
</style>
