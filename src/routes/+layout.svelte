<script lang="ts">
  // Root layout — single import site for `app.css` (the only global
  // stylesheet) and host of the shared chrome (<AppHeader> + <Nav>) for
  // every authenticated route. Page <title> sourced from Paraglide so it
  // is i18n-ready.

  import "../app.css";
  import { m } from "$lib/paraglide/messages.js";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import AppHeader from "$lib/components/AppHeader.svelte";
  import Nav from "$lib/components/Nav.svelte";
  import AccountDeletedBanner from "$lib/components/AccountDeletedBanner.svelte";
  import { signOut } from "$lib/auth-client";
  import type { Snippet } from "svelte";
  import type { LayoutData } from "./$types";

  // Auth-gated noindex. Public routes that must stay indexable are
  // /login, /privacy, /terms, /about. EVERY other route emits
  // <meta name="robots" content="noindex,nofollow"> in the rendered
  // HTML head (search engines avoid private dashboards even if they
  // crawl a leaked URL). The list below mirrors the inverse of
  // +layout.server.ts PROTECTED_PATHS by enumerating the public pages
  // explicitly — adding a new public page requires updating both the
  // public list here AND the absence of an entry in PROTECTED_PATHS, so
  // drift surfaces in code review (no shared constant: the noindex
  // contract is decoupled from the redirect contract by design — a
  // public page can still be indexable while serving auth-aware UI,
  // e.g. dashboard `/`).
  //
  // The dashboard `/` (root) is currently a public landing surface that
  // renders different content for signed-in vs anonymous users. It is
  // intentionally indexable (the public landing page IS the SEO surface).
  const PUBLIC_INDEXABLE_PATHS: ReadonlySet<string> = new Set([
    "/",
    "/login",
    "/privacy",
    "/terms",
    "/about",
  ]);

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  // Map the current pathname to the Nav's six closed-list keys
  // (Feed · Sources · Games · Events · Audit · Settings). The dashboard
  // ("/") has no Nav entry — we still render <Nav> for layout
  // continuity but no item is "active". For unmapped paths we default to
  // "feed" (the default-landing target).
  type NavKey = "feed" | "sources" | "games" | "events" | "audit" | "settings" | "about" | "news";
  const navActive = $derived.by((): NavKey => {
    const p = page.url.pathname;
    if (p.startsWith("/feed")) return "feed";
    if (p.startsWith("/sources")) return "sources";
    if (p.startsWith("/games")) return "games";
    if (p.startsWith("/events")) return "events";
    if (p.startsWith("/audit")) return "audit";
    if (p.startsWith("/settings")) return "settings";
    if (p.startsWith("/about")) return "about";
    if (p.startsWith("/news")) return "news";
    return "feed";
  });

  // Emit noindex on every page that is NOT in the public-indexable
  // allowlist above. The check uses pathname startsWith for the root `/`
  // exact match (so `/feed` is NOT matched as `/`) and exact-match for
  // the 4 public pages.
  const isPublicIndexable = $derived.by((): boolean => {
    const p = page.url.pathname;
    if (p === "/") return true;
    // /news and every /news/<slug> article are public marketing content —
    // indexable by prefix (the exact-match Set can't enumerate dynamic slugs).
    if (p === "/news" || p.startsWith("/news/")) return true;
    return PUBLIC_INDEXABLE_PATHS.has(p);
  });

  async function handleSignOut(): Promise<void> {
    await signOut();
    await goto("/", { invalidateAll: true });
  }

  async function handleSignOutAllDevices(): Promise<void> {
    try {
      const res = await fetch("/api/me/sessions/all", { method: "POST" });
      if (!res.ok) return;
      await goto("/", { invalidateAll: true });
    } catch {
      // Network error — stay on the current page so the user can retry.
    }
  }

  // The sticky chrome is a SINGLE wrapper element, not two stacked
  // sticky elements. AppHeader and Nav are NON-sticky DOM children in
  // normal flow inside this wrapper; the wrapper alone is
  // `position: sticky; top: 0`. With no internal sticky relationship,
  // no internal gap or slip between AppHeader and Nav is possible by
  // construction. The only remaining sticky boundary is chrome ↔
  // PageHeader, where a 1px overlap is the defensive shim.
  //
  // The trade-off (overlap-too-small → gap; overlap-too-large → slip)
  // is FUNDAMENTAL to two independent sticky elements sharing overlap
  // math — no overlap value satisfies both at every zoom + DPR + DOM
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
      root.style.setProperty("--chrome-height", `${chrome.getBoundingClientRect().height}px`);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(chrome);
    return () => ro.disconnect();
  });
