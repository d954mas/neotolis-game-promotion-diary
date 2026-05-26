// Local ESLint plugin — project-specific rules that don't belong in a
// published package.
//
// Currently:
//   - no-denormalized-write: flags JSONB metadata writes that snapshot
//     a separately-renameable display name (AGENTS.md no-denorm rule).
//     See docs/denormalization-policy.md.

import noDenormalizedWrite from "./no-denormalized-write.js";

export default {
  rules: {
    "no-denormalized-write": noDenormalizedWrite,
  },
};
