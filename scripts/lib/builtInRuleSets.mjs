// The built-in linkage rule sets, read out of their source declarations.
//
// Two repository checks hold a property of those sets --
// check-zero-setup-keys.mjs and check-built-in-set-versions.mjs -- and both need
// the same thing: every set the registry ships, as VALUES rather than as text.
// Reading them from the source rather than from the built package is by design.
// The field and key arrays are module-private (`getDefaultLinkageTerms` is the
// only way out of that module, and it filters), and a check that imported a
// built dist would pass against a stale build -- the one failure mode a guard
// over source content cannot afford.
//
// The registry declaration is the entry point, so a set added to it is covered
// by both checks with no list to keep in step here. Each entry is followed to
// the declarations it composes: the name, version, and content of its field set
// and of its key set, each reported under the declaration it came from so a
// failure names what to edit.
//
// The source is parsed with the TypeScript compiler's own parser and each
// declaration's initializer evaluated as a literal, so a comment, a reflow, or
// prettier's line breaking moves nothing here while a value, a key, or an array
// ordering does. An initializer that is not a plain literal -- a spread, a
// computed key, a call other than the freezing wrappers below -- is refused by
// name rather than guessed at: a reader that quietly returned a partial value
// would hand both checks a content they would then pin.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";

/** The source the built-in rule sets are declared in. */
export const RULE_SET_SOURCE =
  "packages/core/src/defaults/builtInLinkageTerms.ts";

/** The declaration holding every rule set the build ships, in registry order. */
export const REGISTRY_DECLARATION = "BUILT_IN_LINKAGE_RULE_SETS";

/**
 * The calls that return their single argument's value unchanged, and so are
 * read through rather than refused: the freezing the sets are declared under.
 * Every other call is refused, since its value is not in the source.
 */
const IDENTITY_CALLS = ["Object.freeze", "frozenThroughContents"];

/**
 * Raised when a declaration's initializer is not a literal this can evaluate.
 * `declaration` names the declaration the failure sits in, filled in by the
 * first reader that knows a name for it.
 */
export class UnreadableDeclaration extends Error {
  constructor(message, declaration) {
    super(message);
    this.declaration = declaration;
  }
}

function describe(node) {
  return ts.SyntaxKind[node.kind] ?? "an expression";
}

/** `Object.freeze` or a bare function name for a call, else undefined. */
function calleeText(node) {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression)
  ) {
    return `${callee.expression.text}.${callee.name.text}`;
  }
  return undefined;
}

/**
 * `node` with the wrappers that do not change its value removed: the type
 * assertions, the parentheses, and the {@link IDENTITY_CALLS}.
 */
function unwrap(node) {
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return unwrap(node.expression);
  }
  const called = calleeText(node);
  if (called !== undefined && IDENTITY_CALLS.includes(called)) {
    if (node.arguments.length !== 1) {
      throw new UnreadableDeclaration(
        `\`${called}\` is called with ${node.arguments.length} arguments rather than the one whose value it returns`,
      );
    }
    return unwrap(node.arguments[0]);
  }
  return node;
}

/** The top-level declaration `node` names, or undefined where it is not a
 * bare identifier. */
function declarationName(node) {
  const bare = unwrap(node);
  return ts.isIdentifier(bare) ? bare.text : undefined;
}

/**
 * The value a literal initializer denotes: strings, numbers, booleans, arrays,
 * and object literals of those. An identifier is handed to `readIdentifier`,
 * which the file's own declarations resolve. Anything else raises {@link
 * UnreadableDeclaration} naming the syntax, so a declaration that stopped being
 * a literal fails the checks over it rather than being treated as an empty one.
 */
function literalValue(node, readIdentifier) {
  const bare = unwrap(node);
  if (ts.isStringLiteral(bare) || ts.isNoSubstitutionTemplateLiteral(bare)) {
    return bare.text;
  }
  if (ts.isNumericLiteral(bare)) return Number(bare.text);
  if (bare.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (bare.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (bare.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(bare) &&
    bare.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(bare.operand)
  ) {
    return -Number(bare.operand.text);
  }
  if (ts.isIdentifier(bare)) return readIdentifier(bare.text);
  if (ts.isArrayLiteralExpression(bare)) {
    return bare.elements.map((element) => {
      if (ts.isSpreadElement(element)) {
        throw new UnreadableDeclaration(
          "an array element is a spread, whose value depends on another binding",
        );
      }
      return literalValue(element, readIdentifier);
    });
  }
  if (ts.isObjectLiteralExpression(bare)) {
    const value = {};
    for (const property of bare.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new UnreadableDeclaration(
          `an object property is ${describe(property)} rather than a plain \`key: value\` assignment`,
        );
      }
      const key = property.name;
      if (ts.isIdentifier(key) || ts.isStringLiteral(key)) {
        value[key.text] = literalValue(property.initializer, readIdentifier);
      } else {
        throw new UnreadableDeclaration(
          `an object key is ${describe(key)} rather than an identifier or a string`,
        );
      }
    }
    return value;
  }
  throw new UnreadableDeclaration(
    `its initializer is ${describe(bare)} rather than a literal`,
  );
}

/**
 * The initializer of each top-level `const` a source file declares, by name;
 * `null` where the declaration has none. Only the file's own statements are
 * walked, so a same-named binding inside a function shadows nothing here.
 */
function topLevelConstants(source) {
  const parsed = ts.createSourceFile(
    RULE_SET_SOURCE,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const constants = new Map();
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      constants.set(declaration.name.text, declaration.initializer ?? null);
    }
  }
  return constants;
}

