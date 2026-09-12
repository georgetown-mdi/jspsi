import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

import repoConfig, { DISPLAYABLE_PRODUCERS } from "../eslint.config.mjs";
import {
  PROJECT_PARSER_OPTIONS,
  typeAwareRuleNames,
  withoutTypeAwareLayer,
} from "./eslint-strip-type-aware-layer.mjs";
import { filesUnder, parseFile } from "./lib/typeScriptSources.mjs";

// Coverage of the Displayable-as-error-text ban in the repo-root
// eslint.config.mjs: an already-escaped value may not be composed into an Error.
// Operator-facing escaping happens at ONE altitude -- the display sink -- and an
// Error is not one, so a Displayable composed into an error message or cause is
// escaped again where the chain is rendered and every literal backslash in it
// reaches the operator doubled. The ban is a set of esquery selectors, and a
// selector that stops matching fails silently: it keeps reporting zero problems,
// which is indistinguishable from clean source. These cases are what makes its
// coverage executable.
//
// Each case is linted through the real repo config against a path inside a
// guarded tree, so the scope, the selectors, and the rule wiring are all
// exercised as CI runs them rather than restated here. One transform is applied:
// the type-aware layer is stripped off (withoutTypeAwareLayer), so what this
// file reports rests on the text it hands in and nothing else, and no lint here
// waits on a TypeScript program being built.
//
// The other half is the producer list the selectors name. A Displayable is a
// brand the type system holds, so the rule can only name the calls that return
// one; a producer the list is missing is a call the ban reads as ordinary text.
// The scan at the end of this file reads the governed sources for that list.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: true,
  baseConfig: withoutTypeAwareLayer(repoConfig),
});

/**
 * Messages the Displayable-as-error-text ban reports for `source` linted as
 * `filePath`. A source that does not parse throws rather than counting as zero
 * problems.
 */
async function banHits(filePath, source) {
  const [result] = await eslint.lintText(source, { filePath });
  const fatal = result.messages.filter((message) => message.fatal);
  if (fatal.length > 0) {
    throw new Error(`${filePath}: ${fatal.map((m) => m.message).join("; ")}`);
  }
  return result.messages.filter(
    (message) =>
      message.ruleId === "no-restricted-syntax" &&
      message.message.startsWith(
        "Do not compose an already-escaped Displayable",
      ),
  );
}

// The test tree is the primary fixture path. A test is where the split is
// cheapest to get wrong -- composing an error out of an escaped fragment pins a
// rendering no operator ever sees -- and the src blocks are covered below.
const CORE_TEST_FILE = resolve(repoRoot, "packages/core/test/banFixture.ts");
const CORE_SRC_FILE = resolve(repoRoot, "packages/core/src/banFixture.ts");
const CLI_SRC_FILE = resolve(repoRoot, "apps/cli/src/banFixture.ts");
const CLI_TEST_FILE = resolve(repoRoot, "apps/cli/test/banFixture.ts");
const BROKER_FILE = resolve(
  repoRoot,
  "packages/peerjs-broker/src/banFixture.ts",
);

// Loading the typescript-eslint parser for the first time is the expensive part
// of a lintText call, independent of which file or how much text it is given;
// under cold process/CPU load that one-time cost alone can exceed vitest's 5s
// test default. A beforeAll absorbs it once, under its own explicit budget, so
// no individual case pays for it inside the default test timeout.
const LINTER_WARM_UP_TIMEOUT_MS = 30_000;

// Reserved for the canary: a guarded path that exists on disk, parses, and is
// linted by nothing else here. The module that owns the brand, so a rename
// there fails this rather than leaving the canary pointed at nothing.
const CORE_FILE_FIRST_PARSE = resolve(
  repoRoot,
  "packages/core/src/utils/sanitizeForDisplay.ts",
);