</script>

<svelte:head>
  <title>{m.app_title()}</title>
  {#if !isPublicIndexable}
    <meta name="robots" content="noindex,nofollow" />
  {/if}
</svelte:head>

<!--
  The wrapping `.layout-root` sets `display: flex; flex-direction:
  column; min-height: 100vh` so that AppHeader's `position: sticky;
  top: 0` AND per-page sticky CTAs (e.g. /sources `+ Add data source`)
  anchor to a scrolling parent. Without this scaffold `position: sticky`
  has no effect — the page-content scroll parent collapses to the
  viewport on every browser engine.
-->
<div class="layout-root">
  {#if data.user}
    <!-- Single sticky chrome wrapper (LB-1 preserved). AppHeader hosts
         Nav inside its grid layout (Phase 3.4 — RESEARCH §"Chrome Layout
         — Nav into Topbar"). At ≥768px Nav sits centered between brand
         and userchip; at <768px Nav drops to a second row inside the
         topbar's grid (preserves Phase 3.3 mobile architecture). The
         outer `.sticky-chrome` element is the ONLY sticky boundary;
         AppHeader + Nav move as one DOM unit. -->
    <div class="sticky-chrome">
      <AppHeader
        user={{ name: data.user.name, email: data.user.email, image: data.user.image }}
        theme={data.theme}
        onSignOut={handleSignOut}
        onSignOutAllDevices={handleSignOutAllDevices}
      >
        <Nav active={navActive} />
      </AppHeader>
    </div>
    {#if data.user.deletedAt}
      <!-- If a soft-deleted user is signed back in (e.g. via Google
           OAuth from a different device) and still has a viable session,
           the banner gives them a one-click restore CTA plus the
           days-remaining countdown. The banner sits BELOW the sticky
           chrome so it scrolls away with normal page content rather
           than competing with AppHeader for the top-pinned slot. -->
      <AccountDeletedBanner deletedAt={data.user.deletedAt} retentionDays={data.retentionDays} />
    {/if}
  {/if}

  <main>
    {@render children()}
  </main>
</div>

<style>
  /* Flex-column scaffold with min-height: 100vh anchors sticky
     children (AppHeader top-sticky + per-page sticky CTAs). */
  .layout-root {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }
  /* The sticky chrome wrapper. SINGLE sticky element for the AppHeader
     + Nav pair. The v2 treatment is a translucent backdrop-blurred bar
     that lets scrolled content tint through while staying legible —
     `color-mix(in oklab, var(--bg) 80%, transparent)` over `--bg` gives
     a soft scrim, `backdrop-filter` plus the `-webkit-` vendor prefix
     blurs whatever scrolls underneath, and a single `--border-hairline`
     bottom separator anchors the bar to the page below. z-index 10
     keeps the chrome above per-page sticky elements (PageHeader z:5). */
  .sticky-chrome {
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--bg);
    border-bottom: 1px solid var(--border-hairline);
  }
  main {
    flex: 1;
    max-width: var(--max-w, 1280px);
    width: 100%;
    margin: 0 auto;
    padding: var(--s-4);
    min-width: 0;
  }
  @media (min-width: 768px) {
    main {
      padding: var(--s-6);
    }
  }
</style>
