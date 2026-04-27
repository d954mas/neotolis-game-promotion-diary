// oauth2-mock-server lifecycle helpers — D-13 mechanism per CONTEXT.md <deviations> 2026-04-27.
//
// Plan 01-05 (this plan) uses the lifecycle wrappers in integration tests; Plan 01-10
// drives the happy-path smoke through the same mock. Phase 1 Wave 0 landed an early
// stub; Plan 01-05 (Wave 3) finalizes the API.
//
// Why a sidecar mock instead of mocking Better Auth internals:
//   - Failures point at our integration code, not at a mocked-too-deep abstraction.
//   - Same code path runs in CI smoke (image talks to mock over HTTP) and integration tests.
//   - oauth2-mock-server mints valid id_tokens with configurable claims (iss, sub, email, etc.)
//     so we exercise Better Auth's real OAuth verification path via the genericOAuth plugin.
//
// INFO I2 (issuer URL handling) — RESOLVED via the genericOAuth plugin (review blocker
// P0-2 fix). Better Auth 1.6.x's `socialProviders.google` hardcodes the Google endpoints,
// so we switched to the genericOAuth plugin (providerId: "google") which exposes
// `discoveryUrl`. The mock's iss is whatever discovery returns (the mock's own issuer URL),
// so the previous mock-side `iss` coercion to https://accounts.google.com is no longer
// needed. We keep the mock's natural issuer claim so Better Auth's strict-issuer
// validation matches the discovery document the plugin fetched at boot.

import { OAuth2Server } from "oauth2-mock-server";

let server: OAuth2Server | null = null;

export interface MockOauthHandle {
  issuerUrl: string;
  stop: () => Promise<void>;
}

/**
 * Boot the mock OAuth2 server on the given port. Idempotent — calling twice
 * returns the existing handle.
 */
export async function startMockOauth(port = 9090): Promise<MockOauthHandle> {
  if (!server) {
    const instance = new OAuth2Server();
    await instance.issuer.keys.generate("RS256");
    // Bind to 127.0.0.1 in CI to keep the surface local-only.
    await instance.start(port, "127.0.0.1");
    server = instance;
  }
  const issuerUrl = server.issuer.url ?? `http://localhost:${port}`;
  return {
    issuerUrl,
    stop: stopMockOauth,
  };
}

export async function stopMockOauth(): Promise<void> {
  if (!server) return;
  await server.stop();
  server = null;
}

/**
 * Claim shape minted by the mock server. `sub` becomes `account.account_id`
 * (the Google subject identifier, aka "google_sub" — never returned to the
 * browser, see src/lib/server/dto.ts P3 discipline).
 */
export interface MockUserClaims {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

/**
 * Configure the mock server's NEXT issued id_token + userinfo response.
 *
 * INFO I2 (resolved): the `beforeTokenSigning` hook lets the mock's natural
 * issuer claim flow through — Better Auth's genericOAuth plugin learned the
 * issuer from the discovery document the plugin fetched at boot, so the
 * mock-issued token's iss already matches. We only override claims the test
 * needs to control (sub / email / etc).
 */
export function setNextUserClaims(claims: MockUserClaims): void {
  if (!server) {
    throw new Error("oauth2-mock-server not started — call startMockOauth() first");
  }
  // Reset previous handlers so successive tests see only the current claims.
  server.service.removeAllListeners("beforeUserinfo");
  server.service.removeAllListeners("beforeTokenSigning");

  server.service.on("beforeUserinfo", (...args: unknown[]) => {
    const userInfo = args[0] as {
      body: Record<string, unknown>;
      statusCode: number;
    };
    userInfo.body = {
      sub: claims.sub,
      email: claims.email,
      name: claims.name,
      picture: claims.picture,
      email_verified: true,
    };
    userInfo.statusCode = 200;
  });

  server.service.on("beforeTokenSigning", (...args: unknown[]) => {
    const token = args[0] as { payload: Record<string, unknown> };
    token.payload = {
      ...token.payload,
      // Mock's natural iss flows through (matches the discovery document
      // Better Auth's genericOAuth plugin fetched at boot).
      sub: claims.sub,
      email: claims.email,
      email_verified: true,
      name: claims.name,
      picture: claims.picture,
    };
  });
}

// `mintIdToken` was an early stub for direct id_token minting; oauth2-mock-server
// 7.x does not expose a public `buildResponse` API, and the integration suite
// drives the full OAuth dance through `setNextUserClaims` + Better Auth's
// genericOAuth plugin (review blocker P0-2 fix). Removed to keep the surface
// honest. See tests/integration/helpers.ts `seedUserDirectly` for the cheaper
// "skip OAuth, seed a session row" path most specs use.
