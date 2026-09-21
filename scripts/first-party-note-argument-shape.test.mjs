import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  descendants,
  parseSource,
  readSource,
  sourceModules,
} from "./lib/typeScriptSources.mjs";

// Coverage of the call-site shape `firstPartyNote` rests on
// (`packages/core/src/utils/sanitizeForDisplay.ts`).
//
// That function exempts its argument from `DEFAULT_MAX_DISPLAY_LENGTH`, so a
// note reaches the operator whole. Its runtime guard reads the characters of
// the text it is handed, not where they came from: any printable ASCII is
// exempted, whoever chose it, so an operator- or partner-supplied value passed
// here would render unbounded. Provenance is a property of the call site, and
// this is where it is checked -- a note is the call site's own literal text,
// and every fragment interpolated into it is escaped by `sanitizeForDisplay`
// where it goes in, which is what keeps the cap on the bytes somebody else
// chose.
//
// Scope is the shipped sources. `packages/core/src` composes the notes and is
// held to that shape; no other `src` tree may call the function at all, since
// a consumer is handed a `Displayable` already composed. The test trees are
// outside both halves: a test composes a note of whatever shape its case
// needs, including the over-length one that drove the exemption.
//
// The reach is syntactic and single-file, as it is for every scan in this
// directory: the call is read where it is written by name, so a call reached
// through an alias, a stored reference, or a namespace is not read. An escape
// reached through a namespace (`core.sanitizeForDisplay(...)`) is refused
// rather than read, for the same reason -- what the name refers to is not
// decided here.

const NOTE_FUNCTION = "firstPartyNote";
const ESCAPE_FUNCTION = "sanitizeForDisplay";
const COMPOSING_TREE = "packages/core/src";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every workspace `src` tree, the shipped sources this scan is scoped to. */
const SOURCE_TREES = ["packages", "apps"]
  .flatMap((group) =>
    readdirSync(resolve(repoRoot, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${group}/${entry.name}/src`),
  )
  .filter((tree) => existsSync(resolve(repoRoot, tree)));

/** Whether `node` is a `sanitizeForDisplay(...)` call written by that name. */
function isEscapeCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === ESCAPE_FUNCTION
  );
}

/** A phrase naming the shape of `node`, for the reason a refusal reports. */
function shapeOf(node) {
  if (ts.isIdentifier(node)) return `the value \`${node.text}\``;
  if (ts.isCallExpression(node)) return "a call";
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    return "a property read";
  return "an expression this check does not read as first-party text";
}

/**
 * Why `node` is not first-party note text, or `undefined` when it is: the
 * accepted shapes are the call site's own string literals, `+` concatenations
 * of them, and template literals whose every interpolation is an escape call.
 */
function refusalFor(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return undefined;
  if (ts.isParenthesizedExpression(node)) return refusalFor(node.expression);
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind !== ts.SyntaxKind.PlusToken)
      return "the note text is joined by an operator other than +";
    return refusalFor(node.left) ?? refusalFor(node.right);
  }
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      if (isEscapeCall(span.expression)) continue;
      return `${shapeOf(span.expression)} is interpolated into the note without ${ESCAPE_FUNCTION}(...)`;
    }
    return undefined;
  }
  return `the note text is ${shapeOf(node)}`;
}

/**
 * Every `firstPartyNote` call `sourceFile` writes, as `file:line`, and the
 * refusal each call whose argument is not first-party note text earns, as
 * `file:line: reason`.
 */
export function scanNoteCalls(file, sourceFile) {
  const sites = [];
  const refusals = [];
  for (const node of descendants(sourceFile)) {
    if (!ts.isCallExpression(node)) continue;
    if (!ts.isIdentifier(node.expression)) continue;
    if (node.expression.text !== NOTE_FUNCTION) continue;
    const { line } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    const site = `${file}:${line + 1}`;
    sites.push(site);
    if (node.arguments.length !== 1) {
      refusals.push(
        `${site}: ${NOTE_FUNCTION} takes one note, and this call passes ${node.arguments.length}`,
      );
      continue;
    }
    const refusal = refusalFor(node.arguments[0]);
    if (refusal !== undefined) refusals.push(`${site}: ${refusal}`);
  }
  return { sites, refusals };
}

