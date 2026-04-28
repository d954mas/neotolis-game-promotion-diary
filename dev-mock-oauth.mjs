// Local dev OAuth mock — injects sub/email/name claims so Better Auth doesn't
// trip over `email_is_missing`. Runs until you Ctrl+C. Not committed (gitignored).

import { OAuth2Server } from "oauth2-mock-server";

const PORT = 9090;
const SUB = "dev-user-001";
const EMAIL = "dev@neotolis.local";
const NAME = "Dev User";

const server = new OAuth2Server();
await server.issuer.keys.generate("RS256");

server.service.on("beforeUserinfo", (userInfo) => {
  userInfo.body = { sub: SUB, email: EMAIL, name: NAME, email_verified: true };
  userInfo.statusCode = 200;
});

server.service.on("beforeTokenSigning", (token) => {
  token.payload = {
    ...token.payload,
    sub: SUB,
    email: EMAIL,
    email_verified: true,
    name: NAME,
    aud: process.env.OAUTH_CLIENT_ID ?? "mock-client-id",
  };
});

await server.start(PORT, "127.0.0.1");
console.log(`mock OAuth ready on http://127.0.0.1:${PORT} as ${EMAIL} (${SUB})`);
