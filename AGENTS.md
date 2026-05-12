<!-- GSD:project-start source:PROJECT.md -->
## Project

**Neotolis Game Promotion Diary** — a self-tracking diary for indie game devs. Log promotion activity (YouTube, Reddit, Telegram, Twitter, Discord, conferences, press) by registering data sources and / or pasting one-off URLs; the service auto-imports content from registered sources and accumulates stats over time so the user can see — in one chronological feed — which actions actually moved wishlists and engagement.

Runs as hosted SaaS by the author **and** as an open-source self-host install on a small VPS. Same image, schema, and code serve both modes.

### Constraints

- **Auth:** Google OAuth only. No email/password.
- **Privacy:** private by default. No public dashboards. All data scoped to `user_id`.
- **Secrets at rest:** envelope-encrypted (KEK from env, per-row DEK), write-once in UI, never logged, never returned in API responses.
- **Transport:** TLS 1.3 + HSTS. Plain HTTP only behind a TLS-terminating proxy.
- **Budget:** indie / zero-budget. Every infra component runs on a free tier or a small VPS. No paid SaaS dependency in the critical path.
- **Open-source compatibility:** identical behavior in SaaS multi-tenant mode and self-host single-tenant mode. Trusted-proxy headers honored behind any of: bare port, nginx, Caddy, Cloudflare Tunnel.
- **License:** MIT.
<!-- GSD:project-end -->

## Privacy & multi-tenancy

Non-negotiable. Every endpoint, query, service, and DTO honors them. Drift is a P0 review block.

1. **Tenant scoping is mandatory and explicit.** Every service function takes `userId: string` as the first non-optional argument. Every Drizzle query against a user-owned table includes `eq(<table>.userId, userId)` in `.where(...)`. ESLint rule `eslint-plugin-tenant-scope/no-unfiltered-tenant-query` catches missing filters at lint time; `tests/integration/tenant-scope.test.ts` catches behavioral drift at CI time.
2. **Cross-tenant access returns 404, never 403.** When a service fetches a tenant-owned row scoped by `userId` and the row is missing OR owned by another user, throw `NotFoundError` from `src/lib/server/services/errors.ts`. The HTTP boundary translates to `{error: 'not_found'}` with status 404. Response body MUST NOT contain "forbidden" or "permission" for tenant-owned resources. `ForbiddenError` is reserved for admin endpoints.
3. **Anonymous-401 sweep covers every `/api/*` route.** Every new authenticated route is added to the `MUST_BE_PROTECTED` allowlist in `tests/integration/anonymous-401.test.ts`. The sweep is the vacuous-pass guard; per-route assertions are the explicit assertions. Both layers are required.
4. **Audit log is INSERT-only and tenant-relative.** `src/lib/server/audit.ts` exports `writeAudit` only — no update / delete path. Pagination uses `(user_id, created_at desc)` cursor; cursors never observe another tenant's row IDs by construction. The application database role MUST NOT have UPDATE / DELETE grants on `audit_log`.
5. **DTO discipline strips secrets at the projection layer.** Every entity has a `to<Entity>Dto` projection in `src/lib/server/dto.ts`. Ciphertext columns (`secret_ct`, `secret_iv`, `secret_tag`, `wrapped_dek`, `dek_iv`, `dek_tag`, `kek_version`) are stripped at projection time, even when the row carries them. TypeScript erases at runtime; the projection function is the actual barrier. `tests/unit/dto.test.ts` asserts the strip happens at runtime.
6. **Pino redact paths cover every credential / ciphertext field name.** `src/lib/server/logger.ts` redacts `apiKey`, `accessToken`, `refreshToken`, `idToken`, `secret`, `encrypted_*`, `wrapped_dek`, `dek`, `kek`, `Authorization`, `Cookie`. New secret-shaped field names get a redact path in the same commit.
7. **No public dashboards, share links, or read-only viewers.** No route under `/share`, `/public`, or `/embed`. Every page that renders user data is auth-gated.
8. **Self-host parity is identical to SaaS behavior.** No code path branches on `APP_MODE`. The CI smoke job boots the production image with no SaaS-only env vars and refuses to merge if anything depends on a managed service or hard-coded admin allowlist.

Anti-patterns that are P0 review blocks:

- `db.select().from(<tenant_table>).where(eq(<table>.id, ...))` without `userId` filter.
- `c.json(<row>)` after fetching a row that contains ciphertext columns.
- In-process plaintext-secret cache.
- `403 Forbidden` for cross-tenant access on tenant-owned resources (use 404).
- `try/catch` after `db.insert(...)` that "cleans up" a half-write (validate-first; INSERT only after pass).
- Reading `process.env` outside `src/lib/server/config/env.ts` (ESLint `no-restricted-properties` enforces).

## Philosophy

This is a service. Real people use it. Some self-host it. The codebase is open. Every decision follows from those facts.