// Each entry is a statement body appended to a preamble that declares the
// bindings it uses, so a case looks like the line a contributor would write.
const BANNED = [
  [
    "an escaped decode description interpolated into an Error",
    "throw new Error(`invalid invitation string: ${describeDecodeError(err)}`);",
  ],
  [
    "an escaped fragment as the whole message",
    "throw new Error(sanitizeForDisplay(name));",
  ],
  [
    "an escaped fragment in an Error subclass",
    "throw new UsageError(sanitizeForDisplay(name));",
  ],
  [
    "an escaped fragment reached through a namespace",
    "throw new Error(core.sanitizeForDisplay(name));",
  ],
  ["a displayText composition", "throw new Error(displayText`at ${name}`);"],
  [
    "an escaped fragment concatenated into the message",
    'throw new Error("at " + sanitizeForDisplay(name));',
  ],
  [
    "an escaped fragment on a ternary branch",
    "throw new Error(name ? sanitizeForDisplay(name) : name);",
  ],
  [
    "an escaped fragment as the cause",
    "throw new Error(name, { cause: describeDecodeError(err) });",
  ],
  [
    "an escaped detail fragment in a cause chain",
    "chainDetailCauses([sanitizeForDisplay(name)]);",
  ],
  [
    "an escaped fragment in a fitted cause link",
    'fittedCauseLink("at: ", redactAndSanitizeForDisplay(name));',
  ],
  [
    "an escaped party identity interpolated into an Error",
    "throw new Error(`from ${displayPartyIdentity(identity)}`);",
  ],
  [
    "fragments escaped inside the composer's own call",
    "chainDetailCauses(names.map((each) => sanitizeForDisplay(each)));",
  ],
];

const ALLOWED = [
  [
    "the raw decode description the Error route takes",
    "throw new Error(`invalid invitation string: ${rawDecodeErrorDescription(err)}`);",
  ],
  [
    "a raw fragment interpolated into an Error",
    "throw new Error(`at ${name}`);",
  ],
  [
    "a raw fragment in a cause chain",
    "chainDetailCauses([`at: ${name}`], err);",
  ],
  [
    "an escaped fragment at a display sink",
    "console.error(sanitizeForDisplay(name));",
  ],
  [
    "an escaped fragment in a display field",
    "render({ label: sanitizeForDisplay(name) });",
  ],
];

const PREAMBLE = `
declare const err: unknown;
declare const name: string;
declare const names: string[];
declare const identity: unknown;
declare function sanitizeForDisplay(value: string): string;
declare function redactAndSanitizeForDisplay(value: string): string;
declare function describeDecodeError(value: unknown): string;
declare function rawDecodeErrorDescription(value: unknown): string;
declare function displayPartyIdentity(value: unknown): string;
declare function displayText(
  fixedSpans: TemplateStringsArray,
  ...values: unknown[]
): string;
declare function chainDetailCauses(
  details: readonly string[],
  tail?: unknown,
): unknown;
declare function fittedCauseLink(label: string, fragment: string): string;
declare function render(field: { label: string }): void;
declare class UsageError extends Error {}
declare const core: { sanitizeForDisplay(value: string): string };
export function fixture(): void {
`;

function fixture(body) {
  return `${PREAMBLE}  ${body}\n}\n`;
}

