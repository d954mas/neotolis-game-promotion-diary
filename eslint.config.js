// ESLint 9 flat config. Replaces legacy .eslintrc.cjs.
// PITFALL P2 mitigation: bans `process.env` reads outside the env config module.

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
      message: "Read env via src/lib/server/config/env.ts (PITFALL P2 mitigation)",
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
      // Plan 02.1-28 (Rule 3 — Blocking): exclude parallel-agent worktrees
      // from lint. These are GSD orchestrator scratch dirs that mirror the
      // repo state from prior plan runs; ESLint should not police them.
      // The active source-of-truth is the top-level src/ + tests/ trees.
      ".claude/",
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
      // Plan 02-09: Svelte 5 components declare callback prop types like
      // `onChange: (v: T) => void`. The bare `no-unused-vars` rule from
      // js.configs.recommended fires on `v` because the parser sees a
      // function-type signature; the TS-aware rule with the underscore
      // ignore pattern is the right tool. Apply the same shape here that
      // the .ts block uses.
      ...tsUnusedVarsRule,
      ...noProcessEnv,
    },
  },
  // Plan 02-02 (Phase 2 Wave 0): structural Pattern 1 enforcement.
  // The tenant-scope rule fires on Drizzle queries against tenant-owned
  // tables that omit the mandatory `userId` filter. It is the lint-time
  // half of the two-layer Pattern 1 defense (the integration test
  // `tests/integration/tenant-scope.test.ts` is the runtime half).
  {
    files: ["src/lib/server/services/**/*.ts", "src/lib/server/services/**/*.tsx"],
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
  {
    files: ["tests/**/*.ts", "tests/**/*.js", "vitest.config.ts", "tests/setup.ts"],
    rules: { "no-restricted-properties": "off" },
  },
  prettier,
];