- **Simplicity for an outsider.** A developer landing on the repo for the first time must read a file, follow imports, and understand each piece without a tour guide. No hidden cleverness. If a name doesn't tell you what it does, the name is wrong.
- **SaaS and self-host from one codebase.** Same Docker image, schema, and code on the author's hosted instance and on a self-hoster's VPS. Never two code paths that drift. Configuration differs (env vars, optional sidecars); behavior does not.
- **Extensibility through modules.** A new feature is a new module with a clear boundary. Existing modules don't grow horizontally — they stay focused on one job. Cross-cutting concerns (auth, audit, env config, queue, encryption) live in `src/lib/server/` and are imported by feature modules. Feature modules don't reach into each other's internals.
- **Flexibility without premature abstraction.** Don't predict the future. Three concrete callers earn an abstraction; one or two does not. Feature flags are for soak windows, not "we might want to swap this later".
- **Security as the floor.** The Privacy & multi-tenancy invariants above are defaults baked into middleware and helpers, enforced by ESLint and tests. They are the floor, not a goal.

## Workflow

PR-only on master. No direct pushes.

1. **Branch.** `fix/<topic>` for bugfixes, `feat/<topic>` for features, `docs/<topic>` for docs-only, `chore/<topic>` for tooling.
2. **Plan + issue.** Before non-trivial code, capture intent in a GitHub issue with scope + acceptance criteria. GSD phases additionally use `.planning/phases/<NN>-<slug>/` artifacts — **local-only**, never committed (issue #27). Trivial fixes can skip the issue but still go through a branch + PR.
3. **Work in the branch.** Iterate, push. CI runs on every push. Address failures before requesting review.
4. **PR to master.** Title under 70 chars, Conventional Commits scope. Summary (1-3 bullets explaining the why). Test plan. Link the issue with `Closes #N`.
5. **Squash-merge.** One PR = one commit on master. Repo is configured for squash-only and auto-deletes the branch on merge.

CI gates every PR with three jobs: `lint-typecheck`, `unit-integration` (Postgres service container), `smoke` (production Docker image, all three roles, OAuth dance via `oauth2-mock-server`, cross-tenant + anonymous-401 invariants). Smoke is the load-bearing trust signal — when it's green, a self-host operator can deploy with confidence.

The squash-merge PR body is the canonical phase record on master. `.planning/` (CONTEXT, RESEARCH, PLAN, SUMMARY, VERIFICATION, STATE, ROADMAP, debug sessions, todos) is historical context that lives only in the contributor's working copy; `gsd-tools` reads/writes it regardless of git tracking. Multi-machine sync is out of scope — copy the directory manually.

## Validation

Before any PR is handed off for human review, the agent that authored it self-reviews. Output goes in the PR body under `## Self-review`, one line per item (e.g. "Constraints: ✓ no new env reads outside config/env.ts", or "Philosophy: drift — accepted because Z").

1. **Constraints.** Walk the Constraints list. Identify which the diff touches and cite why it's compliant.
2. **Philosophy.** Walk the five Philosophy bullets. Be honest: drift is fine if justified, but must be acknowledged.
3. **Practices.** Atomic? Tests with feature? Migrations forward-only? Env reads centralized? Self-host parity holds? Secrets redaction unbroken? Comments only WHY? Conventional Commits?
4. **CI gate honesty.** Is every assertion in new tests load-bearing? If a smoke / integration test was softened, is the softening justified and tracked, or is it hiding a regression?
5. **Documentation drift.** Does `AGENTS.md`, `CLAUDE.md`, or any tracked doc now claim something the code no longer matches? Either the docs or the code moves.

After self-review, run a second-pass code review (separate agent, fresh context) and include findings as `## Self-review (second pass)`. If second-pass finds new P0/P1 issues, fix them in the same branch before handoff. The human reviewer should not be the first to catch a P0.

## Practices

- **Atomic PRs.** One clear goal per PR. If you start fixing unrelated things mid-branch, branch off a second PR.
- **Tests land with the feature.** Feature code without the matching test does not merge.
- **Migrations forward-only, run at boot.** No "down" migrations. Every container boot runs `drizzle-kit migrate` under an advisory lock so replicas don't race. `pnpm db:check` catches schema drift in CI.
- **One source of truth for env.** `src/lib/server/config/env.ts` is the only file that reads `process.env`. ESLint enforces this.
- **Self-host parity is a CI gate.** The smoke test boots the production image with a minimal env. Any feature that needs Cloudflare-only headers, admin allowlists, or a managed service must degrade gracefully.
- **No secrets in logs.** Pino's `redact` config covers every known credential path. Tests fail if a DTO carries `googleSub` / `refreshToken` / `accessToken` / `idToken`.
- **Default to no comments.** Names should explain what code does. Comments are reserved for the WHY a future reader cannot derive — a hidden constraint, a workaround for a known bug, a non-obvious invariant.
- **Conventional Commits.** `feat(scope): ...`, `fix(scope): ...`, `docs(scope): ...`, `chore(scope): ...`. PR titles follow this so the squash commit inherits a clean subject.
- **Pinned versions for load-bearing libs.** `package.json` pins `better-auth`, `drizzle-orm`, `hono`, `pg-boss`. Bumps go through a dedicated PR with a one-line rationale.
