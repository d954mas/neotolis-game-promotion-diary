<!-- GSD:project-start source:PROJECT.md -->
## Project

**Neotolis Game Promotion Diary** — a self-tracking diary for indie game developers. Log promotion activity (Reddit posts, YouTube videos, conferences, blogger coverage); the service auto-pulls metrics over time and shows which actions actually moved wishlists and engagement.

Replaces messy Google Sheets / markdown files with a structured, secure, query-friendly diary.

Runs as a hosted SaaS by the author **and** as an open-source self-host install on a small VPS. The same image, schema, and code serve both modes.

### Constraints

- **Auth:** Google OAuth only. No email/password.
- **Privacy:** private by default. No public dashboards. All data scoped to `user_id`.
- **Secrets at rest:** envelope-encrypted (KEK from env, per-row DEK), write-once in UI, never logged, never returned in API responses.
- **Transport:** TLS 1.3 + HSTS. Plain HTTP only behind a TLS-terminating proxy.
- **Budget:** indie / zero-budget. Every infra component runs on a free tier or a small VPS. No paid SaaS dependency in the critical path.
- **Open-source compatibility:** identical behavior in SaaS multi-tenant mode and self-host single-tenant mode. Trusted-proxy headers honored behind any of: bare port, nginx, Caddy, Cloudflare Tunnel.
- **License:** MIT.
<!-- GSD:project-end -->

## Philosophy

This is a service. Real people use it. Some self-host it. The codebase is open. Every decision follows from those facts.

- **Simplicity for an outsider.** A developer landing on the repo for the first time must be able to read a file, follow imports, and understand what each piece does without a tour guide. No hidden cleverness, no "you have to know about X first". If a name doesn't tell you what it does, the name is wrong.
- **SaaS and self-host from one codebase.** The exact same Docker image, schema, and code runs on the author's hosted instance and on a self-hoster's VPS. Never two code paths that drift. Configuration differs (env vars, optional sidecars); behavior does not. The CI smoke gate boots the production image with no SaaS-only env vars and refuses to merge if anything depends on a managed service or a hard-coded admin allowlist.
- **Extensibility through modules.** A new feature is a new module with a clear boundary. Existing modules don't grow horizontally to accommodate new features — they stay focused on one job. Cross-cutting concerns (auth, audit, env config, queue, encryption) live in `src/lib/server/` and are imported by feature modules. A feature module never reaches into another feature module's internals.
- **Flexibility without premature abstraction.** Don't predict the future. Three concrete callers earn an abstraction; one or two does not. Feature flags are for soak windows, not for "we might want to swap this later".
- **Security as the floor.** Multi-tenant `user_id` scoping, envelope encryption for at-rest secrets, redacted logs, trusted-proxy headers, anonymous-401 sweep, cross-tenant 404 (never 403) — these are non-negotiable defaults baked into middleware and helpers. ESLint and tests enforce the load-bearing ones (e.g. only `src/lib/server/config/env.ts` may read `process.env`).

## Workflow

We work PR-only on master. No direct pushes to master.

1. **Branch.** Every change starts with a feature branch. Naming: `fix/<topic>` for bugfixes, `feat/<topic>` for features, `docs/<topic>` for docs-only, `chore/<topic>` for tooling.
2. **Plan + issue.** Before non-trivial code, capture intent. Phases use the GSD planning artifacts in `.planning/phases/<NN>-<slug>/` (`-CONTEXT.md`, `-RESEARCH.md`, `-PLAN.md`, `-VALIDATION.md`). Standalone work uses a GitHub issue with a short scope and acceptance criteria. Trivial fixes (typo, lint) can skip the issue but still go through a branch + PR.
3. **Work in the branch.** Iterate, push as needed. CI runs on every push and on PR open. Address failures before requesting review.
4. **PR to master.** Title under 70 chars, Summary section (1-3 bullets explaining the why), Test plan section. Link the issue with `Closes #N`.
5. **Squash-merge.** One PR = one commit on master. The repo is configured `delete_branch_on_merge: true`. Master stays a clean linear history of feature-sized changes.

The repo enforces this via GitHub settings:

- `allow_squash_merge: true`
- `allow_merge_commit: false`
- `allow_rebase_merge: false`
- `delete_branch_on_merge: true`
- `squash_merge_commit_title: PR_TITLE`
- `squash_merge_commit_message: PR_BODY`

CI gates every PR with three jobs: `lint-typecheck`, `unit-integration` (Postgres service container), `smoke` (production Docker image, all three roles, OAuth dance via `oauth2-mock-server`, cross-tenant + anonymous-401 invariants). Smoke is the load-bearing trust signal — when it's green, a self-host operator can deploy with confidence.

## Practices

- **Atomic PRs.** Each PR has one clear goal. If you start fixing unrelated things mid-branch, branch off a second PR — don't bundle.
- **Tests land with the feature.** Phase 1's Wave 0 placeholder pattern (every later task ships into a test that already exists) is the model. Feature code without the matching test does not merge.
- **Migrations forward-only, run at boot.** No "down" migrations. Every container boot runs `drizzle-kit migrate` under an advisory lock so multiple replicas don't race. Schema drift is caught by `pnpm db:check` in CI.
- **One source of truth for env.** `src/lib/server/config/env.ts` is the only file that reads `process.env`. ESLint enforces this.
- **Self-host parity is a CI gate.** The smoke test boots the production image with a minimal env. Any feature that needs Cloudflare-only headers, admin allowlists, or a managed service must degrade gracefully — otherwise CI fails.
- **No secrets in logs.** Pino's `redact` config covers every known credential path. Tests fail loudly if a DTO carries `googleSub` / `refreshToken` / `accessToken` / `idToken`.
- **Default to no comments.** Names should explain what code does. Comments are reserved for the WHY a future reader cannot derive — a hidden constraint, a workaround for a known bug, a non-obvious invariant.
- **Conventional Commits.** `feat(scope): ...`, `fix(scope): ...`, `docs(scope): ...`, `chore(scope): ...`. PR titles follow this so the squash commit inherits a clean subject.
- **Locked stack versions.** Versions in `package.json` are pinned for load-bearing libs (`better-auth`, `drizzle-orm`, `hono`, `pg-boss`). Bumps go through a dedicated PR with a one-line rationale.

## Stack

Node 22 LTS · TypeScript · Hono + SvelteKit · Drizzle + Postgres 16 · pg-boss (queue + cron, Postgres-native) · Better Auth + genericOAuth · Paraglide JS 2 · Pino · Vitest · Docker (one image, three roles via `APP_ROLE`).

Detailed rationale and version pins live in `.planning/research/STACK.md`. Don't replicate that here.

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

To be populated as patterns emerge. Until then, follow what's already in `src/`.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

To be populated. Follow existing patterns.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

GSD commands sit on top of the branch + PR + squash-merge rails — they generate planning artifacts and execute phases inside a feature branch. Common entry points:

- `/gsd:quick` — small fixes, doc updates, ad-hoc tasks (still on a branch + PR)
- `/gsd:debug` — investigation and bug fixing
- `/gsd:plan-phase` — produce `-PLAN.md` for an upcoming phase
- `/gsd:execute-phase` — execute a planned phase
- `/gsd:discuss-phase` — gather context before planning

Don't make direct repo edits outside a branch + PR unless explicitly asked to bypass it. Master is trunk; CI gates every change.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
