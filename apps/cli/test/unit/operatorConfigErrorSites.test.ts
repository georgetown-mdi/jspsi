import { readFileSync, readdirSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { expect, test } from "vitest";

// The `config` event category is keyed on the `OperatorConfigError` TYPE alone
// (classifyTerminalError in src/eventStream.ts), and the category's definition
// -- docs/spec/CLI_EVENTS.md -- promises an operator that what it carries is
// composed solely of their own configuration. Membership is therefore a
// standing licence: a check that raises the type inherits the trusted label,
// whatever its message turns out to quote.
//
// This file is the ledger that holds the licence. It enumerates every place the
// type (or a subclass) is constructed, together with the expressions each one
// interpolates into its message and the provenance verdict for each, so a site
// added later cannot join the category silently and an interpolation added to
// an existing site cannot ride in under a verdict taken for a different one.
//
// What the scan reaches, which is the whole of what it claims:
//
// - The three product source trees below, parsed as this checkout ships them.
//   Nothing resolves an import, a type or a symbol; every decision is syntactic
//   and single-file.
// - A member class is `OperatorConfigError` or any class in those trees written
//   as `class X extends <member>`, to a fixed point. A member introduced some
//   other way -- assigned, mixed in, declared outside these trees -- is not seen.
// - A construction site is a `new <Identifier>(...)` whose identifier names a
//   member as spelled. One written through an alias, a variable, or a factory is
//   not seen.
// - An interpolation is any expression contributing text to the first argument
//   that is not fixed literal text. String concatenation, template spans,
//   parentheses and the two branches of a conditional are followed; a
//   conditional's CONDITION is not, contributing no text of its own. An
//   identifier bound to a module-level constant in the same file is resolved
//   into that constant, exactly, since a constant has one value. A CALL is
//   recorded as written and NOT followed: its text depends on its arguments, so
//   the verdict below covers what the callee composes.
//
// Where the reach errs it errs toward reporting: an expression it cannot reduce
// to fixed text is recorded rather than ignored, so answering a spurious entry
// costs a line in the ledger and never a miss.

const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

// Every tree that can reach the two front ends' config classification: core
// raises the shared members, the CLI adds its own prepare-time ones, and the web
// keys its actionable `config` alert on the same base type. Scanning all three
// keeps the fence with the TYPE rather than with one consumer of it.
const SOURCE_TREES = ["packages/core/src", "apps/cli/src", "apps/web/src"];

const ROOT_MEMBER = "OperatorConfigError";

/**
 * A construction site, keyed by file and by the enclosing function rather than
 * by line, so ordinary edits above it do not churn the ledger.
 */
interface ConfigErrorSite {
  readonly file: string;
  readonly anchor: string;
  readonly raises: string;
  /** Every non-literal expression the message interpolates, sorted. */
  readonly interpolates: readonly string[];
  /** Why none of the above is partner-sourced. */
  readonly provenance: string;
}

// The recorded ledger. Each entry's `provenance` is the verdict a reviewer
// reached by reading the interpolated value back to its origin; the assertions
// below hold the SHAPE -- which sites exist, and what each interpolates -- so a
// change to either has to be answered here before it can pass.
const RECORDED_SITES: readonly ConfigErrorSite[] = [
  {
    file: "packages/core/src/exchange.ts",
    anchor: "assertSigningModeImplemented",
    raises: "OperatorConfigError",
    interpolates: [],
    provenance:
      "fixed prose over the signing.mode enum literals; no value is quoted.",
  },
  {
    file: "packages/core/src/exchange.ts",
    anchor: "assertCertificateModePinsPartner",
    raises: "OperatorConfigError",
    interpolates: [],
    provenance:
      "fixed prose about this party's own signing block; no value is quoted.",
  },
  {
    file: "packages/core/src/exchange.ts",
    anchor: "assertCertificateModeNamesLocalParty",
    raises: "OperatorConfigError",
    interpolates: [],
    provenance:
      "fixed prose about this party's own terms identity; no value is quoted.",
  },
  {
    file: "packages/core/src/exchange.ts",
    anchor: "assertLocalCertificateAuthorizesAgreedIdentity",
    raises: "OperatorConfigError",
    interpolates: ["agreedIdentity", "certificate.identity"],
    provenance:
      "both names are this party's own. `certificate.identity` is bound into " +
      "the signing identity file this party wrote. `agreedIdentity` is bound at " +
      "the sole caller (assertReceiptBindingsOrAbort) to " +
      "assertSignedReceiptNamesBothParties's `local`, which is " +
      "localTerms.identity -- and an acceptor's prepared terms replace that " +
      "field with the accepting operator's own name rather than adopting the " +
      "inviter's (deriveAcceptorLinkageTerms in config/linkageTerms.ts), so the " +
      "value is local on the accept path too.",
  },
  {
    file: "packages/core/src/exchange.ts",
    anchor: "prepareForExchange",
    raises: "OperatorConfigError",
    interpolates: [
      "MAX_KEY_CANDIDATES_PER_ROW",
      "linkageTerms.linkageKeys.length",
      "rawRows.length",
    ],
    provenance:
      "no partner-AUTHORED text: `rawRows.length` is this party's own record " +
      "count, `MAX_KEY_CANDIDATES_PER_ROW` a build constant, and " +
      "`linkageTerms.linkageKeys.length` a COUNT off the agreed terms, which " +
      "the accept path does adopt from the invitation. The count is the " +
      "verdict's whole basis -- what the content rule excludes is text another " +
      "party wrote, and a cardinality carries none of it, whichever document it " +
      "was read off. Interpolating a NAME from those same terms here would not " +
      "inherit this reasoning.",
  },
  {
    file: "packages/core/src/standardization.ts",
    anchor: "assertStandardizationMatchesTerms",
    raises: "StandardizationTermsError",
    interpolates: ['inconsistencies.join("; ")'],
    provenance:
      "the joined inconsistencies name transform outputs and step functions " +
      "read off the STANDARDIZATION argument, never the terms' own field names " +
      "(validateStandardizationAgainstTerms uses those only as a membership " +
      "set). This verdict rests on REACHABILITY rather than on the values' " +
      "shape: callers gate the assertion on an authored standardization, and an " +
      "acceptor's is reconstructed from its adopted terms by " +
      "getDefaultStandardization and so cannot contradict them (pinned in " +
      "packages/core/test/standardization.test.ts). A caller that fed a " +
      "partner-supplied standardization here would defeat it.",
  },
  {
    file: "packages/core/src/standardization.ts",
    anchor: "assertFanOutImplemented",
    raises: "OperatorConfigError",
    interpolates: ["fanOutDeclaredMessage(declared)"],
    provenance:
      "`declared` is read off this party's own standardization argument and is " +
      "matched against FAN_OUT_FUNCTION_NAMES before it reaches the message, so " +
      "what the callee interpolates is a build literal. The sibling arm over " +
      "the agreed terms' element transforms, which the accept path adopts " +
      "wholesale, deliberately raises a plain UsageError instead and is " +
      "correctly absent from this ledger.",
  },
  {
    file: "apps/cli/src/commands/exchange.ts",
    anchor: "certificateModeIdentityPath",
    raises: "OperatorConfigError",
    interpolates: [],
    provenance:
      "the message is SIGNING_IDENTITY_FILE_UNSET_REFUSAL, a module constant of " +
      "fixed prose; not even the configured path is quoted.",
  },
  {
    file: "apps/cli/src/signingIdentityDivergence.ts",
    anchor: "assertIdentityMatchesAgreedTerms",
    raises: "OperatorConfigError",
    interpolates: ["certificate.identity", "termsIdentity"],
    provenance:
      "both names are this party's own: `certificate.identity` is bound into " +
      "the signing identity file this party wrote, and `termsIdentity` is this " +
      "run's own linkage_terms.identity, which an acceptor supplies for itself " +
      "rather than adopting from the invitation (see the sibling core site " +
      "above).",
  },
];

/** Every TypeScript source under a repository-relative `dir`, sorted. */
function sourceModules(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(resolve(ROOT, dir), {
    withFileTypes: true,
  })) {
    const path = posix.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceModules(path));
    else if (/\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found.sort();
}

/**
 * Parse a repository-relative source as this checkout ships it. The script kind
 * follows the extension: a .tsx parsed as plain TypeScript loses its JSX, so a
 * construction written inside an element would not be in the tree to find.
 */
function parseFile(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(resolve(ROOT, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Every descendant of `node`, in source order. */
function descendants(node: ts.Node): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (child: ts.Node): void => {
    found.push(child);
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

const SOURCES = new Map(
  SOURCE_TREES.flatMap(sourceModules).map((file) => [file, parseFile(file)]),
);

/** Every class in the scanned trees that extends `OperatorConfigError`, transitively. */
function memberClasses(): Set<string> {
  const extendsByClass = new Map<string, string[]>();
  for (const source of SOURCES.values()) {
    for (const node of descendants(source)) {
      if (!ts.isClassDeclaration(node) || node.name === undefined) continue;
      const bases = (node.heritageClauses ?? [])
        .filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
        .flatMap((clause) => clause.types)
        .filter((type) => ts.isIdentifier(type.expression))
        .map((type) => (type.expression as ts.Identifier).text);
      extendsByClass.set(node.name.text, bases);
    }
  }
  const members = new Set([ROOT_MEMBER]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, bases] of extendsByClass) {
      if (members.has(name) || !bases.some((base) => members.has(base)))
        continue;
      members.add(name);
      grew = true;
    }
  }
  return members;
}

/** The initializer of a module-level `const NAME = ...` in `source`, if there is one. */
function moduleConstInitializer(
  source: ts.SourceFile,
  name: string,
): ts.Expression | undefined {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations)
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer !== undefined
      )
        return declaration.initializer;
  }
  return undefined;
}

