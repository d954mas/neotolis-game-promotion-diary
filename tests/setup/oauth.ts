// oauth2-mock-server lifecycle helpers — D-13 mechanism per CONTEXT.md <deviations> 2026-04-27.
//
// Plan 01-05 (Wave 3) wires Better Auth to point at this mock; Plan 01-10 (Wave 5) drives the
// happy-path smoke through it. Phase 1 Wave 0 lands the helpers as a stable API so later
// plans don't need to invent the lifecycle shape.
//
// Why a sidecar mock instead of mocking Better Auth internals:
//   - Failures point at our integration code, not at a mocked-too-deep abstraction.
//   - Same code path runs in CI smoke (image talks to mock over HTTP) and integration tests.
//   - oauth2-mock-server mints valid id_tokens with configurable claims (iss, sub, email, etc.)
//     so we exercise Better Auth's real Google-provider verification path.

// Lazy import — keeps `tests/unit/**` from pulling oauth2-mock-server when not needed.
type MockServer = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  // oauth2-mock-server exposes an issuer with a JWKS-signing keystore + a service that mints tokens.
  // Surface kept loose here; Plan 05 narrows when Better Auth integration lands.
  issuer: { url: string; keys: { generate(alg: string): Promise<unknown> } };
  service: {
    tokenTtl: number;
    buildResponse: (claims: Record<string, unknown>) => Promise<{ id_token: string }>;
  };
};

let server: MockServer | null = null;

export async function startMockOauth(port = 9090): Promise<MockServer> {
  if (server) return server;
  // @ts-expect-error — oauth2-mock-server is a Plan 01-01 dev dep; types may lag.
  const { OAuth2Server } = await import('oauth2-mock-server');
  const instance = new OAuth2Server() as MockServer;
  await instance.issuer.keys.generate('RS256');
  // The lib's start() takes (port, host) but tolerates undefined host = 0.0.0.0
  // We bind to 127.0.0.1 in CI to keep the surface local-only.
  // @ts-expect-error — start signature varies between minor versions; runtime ignores extras.
  await instance.start(port, '127.0.0.1');
  server = instance;
  return instance;
}

export async function stopMockOauth(): Promise<void> {
  if (!server) return;
  await server.stop();
  server = null;
}

// Mint an id_token with the given claims. Plan 05 uses this in integration tests to bypass
// the OAuth redirect dance — the mock returns a token and Better Auth verifies it.
export async function mintIdToken(
  userClaims: {
    sub: string;
    email: string;
    name?: string;
    picture?: string;
    email_verified?: boolean;
  },
): Promise<string> {
  if (!server) {
    throw new Error('oauth mock not started — call startMockOauth() first');
  }
  const { id_token } = await server.service.buildResponse({
    iss: server.issuer.url,
    aud: process.env.GOOGLE_CLIENT_ID ?? 'ci-mock-client-id',
    email_verified: true,
    ...userClaims,
  });
  return id_token;
}
