<script lang="ts">
  // Plan 02-10: the root layout is the single import site for `app.css`
  // (UI-SPEC §"Design System" — "the only global stylesheet is src/app.css
  // imported once from src/routes/+layout.svelte"), and the host of the
  // shared chrome (<AppHeader> + <Nav>) for every authenticated route.
  //
  // Plan 01-09: page <title> sourced from Paraglide so it is i18n-ready
  // (UX-04, D-17/D-18).

  import "../app.css";
  import { m } from "$lib/paraglide/messages.js";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import AppHeader from "$lib/components/AppHeader.svelte";
  import Nav from "$lib/components/Nav.svelte";
  import { signOut } from "$lib/auth-client";
  import type { Snippet } from "svelte";
  import type { LayoutData } from "./$types";

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  // Map the current pathname to the Nav's six closed-list keys. The
  // dashboard ("/") has no Nav entry — we still render <Nav> for layout
  // continuity but no item is "active". For unmapped paths we default to
  // "games" (the most common landing).
  type NavKey = "games" | "events" | "audit" | "accounts" | "keys" | "settings";
  const navActive = $derived.by((): NavKey => {
    const p = page.url.pathname;
    if (p.startsWith("/events")) return "events";
    if (p.startsWith("/audit")) return "audit";
    if (p.startsWith("/accounts")) return "accounts";
    if (p.startsWith("/keys")) return "keys";
    if (p.startsWith("/settings")) return "settings";
    return "games";
  });

  async function handleSignOut(): Promise<void> {
    await signOut();
    await goto("/", { invalidateAll: true });
  }

  async function handleSignOutAllDevices(): Promise<void> {
    await fetch("/api/me/sessions/all", { method: "POST" });
    await goto("/", { invalidateAll: true });
  }
</script>

<svelte:head>
  <title>{m.app_title()}</title>
</svelte:head>

{#if data.user}
  <AppHeader
    user={{ name: data.user.name, email: data.user.email }}
    theme={data.theme}
    onSignOut={handleSignOut}
    onSignOutAllDevices={handleSignOutAllDevices}
  />
  <Nav active={navActive} />
{/if}

<main>
  {@render children()}
</main>

<style>
  main {
    max-width: 1024px;
    margin: 0 auto;
    padding: var(--space-md);
    min-width: 0;
  }
  @media (min-width: 768px) {
    main {
      padding: var(--space-2xl);
    }
  }
</style>
