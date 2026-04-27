module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:svelte/recommended",
    "prettier",
  ],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    extraFileExtensions: [".svelte"],
  },
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  overrides: [
    {
      files: ["*.svelte"],
      parser: "svelte-eslint-parser",
      parserOptions: {
        parser: "@typescript-eslint/parser",
      },
    },
  ],
  rules: {
    "no-restricted-properties": [
      "error",
      {
        object: "process",
        property: "env",
        message:
          "Read env via src/lib/server/config/env.ts (PITFALL P2 mitigation)",
      },
    ],
  },
  ignorePatterns: [
    "node_modules/",
    "build/",
    ".svelte-kit/",
    "src/lib/paraglide/",
    "drizzle/",
  ],
};
