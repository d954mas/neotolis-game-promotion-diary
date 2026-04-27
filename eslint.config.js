// ESLint 9 flat config. Replaces legacy .eslintrc.cjs.
// PITFALL P2 mitigation: bans `process.env` reads outside the env config module.

import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import sveltePlugin from "eslint-plugin-svelte";
import svelteParser from "svelte-eslint-parser";
import prettier from "eslint-config-prettier";
import globals from "globals";

const noProcessEnv = {
  "no-restricted-properties": [
    "error",
    {
      object: "process",
      property: "env",
      message:
        "Read env via src/lib/server/config/env.ts (PITFALL P2 mitigation)",
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
    plugins: { svelte: sveltePlugin },
    rules: {
      "no-undef": "off",
      ...noProcessEnv,
    },
  },
  // Carve-out: env config is the ONE place process.env is allowed.
  {
    files: ["src/lib/server/config/env.ts"],
    rules: { "no-restricted-properties": "off" },
  },
  // Tests legitimately read/manipulate process.env to drive env-config behavior.
  {
    files: [
      "tests/**/*.ts",
      "tests/**/*.js",
      "vitest.config.ts",
      "tests/setup.ts",
    ],
    rules: { "no-restricted-properties": "off" },
  },
  prettier,
];