/** Every non-literal expression `expr` contributes to the message text. */
function collectInterpolations(
  expr: ts.Expression,
  source: ts.SourceFile,
  resolved: Set<string>,
  found: Set<string>,
): void {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
    return;
  if (ts.isParenthesizedExpression(expr)) {
    collectInterpolations(expr.expression, source, resolved, found);
    return;
  }
  if (ts.isTemplateExpression(expr)) {
    for (const span of expr.templateSpans)
      collectInterpolations(span.expression, source, resolved, found);
    return;
  }
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    collectInterpolations(expr.left, source, resolved, found);
    collectInterpolations(expr.right, source, resolved, found);
    return;
  }
  if (ts.isConditionalExpression(expr)) {
    collectInterpolations(expr.whenTrue, source, resolved, found);
    collectInterpolations(expr.whenFalse, source, resolved, found);
    return;
  }
  if (ts.isIdentifier(expr) && !resolved.has(expr.text)) {
    const initializer = moduleConstInitializer(source, expr.text);
    if (initializer !== undefined) {
      resolved.add(expr.text);
      collectInterpolations(initializer, source, resolved, found);
      return;
    }
  }
  found.add(expr.getText(source).replace(/\s+/gu, " "));
}

/** The name of the function a node sits in, the ledger's line-independent anchor. */
function enclosingAnchor(node: ts.Node): string {
  for (
    let n: ts.Node | undefined = node.parent;
    n !== undefined;
    n = n.parent
  ) {
    if (ts.isFunctionDeclaration(n) && n.name !== undefined) return n.name.text;
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name))
      return n.name.text;
    if (
      (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) &&
      ts.isVariableDeclaration(n.parent) &&
      ts.isIdentifier(n.parent.name)
    )
      return n.parent.name.text;
  }
  return "(module scope)";
}

