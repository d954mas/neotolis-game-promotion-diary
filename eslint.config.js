// ESLint 9 flat config. Replaces legacy .eslintrc.cjs.
// Bans `process.env` reads outside the env config module.

import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import sveltePlugin from "eslint-plugin-svelte";
import svelteParser from "svelte-eslint-parser";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tenantScope from "./eslint-plugin-tenant-scope/index.js";

const noProcessEnv = {
  "no-restricted-properties": [
    "error",
    {
      object: "process",
      property: "env",
      message: "Read env via src/lib/server/config/env.ts",
    },
  ],
};

const tsUnusedVarsRule = {
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
      destructuredArrayIgnorePattern: "^_",
      ignoreRestSiblings: true,
    },
  ],
  "no-unused-vars": "off",
};

export default [
  {
    ignores: [
      "node_modules/",
      "build/",
      ".svelte-kit/",
      "src/lib/paraglide/",
      "drizzle/",
      "messages/",
      // Exclude parallel-agent worktrees from lint. These are GSD
      // orchestrator scratch dirs that mirror the repo state from prior
      // plan runs; ESLint should not police them. The active
      // source-of-truth is the top-level src/ + tests/ trees.
      ".claude/",
      // Developer-personal dev helpers
      // (.dev-worker.ts, .dev-oauth-mock.mjs, .dev-probe-youtube.ts,
      // .dev-trigger-poll.ts, etc). These are intentionally outside
      // source control (see .gitignore) and pin a single developer's
      // machine setup. They read process.env directly because they run
      // as standalone Node scripts outside the SvelteKit/Hono runtime
      // (the no-restricted-properties rule is load-bearing for the
      // runtime code, not for one-off dev scripts).
      ".dev-*.ts",
      ".dev-*.mjs",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{ts,js,mjs,cjs}"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...tsUnusedVarsRule,
      // TS handles undefined-ness; turning off no-undef avoids false positives
      // on built-in DOM/Node globals like RequestInit, RequestRedirect.
      "no-undef": "off",
      ...noProcessEnv,
    },
  },
  {
    files: ["**/*.svelte"],
    languageOptions: {
      parser: svelteParser,
      parserOptions: { parser: tsParser },
      globals: { ...globals.browser },
    },
    plugins: { svelte: sveltePlugin, "@typescript-eslint": tsPlugin },
    rules: {
      "no-undef": "off",
      // Svelte 5 components declare callback prop types like
      // `onChange: (v: T) => void`. The bare `no-unused-vars` rule from
      // js.configs.recommended fires on `v` because the parser sees a
      // function-type signature; the TS-aware rule with the underscore
      // ignore pattern is the right tool. Apply the same shape here that
      // the .ts block uses.
      ...tsUnusedVarsRule,
      ...noProcessEnv,
    },
  },
  // Structural tenant-scope enforcement. The tenant-scope rule fires on
  // Drizzle queries against tenant-owned tables that omit the mandatory
  // `userId` filter. It is the lint-time half of the two-layer defense
  // (the integration test `tests/integration/tenant-scope.test.ts` is
  // the runtime half).
  //
  // The glob covers services, the HTTP layer, worker handlers, the
  // scheduler, and SvelteKit page server-loaders. A narrower glob would
  // miss queries against tenant-owned tables in handlers and leave the
  // project one refactor away from a leak. Sites that intentionally
  // bypass the rule (cross-tenant scheduler fan-out, admin cross-tenant
  // audit aggregation) must carry a justified disable directive.
  {
    files: [
      "src/lib/server/services/**/*.ts",
      "src/lib/server/services/**/*.tsx",
      "src/lib/server/http/**/*.ts",
      // Per-source server folders execute the same tenant-scope discipline
      // as services/. Without this glob, code under sources/<kind>/server/
      // would lose its lint-time guard (and existing eslint-disable-next-line
      // directives would error with "rule definition not found").
      "src/lib/sources/**/server/**/*.ts",
      "src/worker/**/*.ts",
      "src/scheduler/**/*.ts",
      "src/routes/**/+page.server.ts",
      "src/routes/**/+layout.server.ts",
    ],
    plugins: {
      "tenant-scope": tenantScope,
    },
    rules: {
      "tenant-scope/no-unfiltered-tenant-query": "error",
    },
  },
  // Carve-out: env config is the ONE place process.env is allowed.
  {
    files: ["src/lib/server/config/env.ts"],
    rules: { "no-restricted-properties": "off" },
  },
  // Tests legitimately read/manipulate process.env to drive env-config behavior.
  // .mjs covers smoke-gate fixtures (e.g. tests/smoke/lib/youtube-mock.mjs)
  // which run as standalone Node processes outside the app bundle and read
  // process.env to take their PORT from the smoke harness.
  {
    files: [
      "tests/**/*.ts",
      "tests/**/*.js",
      "tests/**/*.mjs",
      "vitest.config.ts",
      "tests/setup.ts",
    ],
    rules: { "no-restricted-properties": "off" },
  },
  prettier,
];
