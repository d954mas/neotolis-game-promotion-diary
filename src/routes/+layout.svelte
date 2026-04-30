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

  // Map the current pathname to the Nav's six closed-list keys (Phase 2.1
  // reshuffle: Feed · Sources · Games · Events · Audit · Settings — UI-SPEC
  // §"<Nav>" delta). The dashboard ("/") has no Nav entry — we still render
  // <Nav> for layout continuity but no item is "active". For unmapped paths
  // we default to "feed" (the new default-landing per RESEARCH §3.6).
  type NavKey = "feed" | "sources" | "games" | "events" | "audit" | "settings";
  const navActive = $derived.by((): NavKey => {
    const p = page.url.pathname;
    if (p.startsWith("/feed")) return "feed";
    if (p.startsWith("/sources")) return "sources";
    if (p.startsWith("/games")) return "games";
    if (p.startsWith("/events")) return "events";
    if (p.startsWith("/audit")) return "audit";
    if (p.startsWith("/settings")) return "settings";
    return "feed";
  });

  async function handleSignOut(): Promise<void> {
    await signOut();
    await goto("/", { invalidateAll: true });
  }

  async function handleSignOutAllDevices(): Promise<void> {
    await fetch("/api/me/sessions/all", { method: "POST" });
    await goto("/", { invalidateAll: true });
  }

  // Plan 02.1-39 (UAT-NOTES.md §5.4 round-6 follow-up): keep the sticky-stack
  // CSS vars in sync with the actually-rendered chrome heights.
  //
  // Round-6 first pass shipped static fallbacks `--app-header-height: 72px`
  // and `--nav-height: 44px` in src/app.css. UAT user feedback (verbatim):
  // "есть странный эффект у табов(feed, Source и тд) есть неболшой скролл,
  // а потом оно фиксируется. Выглядит так что когда я начинаю скрол то там
  // есть 4-5 пикселя скроад". Root cause: AppHeader's actual rendered height
  // (padding `--space-md` × 2 + avatar 28px + brand line-height) is ~76-78px,
  // not 72px. Nav's `top: var(--app-header-height)` therefore sat 4-5px BELOW
  // AppHeader's bottom edge, so sticky engaged only after the user scrolled
  // through that gap.
  //
  // Fix: a ResizeObserver on the rendered <header.header> and <nav.nav>
  // pushes their `offsetHeight` (border-box, includes padding + border) onto
  // :root as `--app-header-height` / `--nav-height`. Static fallbacks in
  // src/app.css remain for SSR and the brief tick before this $effect runs.
  // We query the DOM directly rather than threading `bind:this` props through
  // AppHeader / Nav — both components always render here, and a wrapping
  // <div bind:this> would create a new offsetParent that breaks `position:
  // sticky` for the children.
  $effect(() => {
    // Read `data.user` so the effect re-runs when chrome mounts/unmounts on
    // sign-in / sign-out — `<AppHeader>` and `<Nav>` only render under
    // `{#if data.user}` so their DOM nodes don't exist for anonymous routes.
    if (!data.user) return;
    if (typeof window === "undefined") return;
    const appHeader = document.querySelector("header.header") as HTMLElement | null;
    const nav = document.querySelector("nav.nav") as HTMLElement | null;
    if (!appHeader || !nav) return;
    const root = document.documentElement;
    const sync = (): void => {
      root.style.setProperty("--app-header-height", `${appHeader.offsetHeight}px`);
      root.style.setProperty("--nav-height", `${nav.offsetHeight}px`);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(appHeader);
    ro.observe(nav);
    return () => ro.disconnect();
  });
</script>

<svelte:head>
  <title>{m.app_title()}</title>
</svelte:head>

<!--
  Plan 02.1-22 (UAT-NOTES.md §2.2-bug closure): the wrapping `.layout-root`
  sets `display: flex; flex-direction: column; min-height: 100vh` so that
  AppHeader's `position: sticky; top: 0` AND per-page sticky CTAs (e.g.
  /sources `+ Add data source`) anchor to a scrolling parent. Without this
  scaffold `position: sticky` has no effect — the page-content scroll
  parent collapses to the viewport on every browser engine.
-->
<div class="layout-root">
  {#if data.user}
    <AppHeader
      user={{ name: data.user.name, email: data.user.email, image: data.user.image }}
      theme={data.theme}
      onSignOut={handleSignOut}
      onSignOutAllDevices={handleSignOutAllDevices}
    />
    <Nav active={navActive} />
  {/if}

  <main>
    {@render children()}
  </main>
</div>

<style>
  /* Plan 02.1-22: flex-column scaffold w/ min-height: 100vh anchors sticky
     children (AppHeader top-sticky + per-page sticky CTAs). */
  .layout-root {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }
  main {
    flex: 1;
    max-width: 1024px;
    width: 100%;
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