/** Every construction of a member class in the scanned trees. */
function foundSites(
  members: Set<string>,
): Omit<ConfigErrorSite, "provenance">[] {
  const sites: Omit<ConfigErrorSite, "provenance">[] = [];
  for (const [file, source] of SOURCES) {
    for (const node of descendants(source)) {
      if (!ts.isNewExpression(node)) continue;
      if (!ts.isIdentifier(node.expression)) continue;
      if (!members.has(node.expression.text)) continue;
      const message = node.arguments?.[0];
      const interpolates = new Set<string>();
      if (message !== undefined)
        collectInterpolations(message, source, new Set(), interpolates);
      sites.push({
        file,
        anchor: enclosingAnchor(node),
        raises: node.expression.text,
        interpolates: [...interpolates].sort(),
      });
    }
  }
  return sites;
}

const key = (site: { file: string; anchor: string }): string =>
  `${site.file} :: ${site.anchor}`;

// What a member's message may carry, quoted into both failures below so the
// verdict is stated where it has to be reached rather than only in the ledger.
const CONTENT_RULE =
  "The category promises the operator a fault composed solely of their OWN " +
  "configuration, so read every value the message interpolates back to its " +
  "origin. Text the partner authored -- invitation content, an adopted terms " +
  "field name, anything read off a peer frame -- must raise a plain UsageError " +
  "instead, whose message the front ends swallow rather than render. A count is " +
  "not authored text and may be quoted, whichever document it was read off.";

const SITE_SET_GUIDANCE =
  `A construction site joined or left the config event category. ${CONTENT_RULE} ` +
  "Then add or remove the entry in RECORDED_SITES, with that verdict as its " +
  "`provenance`.";

const INTERPOLATION_GUIDANCE =
  "This site's message interpolates something its ledger entry does not " +
  `account for, so the recorded verdict was not reached over it. ${CONTENT_RULE} ` +
  "Then update the entry's `interpolates` and `provenance` together.";

test("the config event category's members are the recorded ones", () => {
  // A new subclass is a second way the site list can grow: it inherits the
  // category through the instanceof check without naming the base type anywhere.
  expect([...memberClasses()].sort()).toStrictEqual([
    "OperatorConfigError",
    "StandardizationTermsError",
  ]);
});

test("every OperatorConfigError construction site is accounted for", () => {
  const found = foundSites(memberClasses()).map(key).sort();
  const recorded = RECORDED_SITES.map(key).sort();
  expect(found, SITE_SET_GUIDANCE).toStrictEqual(recorded);
});

test("no recorded site interpolates a partner-sourced value into its message", () => {
  const found = new Map(
    foundSites(memberClasses()).map((site) => [key(site), site]),
  );
  for (const recorded of RECORDED_SITES) {
    const site = found.get(key(recorded));
    expect(
      site,
      `${key(recorded)} is recorded but was not found`,
    ).toBeDefined();
    expect(site?.raises).toBe(recorded.raises);
    // Equality, not containment: an interpolation added to a site already in the
    // ledger would otherwise inherit a verdict taken for the values beside it.
    expect(
      site?.interpolates,
      `${key(recorded)}: ${INTERPOLATION_GUIDANCE} Recorded verdict: ${recorded.provenance}`,
    ).toStrictEqual([...recorded.interpolates]);
    expect(recorded.provenance.length).toBeGreaterThan(0);
  }
});