/**
 * Reads a named top-level declaration's value out of `constants`, evaluating it
 * once and remembering it. Every failure is attributed to the innermost
 * declaration that knows its own name, so a set composed from several
 * declarations reports the one to edit rather than the composition.
 */
function constantReader(constants) {
  const values = new Map();
  const reading = new Set();
  const read = (name) => {
    if (values.has(name)) return values.get(name);
    const initializer = constants.get(name);
    if (initializer === undefined) {
      throw new UnreadableDeclaration(
        `${RULE_SET_SOURCE} declares no top-level \`const ${name}\``,
        name,
      );
    }
    if (initializer === null) {
      throw new UnreadableDeclaration("it has no initializer", name);
    }
    if (reading.has(name)) {
      throw new UnreadableDeclaration("its initializer reads itself", name);
    }
    reading.add(name);
    try {
      const value = literalValue(initializer, read);
      values.set(name, value);
      return value;
    } catch (error) {
      if (error instanceof UnreadableDeclaration) {
        error.declaration ??= name;
      }
      throw error;
    } finally {
      reading.delete(name);
    }
  };
  return read;
}

/** The object literal `node` denotes, following an identifier to the
 * declaration that holds it. */
function objectAt(node, constants, where) {
  let bare = unwrap(node);
  const followed = new Set();
  while (ts.isIdentifier(bare)) {
    const name = bare.text;
    if (followed.has(name)) {
      throw new UnreadableDeclaration("its initializer reads itself", name);
    }
    followed.add(name);
    const initializer = constants.get(name);
    if (initializer === undefined) {
      throw new UnreadableDeclaration(
        `${RULE_SET_SOURCE} declares no top-level \`const ${name}\``,
        name,
      );
    }
    if (initializer === null) {
      throw new UnreadableDeclaration("it has no initializer", name);
    }
    bare = unwrap(initializer);
  }
  if (!ts.isObjectLiteralExpression(bare)) {
    throw new UnreadableDeclaration(
      `${where} is ${describe(bare)} rather than an object literal`,
    );
  }
  const properties = new Map();
  for (const property of bare.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new UnreadableDeclaration(
        `a property of ${where} is ${describe(property)} rather than a plain \`key: value\` assignment`,
      );
    }
    const key = property.name;
    if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) {
      throw new UnreadableDeclaration(
        `a key of ${where} is ${describe(key)} rather than an identifier or a string`,
      );
    }
    properties.set(key.text, property.initializer);
  }
  return properties;
}

function propertyAt(properties, key, where) {
  const node = properties.get(key);
  if (node === undefined) {
    throw new UnreadableDeclaration(`${where} declares no \`${key}\``);
  }
  return node;
}

/** Which content declaration each half of a rule set takes its rules from. */
const HALF_CONTENT = { fieldSet: "linkageFields", keySet: "linkageKeys" };

/** One registry entry: its two halves, each with its content and the
 * declarations the entry composed it from. */
function readRuleSet(element, index, constants, read) {
  const declaration =
    declarationName(element) ?? `${REGISTRY_DECLARATION}[${index}]`;
  const entry = objectAt(element, constants, `\`${declaration}\``);
  const reference = objectAt(
    propertyAt(entry, "reference", `\`${declaration}\``),
    constants,
    `\`${declaration}.reference\``,
  );

  const halves = {};
  for (const [role, contentKey] of Object.entries(HALF_CONTENT)) {
    const where = `\`${declaration}.reference.${role}\``;
    const identity = objectAt(
      propertyAt(reference, role, `\`${declaration}.reference\``),
      constants,
      where,
    );
    const nameNode = propertyAt(identity, "name", where);
    const versionNode = propertyAt(identity, "version", where);
    const contentNode = propertyAt(entry, contentKey, `\`${declaration}\``);
    halves[role] = {
      role,
      name: literalValue(nameNode, read),
      version: literalValue(versionNode, read),
      content: literalValue(contentNode, read),
      declarations: {
        name: declarationName(nameNode) ?? `${declaration}.${role} name`,
        version:
          declarationName(versionNode) ?? `${declaration}.${role} version`,
        content: declarationName(contentNode) ?? `${declaration}.${contentKey}`,
      },
    };
  }
  return { declaration, index, ...halves };
}

