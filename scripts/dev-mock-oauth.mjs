#!/usr/bin/env node
// Standalone oauth2-mock-server for LOCAL DEV (pnpm dev) only.
//
// Why this exists:
//   tests/setup/oauth.ts boots the mock per-test via vitest hooks. There's
//   no equivalent for `pnpm dev` because integration tests don't drive the
//   browser — they call seedUserDirectly(). This script fills that gap so
//   an operator can sign in via "Sign in with Google" in the dev browser
//   without touching production Google OAuth credentials.
//
// Usage:
//   pnpm dev:mock-oauth          # default — admin@test.local
//   pnpm dev:mock-oauth -- --email user@test.local --sub user-local
//
// Lifetime:
//   Foreground process, ctrl-C to stop. Run in its own terminal alongside
//   `pnpm dev`. Both must be up for browser sign-in to work.

import { OAuth2Server } from "oauth2-mock-server";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const PORT = Number(arg("--port", 9090));
const SUB = arg("--sub", "admin-local");
const EMAIL = arg("--email", "admin@test.local");
const NAME = arg("--name", "Admin Local");

const server = new OAuth2Server();
await server.issuer.keys.generate("RS256");

server.service.on("beforeUserinfo", (userInfo) => {
  userInfo.body = {
    sub: SUB,
    email: EMAIL,
    email_verified: true,
    name: NAME,
  };
});

server.service.on("beforeTokenSigning", (token) => {
  Object.assign(token.payload, {
    sub: SUB,
    email: EMAIL,
    email_verified: true,
    name: NAME,
  });
});

await server.start(PORT, "127.0.0.1");

console.log(`mock OAuth running on http://localhost:${PORT}`);
console.log(`discovery: http://localhost:${PORT}/.well-known/openid-configuration`);
console.log(`will mint claims: sub=${SUB} email=${EMAIL} name="${NAME}"`);
console.log("");
console.log("Match this email against ADMIN_EMAIL_ALLOWLIST in .env.local");
console.log("for /admin/quota access. Ctrl-C to stop.");

const shutdown = async () => {
  console.log("\nstopping mock OAuth...");
  await server.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
