# Phase 02.2 deferred items

## Pre-existing unit test failures (out of scope for Plan 02.2-06)

Three unit test files / one assertion fail on the baseline (before Plan 02.2-06
landed any change). All are caused by env vars not being seeded before module
import in the test environment. These are unrelated to deploy templates.

- tests/unit/dto.test.ts — env not seeded
- tests/unit/feed-loader.test.ts — env not seeded
- tests/unit/logger.test.ts > logger redaction > Plan 02.1-36 — env not seeded

Verified pre-existing via `git stash && pnpm test:unit -- tests/unit/logger.test.ts`
on commit c28ba9a (Plan 02.2-06 task 2 baseline).

Plan 02.2-06's 12 new tests (scripts.test.ts × 6 + compose-prod.test.ts × 6)
all PASS. The pre-existing failures are tracked here for whichever plan owns
the env-seed pattern follow-up.
