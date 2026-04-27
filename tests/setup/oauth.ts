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
//     so we exercise Better Auth's real Google-provider verification path.
//
// INFO I2 (issuer URL handling): Better Auth 1.6.x's `socialProviders.google` does NOT
// expose an `issuer` or `discoveryUrl` field — the Google endpoints are hardcoded inside
// the provider. The Path 3 fallback from plan 01-05 <execution_notes> applies: this module
// configures the mock to mint id_tokens with `iss: 'https://accounts.google.com'` so
// Better Auth's strict-issuer validation accepts the mock-issued tokens. See
// `setNextUserClaims` below — the `beforeTokenSigning` hook coerces the `iss` claim.

// @ts-expect-error — oauth2-mock-server (CJS) types may lag in this TS config.
import { OAuth2Server } from "oauth2-mock-server";

// Loose surface — oauth2-mock-server's emit/on signatures vary across minor versions.
// We talk to it via the documented event names: `beforeTokenSigning`, `beforeUserinfo`.
type MockServer = {
  start: (port?: number, host?: string) => Promise<void>;
  stop: () => Promise<void>;
  issuer: {
    url: string | null;
    keys: { generate(alg: string): Promise<unknown> };
  };
  service: {
    on: (event: string, handler: (...args: unknown[]) => void) => void;
    removeAllListeners: (event?: string) => void;
    buildResponse?: (
      claims: Record<string, unknown>,
    ) => Promise<{ id_token: string }>;
  };
};

let server: MockServer | null = null;

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
    const instance = new OAuth2Server() as MockServer;
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
 * INFO I2 (Path 3): the `beforeTokenSigning` hook below ALSO overrides
 * `token.payload.iss = 'https://accounts.google.com'` so Better Auth 1.6's
 * google provider (which has hardcoded `iss` validation) accepts the
 * mock-issued token. The mock allows arbitrary issuer claims by design.
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
      // INFO I2 Path 3: coerce the issuer to Google's so Better Auth 1.6's
      // google provider (which has hardcoded `iss` validation) accepts.
      iss: "https://accounts.google.com",
      sub: claims.sub,
      email: claims.email,
      email_verified: true,
      name: claims.name,
      picture: claims.picture,
    };
  });
}

/**
 * Mint an id_token directly with the given claims. Plan 10's smoke test uses
 * this for the rare case where bypassing the redirect dance is cheaper than
 * driving the full OAuth flow. Most integration tests should prefer
 * `seedUserDirectly` from tests/integration/helpers.ts.
 */
export async function mintIdToken(userClaims: {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
  email_verified?: boolean;
}): Promise<string> {
  if (!server) {
    throw new Error("oauth mock not started — call startMockOauth() first");
  }
  if (!server.service.buildResponse) {
    throw new Error(
      "oauth2-mock-server build target lacks buildResponse — upgrade oauth2-mock-server",
    );
  }
  const { id_token } = await server.service.buildResponse({
    iss: "https://accounts.google.com", // INFO I2 Path 3
    aud: process.env.GOOGLE_CLIENT_ID ?? "ci-mock-client-id",
    email_verified: true,
    ...userClaims,
  });
  return id_token;
}
