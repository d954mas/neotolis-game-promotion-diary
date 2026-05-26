/**
 * Custom ESLint rule: local/no-denormalized-write.
 *
 * Catches the canonical denormalization anti-pattern flagged by
 * AGENTS.md "No denormalization of separately-renameable values":
 * writes that snapshot a display name onto a row's JSONB metadata,
 * shadowing a value owned by another table.
 *
 * AST pattern: AssignmentExpression where left side is a
 * MemberExpression chain ending in `.metadata.<somethingTitle>` /
 * `.metadata.<somethingName>` / `.metadata.channelTitle` /
 * `.metadata.displayName`. The presence of `metadata` (case-
 * insensitive) anywhere in the property chain plus a stoplist suffix
 * match is the heuristic — every confirmed historical violation in
 * this codebase fit that shape.
 *
 * Object-literal shape also matches: assignments inside an object
 * literal that gets `JSON.stringify`'d or passed directly to
 * `column: metadata` are the same risk surface. The rule walks
 * `Property` nodes with the same key-name predicate, scoped to a
 * surrounding `metadata`-named property chain (see `findMetadataAncestor`).
 *
 * Severity: warn (not error) — false-positives are possible in audit-
 * log metadata writes and in cases where the field is intrinsic to the
 * row's identity. The team triages on PR. Real positives become
 * follow-up PRs that drop the field; false positives get a justified
 * disable comment per the same convention as tenant-scope:
 *
 *   // eslint-disable-next-line local/no-denormalized-write -- audit-log INSERT-only forensic snapshot
 *
 * See docs/denormalization-policy.md for the full rule + the
 * OK-INTRINSIC categories.
 */

import { ESLintUtils } from "@typescript-eslint/utils";

// Stoplist regex — property names that match this pattern, when
// written under a `metadata`-shaped object, look like display-name
// denormalization. Matches `channelTitle`, `subredditTitle`,
// `displayName`, `gameTitle`, `userName`, etc.
const SUSPICIOUS_NAME_RE = /(?:Title|DisplayName|^title$|^name$)$/;

// More-specific subnames seen historically. Always fires regardless
// of the suffix above (catches e.g. `channelTitle` directly).
const ALWAYS_FLAG_NAMES = new Set([
  "channelTitle",
  "displayName",
  "gameTitle",
  "subredditName",
  "channelName",
  "userName",
  "authorName",
]);

const REPORT_MESSAGE =
  "Likely denormalization: writing a display name into metadata. See docs/denormalization-policy.md.";

/**
 * Walk the AST ancestors of a Property node. Return true if any
 * ancestor MemberExpression / Property names `metadata`
 * (case-insensitive). This is the "we're writing into a JSONB
 * metadata blob" heuristic.
 */
function findMetadataAncestor(node, sourceCode) {
  let current = node;
  // Walk up through Property -> ObjectExpression -> Property /
  // AssignmentExpression / VariableDeclarator. Stop at function /
  // statement boundary.
  const stopAt = new Set([
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
    "BlockStatement",
    "Program",
  ]);
  while (current && !stopAt.has(current.type)) {
    if (
      (current.type === "Property" || current.type === "MemberExpression") &&
      hasMetadataKey(current, sourceCode)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function hasMetadataKey(node, sourceCode) {
  // Property: { metadata: { ... } } — key.name === "metadata".
  if (node.type === "Property") {
    if (node.key && node.key.type === "Identifier") {
      return node.key.name.toLowerCase() === "metadata";
    }
    if (node.key && node.key.type === "Literal" && typeof node.key.value === "string") {
      return node.key.value.toLowerCase() === "metadata";
    }
  }
  // MemberExpression: row.metadata.foo — property.name === "metadata".
  if (node.type === "MemberExpression" && node.property && node.property.type === "Identifier") {
    return node.property.name.toLowerCase() === "metadata";
  }
  // Fall back to source-text scan (handles computed property access
  // and dynamic-key writes — rare but possible).
  const text = sourceCode.getText(node);
  return /\bmetadata\b/i.test(text);
}

function nameMatchesStoplist(name) {
  if (!name) return false;
  if (ALWAYS_FLAG_NAMES.has(name)) return true;
  return SUSPICIOUS_NAME_RE.test(name);
}

export default ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow writing separately-renameable display names into metadata (denormalization anti-pattern).",
      url: "https://github.com/d954mas/neotolis-game-promotion-diary/blob/master/docs/denormalization-policy.md",
    },
    schema: [],
    messages: {
      likelyDenorm: REPORT_MESSAGE,
    },
  },
  defaultOptions: [],

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      // Catches `row.metadata.channelTitle = "..."` and similar.
      AssignmentExpression(node) {
        if (node.left.type !== "MemberExpression") return;
        const prop = node.left.property;
        const name = prop && prop.type === "Identifier" ? prop.name : null;
        if (!nameMatchesStoplist(name)) return;
        // Require a `metadata` segment somewhere in the assignment
        // target chain so we don't fire on legitimate writes like
        // `row.channelTitle = ...` against schema columns.
        if (!hasMetadataInChain(node.left)) return;
        context.report({ node, messageId: "likelyDenorm" });
      },

      // Catches object-literal property writes inside a metadata-
      // shaped object: `{ metadata: { channelTitle: "..." } }`.
      Property(node) {
        if (node.key.type !== "Identifier" && node.key.type !== "Literal") return;
        const keyName =
          node.key.type === "Identifier" ? node.key.name : String(node.key.value ?? "");
        if (!nameMatchesStoplist(keyName)) return;
        // Skip object literals where the value is a Property /
        // ObjectExpression (those are nested wrappers, not the leaf
        // write).
        if (node.value.type === "ObjectExpression" || node.value.type === "ArrayExpression") {
          return;
        }
        if (!findMetadataAncestor(node, sourceCode)) return;
        context.report({ node, messageId: "likelyDenorm" });
      },
    };
  },
});

function hasMetadataInChain(memberExpr) {
  let current = memberExpr;
  while (current && current.type === "MemberExpression") {
    if (current.property && current.property.type === "Identifier") {
      if (current.property.name.toLowerCase() === "metadata") return true;
    }
    if (current.object && current.object.type === "Identifier") {
      if (current.object.name.toLowerCase() === "metadata") return true;
    }
    current = current.object;
  }
  return false;
}
