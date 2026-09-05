// The built-in linkage rule sets, read out of their source declarations.
//
// Two repository checks hold a property of those sets --
// check-zero-setup-keys.mjs and check-built-in-set-versions.mjs -- and both need
// the same thing: the field set and the key set as VALUES, not as text. Reading
// them from the source rather than from the built package is by design. The
// arrays are module-private (`getDefaultLinkageTerms` is the only way out of
// that module, and it filters), and a check that imported a built dist would
// pass against a stale build -- the one failure mode a guard over source content
// cannot afford.
//
// The source is parsed with the TypeScript compiler's own parser and each
// declaration's initializer evaluated as a literal, so a comment, a reflow, or
// prettier's line breaking moves nothing here while a value, a key, or an array
// ordering does. An initializer that is not a plain literal -- a spread, a
// computed key, a reference to another binding, a call -- is refused by name
// rather than guessed at: a reader that quietly returned a partial value would
// hand both checks a content they would then pin.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";

/** The source the built-in field set and key set are declared in. */
export const RULE_SET_SOURCE = "packages/core/src/defaults/linkageTerms.ts";

/** The declarations naming, versioning, and holding the field set. */
export const FIELD_SET_DECLARATIONS = {
  name: "DEFAULT_LINKAGE_FIELD_SET_NAME",
  version: "DEFAULT_LINKAGE_FIELD_SET_VERSION",
  content: "DEFAULT_LINKAGE_FIELDS",
};

/** The declarations naming, versioning, and holding the key set. */
export const KEY_SET_DECLARATIONS = {
  name: "DEFAULT_LINKAGE_KEY_SET_NAME",
  version: "DEFAULT_LINKAGE_KEY_SET_VERSION",
  content: "DEFAULT_LINKAGE_KEYS",
};

/** Raised when a declaration's initializer is not a literal this can evaluate. */
export class UnreadableDeclaration extends Error {}

function describe(node) {
  return ts.SyntaxKind[node.kind] ?? "an expression";
}

/**
 * The value a literal initializer denotes: strings, numbers, booleans, arrays,
 * and object literals of those. Anything else raises {@link
 * UnreadableDeclaration} naming the syntax, so a declaration that stopped being
 * a literal fails the checks over it rather than being treated as an empty one.
 */
export function literalValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text);
  }
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return literalValue(node.expression);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element) => {
      if (ts.isSpreadElement(element)) {
        throw new UnreadableDeclaration(
          "an array element is a spread, whose value depends on another binding",
        );
      }
      return literalValue(element);
    });
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new UnreadableDeclaration(
          `an object property is ${describe(property)} rather than a plain \`key: value\` assignment`,
        );
      }
      const key = property.name;
      if (ts.isIdentifier(key) || ts.isStringLiteral(key)) {
        value[key.text] = literalValue(property.initializer);
      } else {
        throw new UnreadableDeclaration(
          `an object key is ${describe(key)} rather than an identifier or a string`,
        );
      }
    }
    return value;
  }
  throw new UnreadableDeclaration(
    `its initializer is ${describe(node)} rather than a literal`,
  );
}

/**
 * The top-level `const` initializers a source file declares, by name, as
 * `{values, unreadable}`. Only the source file's own statements are walked, so a
 * same-named binding inside a function shadows nothing here.
 */
export function declaredLiterals(source, wanted) {
  const parsed = ts.createSourceFile(
    "linkageTerms.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const values = {};
  const unreadable = [];
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      if (!wanted.includes(name)) continue;
      if (declaration.initializer === undefined) {
        unreadable.push({ declaration: name, reason: "it has no initializer" });
        continue;
      }
      try {
        values[name] = literalValue(declaration.initializer);
      } catch (error) {
        if (!(error instanceof UnreadableDeclaration)) throw error;
        unreadable.push({ declaration: name, reason: error.message });
      }
    }
  }
  for (const name of wanted) {
    if (name in values) continue;
    if (unreadable.some((entry) => entry.declaration === name)) continue;
    unreadable.push({
      declaration: name,
      reason: `${RULE_SET_SOURCE} declares no top-level \`const ${name}\``,
    });
  }
  return { values, unreadable };
}

/**
 * The two built-in sets a source file declares, as `{fieldSet, keySet,
 * unreadable}`. Each set is `{name, version, content}`; a set with any
 * unreadable declaration is `undefined`, and every reason is in `unreadable`.
 */
export function readRuleSets(source) {
  const wanted = [
    ...Object.values(FIELD_SET_DECLARATIONS),
    ...Object.values(KEY_SET_DECLARATIONS),
  ];
  const { values, unreadable } = declaredLiterals(source, wanted);
  const build = (declarations) => {
    const parts = Object.entries(declarations).map(([part, declaration]) => [
      part,
      values[declaration],
    ]);
    return parts.some(([, value]) => value === undefined)
      ? undefined
      : Object.fromEntries(parts);
  };
  return {
    fieldSet: build(FIELD_SET_DECLARATIONS),
    keySet: build(KEY_SET_DECLARATIONS),
    unreadable,
  };
}

/**
 * {@link readRuleSets} over the tree at `root`. A source file the tree does not
 * hold at all -- reachable through a caller's `--root` pointed at a tree
 * missing it -- is unreadable the same way a bad declaration is, under
 * {@link RULE_SET_SOURCE} rather than a declaration name, so a caller's
 * `unreadable`-to-`blocked` mapping covers this failure with no separate catch
 * of its own.
 */
export function readRuleSetsFrom(root) {
  let source;
  try {
    source = readFileSync(resolve(root, RULE_SET_SOURCE), "utf8");
  } catch (error) {
    return {
      fieldSet: undefined,
      keySet: undefined,
      unreadable: [{ declaration: RULE_SET_SOURCE, reason: error.message }],
    };
  }
  return readRuleSets(source);
}

/**
 * `value` with every object's keys in a fixed order, so the digest below moves
 * on content and on array ordering but not on the order two properties happen to
 * be written in. Array order is preserved: for the key set it is cascade order,
 * which is matching behavior.
 */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

/** The pin that identifies a set's content: sha256 over its canonicalized form. */
export function contentDigest(content) {
  const canonical = JSON.stringify(canonicalize(content));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
