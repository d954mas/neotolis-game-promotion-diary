// Client-side Better Auth helpers for SvelteKit components.
//
// `createAuthClient` ships hooks/helpers (signIn, signOut, useSession) that
// talk to the Better Auth handler mounted in src/hooks.server.ts (Plan 01-06).
//
// Same-origin: in dev and prod the SvelteKit app and the Better Auth handler
// live behind one origin. When the SaaS deployment uses a wildcard cookie
// domain, the server config in src/lib/auth.ts handles cross-subdomain via
// `advanced.crossSubDomainCookies` — no client-side baseURL knob needed.

import { createAuthClient } from "better-auth/svelte";
import { genericOAuthClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  // baseURL omitted — relative URLs work for same-origin (default).
  // genericOAuthClient mirrors the server-side genericOAuth plugin (see
  // src/lib/auth.ts) and adds `signIn.oauth2({ providerId, callbackURL })`
  // which posts to /api/auth/sign-in/oauth2. Without this plugin the
  // client tries `signIn.social({ provider: "google" })` which targets
  // /api/auth/sign-in/social/google — a route that does NOT exist in our
  // backend (we use genericOAuth, not socialProviders). Calling it 500s.
  plugins: [genericOAuthClient()],
});

export const signIn = authClient.signIn;
export const signOut = authClient.signOut;
export const useSession = authClient.useSession;
