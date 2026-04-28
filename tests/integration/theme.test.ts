import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";

// Seed env BEFORE importing the module under test (matches the established
// pattern in tests/unit/audit-append-only.test.ts). hooks.server.ts has a
// value-import on `auth` from $lib/auth.js, which loads env.ts at module
// init via auth-adapter.ts → envelope.ts → config/env.ts.
//
// CI sets these via secrets; this fallback only fires on local dev runs
// where no `.env` file is present. The values are placeholders sized to
// pass env.ts's zod schema (BETTER_AUTH_SECRET min length, KEK 32 bytes).
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "x".repeat(40);
process.env.OAUTH_CLIENT_ID ??= "test";
process.env.OAUTH_CLIENT_SECRET ??= "test";
process.env.APP_KEK_BASE64 ??= randomBytes(32).toString("base64");

const { eq, and } = await import("drizzle-orm");
const { themeHandle } = await import("../../src/hooks.server.js");
const { createApp } = await import("../../src/lib/server/http/app.js");
const { db } = await import("../../src/lib/server/db/client.js");
const { user } = await import("../../src/lib/server/db/schema/auth.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { seedUserDirectly } = await import("./helpers.js");

/**
 * Plan 02-09 — UX-01 theme cookie + DB persist.
 *
 * Wave 0 placeholder names PRESERVED — the three `02-09: UX-01 ...` it.skip
 * stubs from Plan 02-01 are flipped here. The third (cookie-wins
 * reconciliation on signin) stays as `it.skip` with a Plan 10 deferral
 * annotation: the wire is in src/routes/+layout.server.ts which Plan 10
 * amends, so attempting it here would either duplicate Plan 10 work or
 * vacuous-pass against an unwired endpoint.
 */
describe("theme cookie + DB persist (UX-01)", () => {
  it("02-09: UX-01 SSR no flash (locals.theme set before handler)", async () => {
    // The SSR no-flash contract has two halves:
    //   1. event.locals.theme is populated BEFORE the page handler runs
    //      (so any +page.server.ts can read it).
    //   2. transformPageChunk replaces the literal `%theme%` placeholder in
    //      app.html with the resolved value, so the first byte the browser
    //      sees already carries data-theme="dark" (no FOUC).
    //
    // We test both by calling themeHandle directly with a synthetic event +
    // resolve mock. This avoids booting the full SvelteKit handler (which
    // requires `pnpm build` to have produced build/handler.js — only true
    // in CI / smoke).
    const cookieMap = new Map<string, string>([["__theme", "dark"]]);
    const event = {
      cookies: { get: (k: string) => cookieMap.get(k) },
      locals: {} as { theme?: "light" | "dark" | "system" },
      request: new Request("http://localhost/"),
    } as unknown as Parameters<typeof themeHandle>[0]["event"];

    let capturedTransform: ((c: { html: string }) => string) | undefined;
    const resolve = (async (
      _e: unknown,
      opts?: { transformPageChunk?: (c: { html: string }) => string },
    ) => {
      capturedTransform = opts?.transformPageChunk;
      return new Response("ok");
    }) as Parameters<typeof themeHandle>[0]["resolve"];

    await themeHandle({ event, resolve });

    // Half (1): event.locals.theme populated.
    expect((event.locals as { theme?: string }).theme).toBe("dark");

    // Half (2): transformPageChunk replaces %theme% with the cookie value.
    expect(capturedTransform).toBeDefined();
    const original = '<html lang="en" data-theme="%theme%">';
    const rewritten = capturedTransform!({ html: original });
    expect(rewritten).toBe('<html lang="en" data-theme="dark">');
    expect(rewritten).not.toMatch(/%theme%/);
  });

  it("02-09: UX-01 themeHandle defaults to 'system' on missing/invalid cookie", async () => {
    // Defense-in-depth check: an absent or rogue cookie value MUST resolve
    // to 'system' rather than blow up or leak the rogue string into
    // data-theme. The SET membership check in themeHandle covers this.
    for (const cookieValue of [undefined, "evil", ""]) {
      const cookieMap = new Map<string, string>();
      if (cookieValue !== undefined) cookieMap.set("__theme", cookieValue);
      const event = {
        cookies: { get: (k: string) => cookieMap.get(k) },
        locals: {},
        request: new Request("http://localhost/"),
      } as unknown as Parameters<typeof themeHandle>[0]["event"];

      let capturedTransform: ((c: { html: string }) => string) | undefined;
      const resolve = (async (
        _e: unknown,
        opts?: { transformPageChunk?: (c: { html: string }) => string },
      ) => {
        capturedTransform = opts?.transformPageChunk;
        return new Response("ok");
      }) as Parameters<typeof themeHandle>[0]["resolve"];

      await themeHandle({ event, resolve });
      expect((event.locals as { theme?: string }).theme).toBe("system");
      expect(capturedTransform!({ html: '<html data-theme="%theme%">' })).toBe(
        '<html data-theme="system">',
      );
    }
  });

  it("02-09: UX-01 POST /api/me/theme updates cookie + DB + audits theme.changed", async () => {
    const app = createApp();
    const u = await seedUserDirectly({ email: "th@test.local" });

    const res = await app.request("/api/me/theme", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ theme: "dark" }),
    });
    expect(res.status).toBe(200);

    // Set-Cookie carries __theme=dark with the right attributes and NO
    // HttpOnly (Pitfall 5 — SvelteKit's client-side runtime reads the
    // cookie pre-paint to flip CSS classes).
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("__theme=dark");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=31536000");
    expect(setCookie).not.toMatch(/HttpOnly/i);

    // DB row updated.
    const [row] = await db.select().from(user).where(eq(user.id, u.id)).limit(1);
    expect(row).toBeDefined();
    expect(row!.themePreference).toBe("dark");

    // Audit row exists with `{from, to}` metadata.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "theme.changed")))
      .limit(5);
    expect(auditRows.length).toBe(1);
    const meta = auditRows[0]!.metadata as Record<string, unknown>;
    expect(meta).toMatchObject({ from: "system", to: "dark" });
  });

  it("Plan 02.1-09: AppHeader does NOT render ThemeToggle (relocation to /settings)", async () => {
    // UI-SPEC §"`<AppHeader>` UI polish": theme toggle is REMOVED from the
    // header in Phase 2.1 (P1 UAT — clutter on every page). The toggle
    // relocates to /settings only. We render <AppHeader> server-side and
    // assert the theme-toggle's stable selector (aria-label) is absent.
    const { render } = await import("svelte/server");
    const AppHeader = (
      await import("../../src/lib/components/AppHeader.svelte")
    ).default;
    const out = render(AppHeader, {
      props: {
        user: { name: "Test", email: "test@example.com", image: null },
        theme: "system" as const,
      },
    });
    const html = out.body;
    // The ThemeToggle's stable selector is its aria-label "Toggle color theme"
    // (m.theme_toggle_aria_label()).
    expect(html).not.toContain("Toggle color theme");
  });

  it("Plan 02.1-09: ThemeToggle renders exactly once on /settings (relocation)", async () => {
    // The same ThemeToggle's aria-label appears exactly once on /settings.
    // We render the toggle directly here (the full settings page requires
    // a parent layout context that's not trivial to seed in unit/integration
    // tests; the structural relocation is validated by /settings/+page.svelte
    // importing ThemeToggle and the AppHeader test above asserting it's gone
    // from the header). One on-disk grep verifies there's no second toggle.
    const { render } = await import("svelte/server");
    const ThemeToggle = (
      await import("../../src/lib/components/ThemeToggle.svelte")
    ).default;
    const out = render(ThemeToggle, { props: { current: "system" as const } });
    const html = out.body;
    expect(html).toContain("Toggle color theme");
    // The settings page is the sole consumer in 2.1.
    const fs = await import("node:fs");
    const settings = fs.readFileSync(
      "src/routes/settings/+page.svelte",
      "utf8",
    );
    expect(settings).toContain("ThemeToggle");
    const header = fs.readFileSync(
      "src/lib/components/AppHeader.svelte",
      "utf8",
    );
    expect(header).not.toContain("ThemeToggle");
  });

  it("02-10: UX-01 cookie wins on signin reconciliation (+layout.server.ts)", async () => {
    // Plan 10 wires the cookie-wins reconciliation in
    // src/routes/+layout.server.ts. When an authenticated user has a valid
    // __theme cookie that disagrees with the DB themePreference, the
    // cookie wins — the DB is updated to match.
    //
    // We exercise the layout-server `load` directly with a synthetic event
    // (rather than booting build/handler.js) — the same pattern the SSR
    // no-flash tests use for themeHandle. The reconciliation has no audit
    // side-effect (it's a sync, not a user action), so the only observable
    // is: (a) the returned `theme` matches the cookie value; (b) the DB
    // row's themePreference now equals the cookie.
    const { load: layoutLoad } = await import("../../src/routes/+layout.server.js");
    const u = await seedUserDirectly({ email: "rec@test.local" });

    // Seed the DB so the user starts at "system"; cookie wants "dark".
    await db.update(user).set({ themePreference: "system" }).where(eq(user.id, u.id));

    const cookieMap = new Map<string, string>([["__theme", "dark"]]);
    const cookies = {
      get: (k: string) => cookieMap.get(k),
      set: (k: string, v: string) => {
        cookieMap.set(k, v);
      },
    };
    const event = {
      locals: {
        user: { id: u.id, email: u.email, name: "rec", image: null },
        theme: "dark" as const,
      },
      url: new URL("http://localhost/games"),
      cookies,
      request: new Request("http://localhost/games"),
      params: {},
      route: { id: null },
      isDataRequest: false,
      isSubRequest: false,
      fetch: globalThis.fetch,
      setHeaders: () => {},
      depends: () => {},
      parent: async () => ({}),
      untrack: <T>(fn: () => T) => fn(),
    } as unknown as Parameters<typeof layoutLoad>[0];

    const result = await layoutLoad(event);

    // Cookie won — the layout returns the cookie value.
    expect((result as { theme?: string }).theme).toBe("dark");

    // DB row now matches the cookie.
    const [row] = await db
      .select({ themePreference: user.themePreference })
      .from(user)
      .where(eq(user.id, u.id))
      .limit(1);
    expect(row!.themePreference).toBe("dark");
  });
});
