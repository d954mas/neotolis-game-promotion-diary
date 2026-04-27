/**
 * tests/smoke/lib/oauth-mock-driver.ts
 *
 * Plan 01-10 — D-13 mechanism per CONTEXT.md `<deviations>` 2026-04-27 maps
 * D-13 ("mocked OAuth in CI") onto the `oauth2-mock-server` package. This
 * helper is invoked from `tests/smoke/self-host.sh` and drives the full
 * Better Auth OAuth round-trip:
 *
 *   1. Start oauth2-mock-server on the requested port (default 9090).
 *   2. Configure the mock to mint an id_token + userinfo for the requested
 *      user (`sub` / `email` / `name`).
 *   3. Hit Better Auth's genericOAuth signin URL on the running app
 *      container (POST /api/auth/sign-in/oauth2 with body
 *      { providerId: "google" }).
 *   4. Follow redirects manually with `redirect: 'manual'`, accumulating a
 *      cookie jar across hops. Better Auth stores `state` / `code-verifier`
 *      in HTTP-only cookies during the OAuth dance — the jar must replay
 *      them on every hop or the callback rejects the response.
 *   5. Print `neotolis.session_token=<value>` to stdout (one line, no
 *      trailing newline) so bash can `$()`-capture and replay the cookie
 *      against `/api/me` and `/`.
 *
 * INFO I2 (issuer URL handling) — RESOLVED via the genericOAuth plugin
 * (review blocker P0-2 fix). Better Auth's genericOAuth plugin reads the
 * issuer from the discovery document at boot, so the mock's natural issuer
 * URL (http://localhost:9090) flows through unchanged. The previous mock-
 * side `iss` coercion to https://accounts.google.com is no longer needed.
 *
 * Better Auth route shape (genericOAuth plugin):
 *   POST /api/auth/sign-in/oauth2
 *     body: { providerId: "google", callbackURL: "/" }
 *     -> 200 JSON `{ url: '<mock-authorize-url>?...', redirect: true }`
 *   GET  /api/auth/oauth2/callback/google?code=...&state=...
 *     -> 302 to `/` (or the original callbackURL) with
 *        Set-Cookie: neotolis.session_token=...; Path=/; HttpOnly; ...
 *
 * Usage (from bash):
 *   pnpm tsx tests/smoke/lib/oauth-mock-driver.ts \
 *     --app-url http://localhost:3000 \
 *     --mock-port 9090 \
 *     --sub user-a-sub \
 *     --email a@test.local \
 *     --name "User A"
 */

// @ts-expect-error — oauth2-mock-server (CJS) types may lag in this TS config.
import { OAuth2Server } from "oauth2-mock-server";

interface Args {
  appUrl: string;
  mockPort: number;
  sub: string;
  email: string;
  name: string;
}

interface MockServer {
  start: (port?: number, host?: string) => Promise<void>;
  stop: () => Promise<void>;
  issuer: {
    url: string | null;
    keys: { generate(alg: string): Promise<unknown> };
  };
  service: {
    on: (event: string, handler: (...args: unknown[]) => void) => void;
    removeAllListeners: (event?: string) => void;
  };
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string => {
    const i = argv.indexOf(flag);
    if (i === -1 || i === argv.length - 1) {
      throw new Error(`missing arg: ${flag}`);
    }
    return argv[i + 1]!;
  };
  return {
    appUrl: get("--app-url"),
    mockPort: parseInt(get("--mock-port"), 10),
    sub: get("--sub"),
    email: get("--email"),
    name: get("--name"),
  };
}

/**
 * Resolve a possibly-relative redirect Location against the request URL.
 * Better Auth callback returns `Location: /` (relative); mock authorize
 * returns absolute `http://localhost:9090/...`.
 */
function resolveLocation(location: string, base: string): string {
  if (/^https?:/i.test(location)) return location;
  return new URL(location, base).toString();
}

/**
 * Parse a single Set-Cookie header value into [name, value].
 * Cookie attributes (Path, HttpOnly, Secure, SameSite, Expires, Max-Age)
 * come after the first `;` — we strip them. The cookie jar replays only
 * `name=value` on subsequent requests; that's what every browser does.
 */
function parseSetCookie(setCookie: string): [string, string] | null {
  const firstSemi = setCookie.indexOf(";");
  const pair = firstSemi === -1 ? setCookie : setCookie.slice(0, firstSemi);
  const eq = pair.indexOf("=");
  if (eq === -1) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;
  return [name, value];
}

/**
 * Read all Set-Cookie headers from a Response. Node's undici fetch exposes
 * `getSetCookie()` (Node 22+), but be defensive in case it's missing.
 */
function readSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & {
    getSetCookie?: () => string[];
  };
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  // Fallback: comma-split a single Set-Cookie header. Imperfect (cookies
  // with `Expires=...` contain commas) but Node 22's fetch always exposes
  // getSetCookie() so this branch is mostly defensive.
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

