// Fixture file demonstrating the local/no-denormalized-write rule.
//
// Running `pnpm exec eslint eslint-rules/__tests__/fixture-denorm.ts`
// SHOULD emit 3 warnings — one per flagged assignment below. The rule
// is `warn`-severity so this file does NOT fail the lint step; it is
// here as a living demo + smoke check.
//
// (Excluded from the normal lint pass via the file glob in
// eslint.config.js — only the rule's vitest unit test exercises it
// in CI. Run manually with the path above.)

const sample = {
  metadata: {
    // FIRES: writing a separately-renameable channel display name
    // into metadata.
    channelTitle: "Rick Astley",
    // FIRES: displayName shadowing data_sources.display_name.
    displayName: "@rickastley",
    // SAFE: subreddit slug is intrinsic-to-URL (AGENTS.md OK-INTRINSIC).
    subreddit: "askreddit",
    // SAFE: own-row state timestamp.
    last_user_refresh_at: new Date().toISOString(),
  },
};

const row: { metadata: { channelTitle?: string } } = { metadata: {} };
// FIRES: assignment-shape variant of the same anti-pattern.
row.metadata.channelTitle = "Different Channel";

export { sample, row };