describe("the Displayable-as-error-text ban", () => {
  beforeAll(async () => {
    await banHits(CORE_TEST_FILE, fixture("throw new Error(`at ${name}`);"));
  }, LINTER_WARM_UP_TIMEOUT_MS);

  it("lints every path here with no TypeScript program behind it", async () => {
    for (const filePath of [
      CORE_TEST_FILE,
      CORE_SRC_FILE,
      CLI_SRC_FILE,
      CLI_TEST_FILE,
      BROKER_FILE,
      CORE_FILE_FIRST_PARSE,
    ]) {
      const config = await eslint.calculateConfigForFile(filePath);
      const parserOptions = config.languageOptions?.parserOptions ?? {};
      expect(
        Object.keys(parserOptions).filter((option) =>
          PROJECT_PARSER_OPTIONS.includes(option),
        ),
        `${filePath}: a TypeScript program is configured, so a type-aware rule can run -- and crash -- on ground this file does not test`,
      ).toEqual([]);
      expect(
        typeAwareRuleNames(config.rules, (prefix) => config.plugins?.[prefix]),
        `${filePath}: a type-aware rule survived the strip`,
      ).toEqual([]);
    }
  });

  it("lints the text it is handed, not the file on disk", async () => {
    expect(
      existsSync(CORE_FILE_FIRST_PARSE),
      `${CORE_FILE_FIRST_PARSE} no longer exists`,
    ).toBe(true);
    const [result] = await eslint.lintText("this is not typescript !!! (((\n", {
      filePath: CORE_FILE_FIRST_PARSE,
    });
    expect(
      result.messages.map((message) => message.message).join("; "),
      `${CORE_FILE_FIRST_PARSE}: the source on disk was linted instead, so a case asserting zero problems proves nothing about the text it handed in`,
    ).toMatch(/Parsing error/);
  });

  for (const [label, body] of BANNED) {
    it(`rejects ${label}`, async () => {
      expect(await banHits(CORE_TEST_FILE, fixture(body))).not.toHaveLength(0);
    });
  }

  for (const [label, body] of ALLOWED) {
    it(`accepts ${label}`, async () => {
      expect(await banHits(CORE_TEST_FILE, fixture(body))).toHaveLength(0);
    });
  }

  // Every tree the root config governs, src and test alike. The src blocks carry
  // their own no-restricted-syntax options, which flat config replaces rather
  // than merges, so each has to re-carry this ban to hold it.
  for (const [tree, filePath] of [
    ["packages/core/src", CORE_SRC_FILE],
    ["apps/cli/src", CLI_SRC_FILE],
    ["apps/cli/test", CLI_TEST_FILE],
    ["packages/peerjs-broker/src", BROKER_FILE],
  ]) {
    it(`guards ${tree} as well as packages/core/test`, async () => {
      expect(
        await banHits(
          filePath,
          fixture("throw new Error(sanitizeForDisplay(name));"),
        ),
      ).not.toHaveLength(0);
    });
  }
});