async function main(): Promise<void> {
  const args = parseArgs();

  const server = new OAuth2Server() as MockServer;
  await server.issuer.keys.generate("RS256");
  await server.start(args.mockPort, "127.0.0.1");

  try {
    // Reset previous handlers so successive driver invocations from the
    // same bash process see only the current claims.
    server.service.removeAllListeners("beforeUserinfo");
    server.service.removeAllListeners("beforeTokenSigning");

    server.service.on("beforeUserinfo", (...handlerArgs: unknown[]) => {
      const userInfo = handlerArgs[0] as {
        body: Record<string, unknown>;
        statusCode: number;
      };
      userInfo.body = {
        sub: args.sub,
        email: args.email,
        name: args.name,
        email_verified: true,
      };
      userInfo.statusCode = 200;
    });

    server.service.on("beforeTokenSigning", (...handlerArgs: unknown[]) => {
      const token = handlerArgs[0] as { payload: Record<string, unknown> };
      token.payload = {
        ...token.payload,
        // Mock's natural iss flows through (matches the discovery document
        // Better Auth's genericOAuth plugin fetched at boot).
        sub: args.sub,
        email: args.email,
        email_verified: true,
        name: args.name,
        aud: process.env.GOOGLE_CLIENT_ID ?? "mock-client-id",
      };
    });

    // Drive Better Auth's genericOAuth signin entry point:
    //   POST /api/auth/sign-in/oauth2
    //     body: { providerId: 'google', callbackURL: '/' }
    //   -> 200 JSON { url: '<mock authorize URL>', redirect: true }
    //
    // We then follow redirects manually, accumulating cookies. Better
    // Auth sets `neotolis.state` + `neotolis.pkce` (or similar) HTTP-only
    // cookies during the dance; on the callback hop those cookies are
    // verified — the jar must replay them.
    const jar = new Map<string, string>();
    const initialUrl = `${args.appUrl}/api/auth/sign-in/oauth2`;
    const initialBody = JSON.stringify({
      providerId: "google",
      callbackURL: "/",
    });

    const initial = await fetch(initialUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: initialBody,
    });

    // Capture cookies set by the initial sign-in call (state / pkce).
    for (const sc of readSetCookies(initial)) {
      const parsed = parseSetCookie(sc);
      if (parsed) jar.set(parsed[0], parsed[1]);
    }

    // Better Auth returns either:
    //   - 302 with Location: <authorize URL> (form-style)
    //   - 200 with JSON { url: '<authorize URL>', redirect: true } (fetch-style)
    let nextUrl: string | null = null;
    if (initial.status >= 300 && initial.status < 400) {
      const loc = initial.headers.get("location");
      if (loc) nextUrl = resolveLocation(loc, initialUrl);
    } else if (initial.status === 200) {
      const json = (await initial.json()) as { url?: string };
      if (json && typeof json.url === "string") {
        nextUrl = json.url;
      }
    }

    if (!nextUrl) {
      console.error(
        "[oauth-mock-driver] sign-in did not return a redirect URL",
        "status=",
        initial.status,
      );
      process.exit(1);
    }

    // Follow redirects manually. Hops bound to 10 — the OAuth dance is
    // typically: app -> mock authorize -> mock authorize callback (auto)
    // -> app callback -> app /. Five hops in the worst case; 10 is slack.
    let currentUrl: string | null = nextUrl;
    let hops = 0;
    while (currentUrl && hops < 10) {
      hops++;
      const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
      const res: Response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: cookieHeader ? { cookie: cookieHeader } : {},
      });

      for (const sc of readSetCookies(res)) {
        const parsed = parseSetCookie(sc);
        if (parsed) jar.set(parsed[0], parsed[1]);
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        currentUrl = loc ? resolveLocation(loc, currentUrl) : null;
      } else {
        currentUrl = null;
      }
    }

    // Better Auth's cookie name is `${cookiePrefix}.session_token`. Plan 05
    // locked the prefix to `neotolis`. In production with `useSecureCookies`
    // the name is prefixed with `__Secure-`; the smoke test runs over plain
    // HTTP (NODE_ENV=test or unset), so the unprefixed name applies.
    const sessionTokenValue = jar.get("neotolis.session_token");
    if (!sessionTokenValue) {
      console.error(
        "[oauth-mock-driver] no session cookie set after",
        hops,
        "hops. Captured jar:",
        JSON.stringify([...jar.entries()]),
      );
      process.exit(1);
    }

    // Print exactly the cookie key=value (no trailing newline) so bash can
    // `$()` capture without `tail`-trimming. The script consumes this as
    // the `cookie:` request header on the next curl.
    process.stdout.write(`neotolis.session_token=${sessionTokenValue}`);
    process.exit(0);
  } finally {
    try {
      await server.stop();
    } catch {
      // The driver process exits via process.exit; mock-server stop
      // failure is non-fatal here.
    }
  }
}

main().catch((err) => {
  console.error("[oauth-mock-driver] failed:", err);
  process.exit(2);
});