/** The scan over a tree of shipped sources, skipping files that name no note. */
function scanTree(tree) {
  const sites = [];
  const refusals = [];
  for (const file of sourceModules(tree)) {
    const text = readSource(file);
    if (!text.includes(NOTE_FUNCTION)) continue;
    const found = scanNoteCalls(file, parseSource(file, text));
    sites.push(...found.sites);
    refusals.push(...found.refusals);
  }
  return { sites, refusals };
}

// Each case is one statement on the second line of a fixture, so what a
// refusal reports about where the call sits is asserted alongside the shape.
const FIXTURE = `${COMPOSING_TREE}/noteShapeFixture.ts`;
const FIXTURE_PREAMBLE = "// fixture";
const FIXTURE_LINE = 2;

const ACCEPTED = [
  ["a fixed sentence", 'firstPartyNote("the input may not match this run");'],
  [
    "fixed sentences concatenated",
    'firstPartyNote("the input may not match " + "this run");',
  ],
  ["a template of fixed text", "firstPartyNote(`the input may not match`);"],
  [
    "an escaped column name interpolated into fixed text",
    'firstPartyNote(`the column "${sanitizeForDisplay(idColumn)}" repeats`);',
  ],
  [
    "an escaped column name in a template concatenated with fixed text",
    'firstPartyNote(`the column ${sanitizeForDisplay(idColumn)} ` + "repeats");',
  ],
];

const REFUSED = [
  ["a value the call site was handed", "firstPartyNote(note);"],
  ["the return of another function", "firstPartyNote(describeMismatch(row));"],
  ["a value read off an object", "firstPartyNote(report.note);"],
  [
    "a supplied column name interpolated unescaped",
    'firstPartyNote(`the column "${idColumn}" repeats`);',
  ],
  [
    "a fragment interpolated through a renderer that is not the escape",
    'firstPartyNote(`the column "${renderOperatorSuppliedText(idColumn)}" repeats`);',
  ],
  [
    "an escape reached through a namespace",
    'firstPartyNote(`the column "${core.sanitizeForDisplay(idColumn)}" repeats`);',
  ],
  [
    "a supplied column name concatenated in",
    'firstPartyNote("the column " + idColumn + " repeats");',
  ],
  [
    "one of two sentences chosen at runtime",
    'firstPartyNote(anyDuplicate ? "duplicates" : note);',
  ],
  ["no note at all", "firstPartyNote();"],
  ["two arguments", 'firstPartyNote("the column ", idColumn);'],
];

/** The refusals a one-statement fixture earns. */
function fixtureRefusals(statement) {
  const text = `${FIXTURE_PREAMBLE}\n${statement}\n`;
  return scanNoteCalls(FIXTURE, parseSource(FIXTURE, text)).refusals;
}

describe("the note shapes the check accepts", () => {
  it.each(ACCEPTED)("accepts %s", (_name, statement) => {
    expect(fixtureRefusals(statement)).toEqual([]);
  });
});

describe("the note shapes the check refuses", () => {
  it.each(REFUSED)("refuses %s", (_name, statement) => {
    const refusals = fixtureRefusals(statement);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(
      new RegExp(`^${FIXTURE.replaceAll(/[./]/g, "\\$&")}:${FIXTURE_LINE}: `),
    );
  });
});

describe("the notes the shipped sources compose", () => {
  const composed = scanTree(COMPOSING_TREE);

  it("reads the calls it is pointed at", () => {
    expect(
      composed.sites.length,
      `the scan read no ${NOTE_FUNCTION} call in ${COMPOSING_TREE} at all, so it holds nothing`,
    ).toBeGreaterThan(0);
  });

  it("composes every note from fixed text and escaped fragments", () => {
    expect(
      composed.refusals,
      `each note is the call site's own literal text, with every interpolated fragment escaped by ${ESCAPE_FUNCTION} where it goes in: a note built any other way is exempted from the display cap on nothing but the caller's word`,
    ).toEqual([]);
  });

  it.each(SOURCE_TREES.filter((tree) => tree !== COMPOSING_TREE))(
    "composes no note in %s",
    (tree) => {
      expect(
        scanTree(tree).sites,
        `${NOTE_FUNCTION} is composed in ${COMPOSING_TREE}: a consumer is handed a Displayable and renders it`,
      ).toEqual([]);
    },
  );
});