// The sources the producer list accounts for: every package's and the CLI's. A
// producer is exported from one of them -- a `Displayable` is core's brand, and
// the CLI composes with it -- and the extensions are the ones the ban's own
// globs cover.
const GOVERNED_SOURCE_TREES = [
  ...readdirSync(resolve(repoRoot, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/src`),
  "apps/cli/src",
];
const GOVERNED_SOURCE_EXTENSION = /\.(?:mts|ts|tsx)$/;

/**
 * What a return type annotation declares: `yes` for a `Displayable`, a
 * `Promise<Displayable>`, or a union holding one; `unreadable` for an annotation
 * naming `Displayable` in a shape this does not decide; `no` otherwise. An
 * unreadable one fails the scan rather than passing as a non-producer.
 */
function declaresDisplayable(typeNode) {
  if (typeNode === undefined) return "no";
  if (ts.isTypeReferenceNode(typeNode)) {
    const name = typeNode.typeName.getText();
    if (name === "Displayable")
      return typeNode.typeArguments ? "unreadable" : "yes";
    if (name === "Promise" && typeNode.typeArguments?.length === 1)
      return declaresDisplayable(typeNode.typeArguments[0]);
  }
  if (ts.isUnionTypeNode(typeNode)) {
    const members = typeNode.types.map(declaresDisplayable);
    if (members.includes("unreadable")) return "unreadable";
    return members.includes("yes") ? "yes" : "no";
  }
  return /\bDisplayable\b/.test(typeNode.getText()) ? "unreadable" : "no";
}

/**
 * The `[name, verdict]` pair of every function a top-level statement declares --
 * a function declaration, an arrow or function expression bound to a name, and
 * the default export of either, whose name is undefined.
 */
function declaredFunctions(statement) {
  if (ts.isFunctionDeclaration(statement))
    return [[statement.name?.text, declaresDisplayable(statement.type)]];
  if (ts.isExportAssignment(statement)) {
    const exported = statement.expression;
    const isFunction =
      ts.isArrowFunction(exported) || ts.isFunctionExpression(exported);
    return [
      [undefined, declaresDisplayable(isFunction ? exported.type : undefined)],
    ];
  }
  if (!ts.isVariableStatement(statement)) return [];
  return statement.declarationList.declarations.map((declaration) => {
    const bound = declaration.initializer;
    const returnType =
      bound && (ts.isArrowFunction(bound) || ts.isFunctionExpression(bound))
        ? bound.type
        : declaration.type && ts.isFunctionTypeNode(declaration.type)
          ? declaration.type.type
          : undefined;
    return [
      ts.isIdentifier(declaration.name) ? declaration.name.text : undefined,
      declaresDisplayable(returnType),
    ];
  });
}

/** Whether a top-level statement carries the `export` keyword. */
function isExported(statement) {
  return (statement.modifiers ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

/**
 * The names `file` exports as functions declaring a Displayable return type,
 * whether the export is on the declaration or in an `export { ... }` clause. A
 * declaration the scan cannot read, or cannot name, throws.
 */
function exportedDisplayableProducers(file) {
  const exportedNames = new Set();
  const declared = [];
  for (const statement of parseFile(file).statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements)
        exportedNames.add((element.propertyName ?? element.name).text);
    for (const [name, verdict] of declaredFunctions(statement)) {
      if (verdict === "no") continue;
      if (name === undefined)
        throw new Error(
          `${file}: a function declaring a Displayable return type is exported without a name, which the ban has no way to list`,
        );
      if (verdict === "unreadable")
        throw new Error(
          `${file}: the return type of ${name} names Displayable in a shape this scan does not read`,
        );
      declared.push([name, isExported(statement)]);
    }
  }
  return declared
    .filter(([name, exportedHere]) => exportedHere || exportedNames.has(name))
    .map(([name]) => name);
}

// Parsing every governed source costs about 0.7s on an idle machine, and rose to
// 10.9s under a full scripts-project run on a container already saturated by
// other work, which outran vitest's 10s hook default. The budget below is about
// five times that loaded measurement.
const PRODUCER_SCAN_TIMEOUT_MS = 60_000;

describe("the producers the ban names", () => {
  /** Each exported producer the governed sources declare, to the file it is in. */
  const found = new Map();

  beforeAll(() => {
    for (const tree of GOVERNED_SOURCE_TREES)
      for (const file of filesUnder(tree).filter((path) =>
        GOVERNED_SOURCE_EXTENSION.test(path),
      ))
        for (const name of exportedDisplayableProducers(file))
          found.set(name, file);
  }, PRODUCER_SCAN_TIMEOUT_MS);

  it("holds every exported Displayable producer in the governed sources", () => {
    expect(
      found.size,
      "the scan read no producer at all, so it holds nothing",
    ).toBeGreaterThan(0);
    expect(
      [...found]
        .filter(([name]) => !DISPLAYABLE_PRODUCERS.includes(name))
        .map(([name, file]) => `${name} (${file})`),
      "add each to DISPLAYABLE_PRODUCERS in eslint.config.mjs: the ban reads a call it does not name as ordinary text",
    ).toEqual([]);
  });

  it("names no producer the governed sources no longer export", () => {
    expect(
      DISPLAYABLE_PRODUCERS.filter((name) => !found.has(name)),
      "drop each from DISPLAYABLE_PRODUCERS in eslint.config.mjs: a name nothing exports matches nothing",
    ).toEqual([]);
  });
});
