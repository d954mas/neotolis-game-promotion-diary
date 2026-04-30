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

  // Plan 02.1-39 (UAT-NOTES.md §5.4 round-6 follow-up #5): the sticky chrome
  // is a SINGLE wrapper element, not two stacked sticky elements.
  //
  // History — why this is a wrapper, not two adjacent stickies:
  //   * c7f890f          — Nav.sticky introduced; AppHeader (top: 0) and Nav
  //                        (top: --app-header-height) were two INDEPENDENT
  //                        sticky elements stacked vertically.
  //   * 273904d          — round-6 #1: ResizeObserver writes runtime height
  //                        to fix a 4-5px slip from the static 72px fallback.
  //   * e91bd29          — round-6 #2: Math.ceil() to close subpixel gap; the
  //                        gap moved one tier downstream to PageHeader.
  //   * 435697e          — round-6 #3: raw fractional + 1px overlap. Gap
  //                        eliminated at 100% zoom; reappeared at non-100%.
  //   * 419e3c7          — round-6 #4: --sticky-overlap bumped to 4px.
  //                        Gap gone, but Nav now visibly slips UP by 4px on
  //                        scroll-start before locking. User quote (verbatim):
  //                        "Зазора нет, но есть небольшой скрол табов feed
  //                        sources что выглядит как артефакт" ("No gap, but
  //                        the Feed/Sources tabs do a small scroll on engage
  //                        that looks like an artifact").
  //   * THIS COMMIT (#5) — eliminate the AppHeader↔Nav boundary entirely.
  //                        Wrap both in a single <div.sticky-chrome>; that
  //                        wrapper is the only sticky element. AppHeader and
  //                        Nav become non-sticky DOM children in normal flow
  //                        within the wrapper. With no internal sticky
  //                        relationship, no internal gap or slip is possible
  //                        by construction. The only remaining sticky
  //                        boundary is chrome ↔ PageHeader, where the proven
  //                        1px overlap from 435697e is reinstated as the
  //                        single-tier defensive shim.
  //
  // The trade-off (overlap-too-small → gap; overlap-too-large → slip) is
  // FUNDAMENTAL to two independent sticky elements sharing overlap math —
  // there is no overlap value that satisfies both at every zoom + DPR + DOM
  // engine. Removing the boundary removes the trade-off.
  //
  // We still measure runtime chrome height for PageHeader.sticky's `top:`
  // calc — PageHeader sticks below the chrome wrapper, so it needs the
  // wrapper's real height. ResizeObserver on the wrapper writes the
  // fractional rect height to `--chrome-height` on `:root`. Static fallback
  // 116px (= 72px AppHeader + 44px Nav) covers SSR / pre-effect / no-JS.
  $effect(() => {
    if (!data.user) return;
    if (typeof window === "undefined") return;
    const chrome = document.querySelector(".sticky-chrome") as HTMLElement | null;
    if (!chrome) return;
    const root = document.documentElement;
    const sync = (): void => {
      root.style.setProperty(
        "--chrome-height",
        `${chrome.getBoundingClientRect().height}px`,
      );
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(chrome);
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
    <!-- Plan 02.1-39 round-6 #5: single sticky chrome wrapper. AppHeader and
         Nav are NON-sticky in normal flow inside this wrapper; the wrapper
         alone is `position: sticky; top: 0`. See $effect comment above for
         the full iteration timeline that led here. -->
    <div class="sticky-chrome">
      <AppHeader
        user={{ name: data.user.name, email: data.user.email, image: data.user.image }}
        theme={data.theme}
        onSignOut={handleSignOut}
        onSignOutAllDevices={handleSignOutAllDevices}
      />
      <Nav active={navActive} />
    </div>
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
  /* Plan 02.1-39 round-6 #5: the sticky chrome wrapper. This is the SINGLE
     sticky element for the AppHeader + Nav pair. Background fill prevents
     scrolled content from showing through; matches AppHeader's own
     `--color-surface` so the wrapper is visually invisible. z-index 10
     keeps the chrome above per-page sticky elements (PageHeader z:5). */
  .sticky-chrome {
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--color-surface);
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