/** The registry's elements, in declaration order. */
function registryElements(constants) {
  const initializer = constants.get(REGISTRY_DECLARATION);
  if (initializer === undefined) {
    throw new UnreadableDeclaration(
      `${RULE_SET_SOURCE} declares no top-level \`const ${REGISTRY_DECLARATION}\``,
      REGISTRY_DECLARATION,
    );
  }
  if (initializer === null) {
    throw new UnreadableDeclaration(
      "it has no initializer",
      REGISTRY_DECLARATION,
    );
  }
  const array = unwrap(initializer);
  if (!ts.isArrayLiteralExpression(array)) {
    throw new UnreadableDeclaration(
      `its initializer is ${describe(array)} rather than an array literal`,
      REGISTRY_DECLARATION,
    );
  }
  for (const element of array.elements) {
    if (ts.isSpreadElement(element)) {
      throw new UnreadableDeclaration(
        "an entry is a spread, whose sets depend on another binding",
        REGISTRY_DECLARATION,
      );
    }
  }
  if (array.elements.length === 0) {
    throw new UnreadableDeclaration(
      "it holds no rule set, so there is nothing here to hold anything to",
      REGISTRY_DECLARATION,
    );
  }
  return array.elements;
}

/**
 * The rule sets a source file's registry declares, as `{ruleSets, unreadable}`.
 * Each entry is `{declaration, index, fieldSet, keySet}`, and each half is
 * `{role, name, version, content, declarations}`. An entry with any unreadable
 * declaration is left out and its reason is in `unreadable`.
 */
export function readRuleSets(source) {
  const constants = topLevelConstants(source);
  const read = constantReader(constants);
  const ruleSets = [];
  const unreadable = [];

  let elements;
  try {
    elements = registryElements(constants);
  } catch (error) {
    if (!(error instanceof UnreadableDeclaration)) throw error;
    return {
      ruleSets,
      unreadable: [
        {
          declaration: error.declaration ?? REGISTRY_DECLARATION,
          reason: error.message,
        },
      ],
    };
  }

  elements.forEach((element, index) => {
    try {
      ruleSets.push(readRuleSet(element, index, constants, read));
    } catch (error) {
      if (!(error instanceof UnreadableDeclaration)) throw error;
      unreadable.push({
        declaration:
          error.declaration ??
          declarationName(element) ??
          `${REGISTRY_DECLARATION}[${index}]`,
        reason: error.message,
      });
    }
  });

  return { ruleSets, unreadable };
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
      ruleSets: [],
      unreadable: [{ declaration: RULE_SET_SOURCE, reason: error.message }],
    };
  }
  return readRuleSets(source);
}

/**
 * `value` with every object's keys in a fixed order, so the digest below moves
 * on content and on array ordering but not on the order two properties happen to
 * be written in. Array order is preserved: for a key set it is cascade order,
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

/**
 * Every named set the registry declares, one per half of each entry, with its
 * content digested. Two entries built over one field set declare that set
 * twice, which is sharing rather than a conflict as long as both name the same
 * content -- {@link identityConflicts} is what decides that.
 */
export function declaredSets(ruleSets) {
  return ruleSets.flatMap((ruleSet) =>
    Object.keys(HALF_CONTENT).map((role) => ({
      ...ruleSet[role],
      entry: ruleSet.declaration,
      digest: contentDigest(ruleSet[role].content),
    })),
  );
}

/**
 * The reasons two of `sets` claim one identity: a name and version under which
 * the registry declares two different contents. A name and version identify a
 * fixed content -- that is what a citation of them asserts, what the recorded
 * validation attaches to, and what a pin records one digest for -- so two
 * contents under one identity leave a citation resolving to whichever entry is
 * first and a pin covering only one of them. Reported as `{kind, set, message}`
 * beside the pin violations, and empty where every repeated identity names the
 * same content, which is one set shared by two entries.
 */
export function identityConflicts(sets) {
  const first = new Map();
  const conflicts = [];
  for (const set of sets) {
    const identity = `${set.name} ${set.version}`;
    const seen = first.get(identity);
    if (seen === undefined) {
      first.set(identity, set);
      continue;
    }
    if (seen.digest === set.digest) continue;
    conflicts.push({
      kind: "identity",
      set: set.name,
      message: `${REGISTRY_DECLARATION} declares "${set.name}" ${set.version} over two different contents (\`${seen.declarations.content}\` and \`${set.declarations.content}\`). A name and version identify one content, so a citation of them would resolve to whichever entry comes first and ${RULE_SET_SOURCE} would ship the other under a name nothing holds it to. Give the second set its own name, or draw both entries from the one declaration.`,
    });
  }
  return conflicts;
}
