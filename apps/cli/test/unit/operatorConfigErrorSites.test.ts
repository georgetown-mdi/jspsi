import { readFileSync, readdirSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, test } from "vitest";

// The `config` event category is keyed on the `OperatorConfigError` TYPE alone
// (classifyTerminalError in src/eventStream.ts), and the category's definition
// -- docs/spec/CLI_EVENTS.md -- promises an operator that what it holds is
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
//   No type checker runs; every decision is syntactic.
// - A class is identified by its DECLARATION -- file plus name, never the name
//   alone -- and a name written in an `extends` clause or a `new` is resolved
//   against what its file can see: that file's own declarations first, then its
//   imports, following a relative specifier, `@psilink/core`, or the web app's
//   `@*` path mapping to the imported file and on through its `export *` and
//   `export { ... } from` re-exports. A name that lands on more than one
//   declaration fails the scan naming both rather than picking one.
// - A member class is the `OperatorConfigError` declaration below or any class
//   in those trees written as `class X extends <member>`, to a fixed point. A
//   member introduced some other way -- assigned, mixed in, declared outside
//   these trees -- is not seen.
// - A construction site is a `new <Identifier>(...)` whose identifier resolves
//   to a member declaration. One written through an alias, a variable, or a
//   factory is not seen.
// - An interpolation is any expression contributing text to the first argument
//   that is not fixed literal text. String concatenation, template spans,
//   parentheses and the two branches of a conditional are followed; a
//   conditional's CONDITION is not, contributing no text of its own. An
//   identifier bound to a module-level constant in the same file resolves into
//   that constant, exactly, since a constant has one value -- unless a scope
//   between the use site and the module binds the name itself, which makes the
//   value opaque again and so a recorded interpolation. A CALL is recorded as
//   written and NOT followed: its text depends on its arguments, so the verdict
//   below covers what the callee composes.
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

/** A class declaration, the unit of class identity across the scanned trees. */
interface DeclarationRef {
  readonly file: string;
  readonly name: string;
}

const refKey = (ref: DeclarationRef): string => `${ref.file} :: ${ref.name}`;

const ROOT_MEMBER: DeclarationRef = {
  file: "packages/core/src/errors.ts",
  name: "OperatorConfigError",
};

// The core package entry: package.json's `exports` "." is the bundle rollup
// builds from this module, so an `@psilink/core` import reads its re-exports.
const CORE_ENTRY = "packages/core/src/main.ts";

const WEB_TREE = "apps/web/src";

/**
 * A construction site, keyed by file and by the enclosing function rather than
 * by line, so ordinary edits above it do not churn the ledger. Two constructions
 * under one anchor are two entries here, in source order; the ledger key numbers
 * them within the anchor.
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
      "inviter's (deriveAcceptedLinkageTerms in linkageTermsNegotiation.ts), " +
      "so the value is local on the accept path too.",
  },
  {
    file: "packages/core/src/exchange.ts",
    anchor: "prepareForExchange",
    raises: "OperatorConfigError",
    interpolates: [
      "SINGLE_PASS_LOCAL_REMEDY",
      "declaredRecordCount",
      "linkageTerms.linkageKeys.length",
    ],
    provenance:
      "no partner-AUTHORED text: `declaredRecordCount` is this party's own " +
      "record count times a build constant, and " +
      "`linkageTerms.linkageKeys.length` a COUNT off the agreed terms, which " +
      "the accept path does adopt from the invitation. The count is the " +
      "verdict's whole basis -- what the content rule excludes is text another " +
      "party wrote, and a cardinality carries none of it, whichever document it " +
      "was read off. Interpolating a NAME from those same terms here would not " +
      "inherit this reasoning. `SINGLE_PASS_LOCAL_REMEDY` " +
      "(connection/frameSize.ts) is a module constant of fixed prose, shared " +
      "with the two-party gate's message so the two state one remedy; it quotes " +
      "no value at all.",
  },
  {
    file: "packages/core/src/linkageSatisfiability.ts",
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
      "packages/core/test/linkageSatisfiability.test.ts). A caller that fed a " +
      "partner-supplied standardization here would defeat it.",
  },
  {
    file: "packages/core/src/linkageSatisfiability.ts",
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
    file: "packages/core/src/linkageSatisfiability.ts",
    anchor: "assertTransformsCompile",
    raises: "OperatorConfigError",
    interpolates: ["stepCompileRefusalMessage(label)"],
    provenance:
      "`label` is read off this party's own standardization argument and is " +
      "narrowed by transformFunctionLabel before it reaches the message, so " +
      "what the callee interpolates is either a build literal from " +
      "STANDARDIZATION_FUNCTION_NAMES or the fixed stand-in for a name this " +
      "build does not recognize. The sibling arm over the agreed terms' " +
      "element transforms, which the accept path adopts wholesale, raises a " +
      "plain UsageError instead and is correctly absent from this ledger -- " +
      "the same split assertFanOutImplemented above keeps.",
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
 * Parse a source under its repository-relative name. The script kind follows the
 * extension: a .tsx parsed as plain TypeScript loses its JSX, so a construction
 * written inside an element would not be in the tree to find.
 */
function parseSource(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
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

/** A class declaration together with the names its `extends` clause spells. */
interface ClassDeclaration extends DeclarationRef {
  readonly baseNames: readonly string[];
}

/** The module and exported name an `import` binds a local name to. */
interface ImportBinding {
  readonly specifier: string;
  readonly exported: string;
}

/** An `export * from` (no `names`) or an `export { a as b } from`. */
interface ReExport {
  readonly specifier: string;
  /** Exported name to the name the target module exports it under. */
  readonly names?: ReadonlyMap<string, string>;
}

interface FileIndex {
  readonly declared: readonly ClassDeclaration[];
  /** By the name the file resolves, which includes `default` for a default export. */
  readonly classes: ReadonlyMap<string, ClassDeclaration>;
  readonly imports: ReadonlyMap<string, ImportBinding>;
  readonly reExports: readonly ReExport[];
}

/** A name whose use site left the resolver with more than one candidate. */
interface AmbiguousName {
  readonly file: string;
  readonly name: string;
  readonly candidates: readonly ClassDeclaration[];
}

interface Scan {
  readonly sources: ReadonlyMap<string, ts.SourceFile>;
  readonly files: ReadonlyMap<string, FileIndex>;
  readonly declarations: readonly ClassDeclaration[];
  readonly byName: ReadonlyMap<string, ClassDeclaration[]>;
  /** Filled as the resolver runs, keyed by use site so one name reports once. */
  readonly ambiguities: Map<string, AmbiguousName>;
}

/** Every identifier a binding name introduces, destructuring included. */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingNames(element.name) : [],
  );
}

function indexFile(file: string, source: ts.SourceFile): FileIndex {
  const declared: ClassDeclaration[] = [];
  const classes = new Map<string, ClassDeclaration>();
  const imports = new Map<string, ImportBinding>();
  const reExports: ReExport[] = [];

  for (const node of descendants(source)) {
    if (!ts.isClassDeclaration(node) || node.name === undefined) continue;
    const baseNames = (node.heritageClauses ?? [])
      .filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
      .flatMap((clause) => clause.types)
      .filter((type) => ts.isIdentifier(type.expression))
      .map((type) => (type.expression as ts.Identifier).text);
    const declaration: ClassDeclaration = {
      file,
      name: node.name.text,
      baseNames,
    };
    declared.push(declaration);
    classes.set(declaration.name, declaration);
    if (
      node.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
      )
    )
      classes.set("default", declaration);
  }

  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause?.name !== undefined)
        imports.set(clause.name.text, { specifier, exported: "default" });
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings))
        for (const element of bindings.elements)
          imports.set(element.name.text, {
            specifier,
            exported: (element.propertyName ?? element.name).text,
          });
      continue;
    }
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.exportClause;
    if (clause === undefined) {
      reExports.push({ specifier });
      continue;
    }
    if (!ts.isNamedExports(clause)) continue;
    reExports.push({
      specifier,
      names: new Map(
        clause.elements.map((element) => [
          element.name.text,
          (element.propertyName ?? element.name).text,
        ]),
      ),
    });
  }

  return { declared, classes, imports, reExports };
}

function scanSources(sources: ReadonlyMap<string, ts.SourceFile>): Scan {
  const files = new Map<string, FileIndex>();
  const declarations: ClassDeclaration[] = [];
  const byName = new Map<string, ClassDeclaration[]>();
  for (const [file, source] of sources) {
    const index = indexFile(file, source);
    files.set(file, index);
    for (const declaration of index.declared) {
      declarations.push(declaration);
      const sameName = byName.get(declaration.name) ?? [];
      sameName.push(declaration);
      byName.set(declaration.name, sameName);
    }
  }
  return { sources, files, declarations, byName, ambiguities: new Map() };
}

/** The scanned module a path resolves to, over the extensions the trees write. */
function sourceAt(
  base: string,
  sources: ReadonlyMap<string, ts.SourceFile>,
): string | undefined {
  const stems = /\.jsx?$/u.test(base)
    ? [base.replace(/\.jsx?$/u, ""), base]
    : [base];
  for (const stem of stems)
    for (const candidate of [
      `${stem}.ts`,
      `${stem}.tsx`,
      stem,
      posix.join(stem, "index.ts"),
      posix.join(stem, "index.tsx"),
    ])
      if (sources.has(candidate)) return candidate;
  return undefined;
}

/** The scanned module `specifier` names from `fromFile`, if it names one at all. */
function resolveSpecifier(
  fromFile: string,
  specifier: string,
  sources: ReadonlyMap<string, ts.SourceFile>,
): string | undefined {
  if (specifier === "@psilink/core")
    return sources.has(CORE_ENTRY) ? CORE_ENTRY : undefined;
  if (specifier.startsWith("."))
    return sourceAt(posix.join(posix.dirname(fromFile), specifier), sources);
  // The web app's tsconfig maps `@*` onto `./src/*` and falls through to
  // node_modules when nothing is there, which is what an unfound path is here.
  if (specifier.startsWith("@") && fromFile.startsWith(`${WEB_TREE}/`))
    return sourceAt(posix.join(WEB_TREE, specifier.slice(1)), sources);
  return undefined;
}

function distinct(declarations: ClassDeclaration[]): ClassDeclaration[] {
  return [
    ...new Map(
      declarations.map((declaration) => [refKey(declaration), declaration]),
    ).values(),
  ];
}

/** The declarations `file` exports as `name`, through its re-exports. */
function exportedDeclarations(
  file: string,
  name: string,
  scan: Scan,
  seen: Set<string>,
): ClassDeclaration[] {
  const visit = `${file} :: ${name}`;
  if (seen.has(visit)) return [];
  seen.add(visit);
  const index = scan.files.get(file);
  if (index === undefined) return [];
  const own = index.classes.get(name);
  if (own !== undefined) return [own];
  const imported = index.imports.get(name);
  if (imported !== undefined) {
    const target = resolveSpecifier(file, imported.specifier, scan.sources);
    return target === undefined
      ? []
      : exportedDeclarations(target, imported.exported, scan, seen);
  }
  const found: ClassDeclaration[] = [];
  for (const reExport of index.reExports) {
    const original =
      reExport.names === undefined ? name : reExport.names.get(name);
    if (original === undefined) continue;
    const target = resolveSpecifier(file, reExport.specifier, scan.sources);
    if (target !== undefined)
      found.push(...exportedDeclarations(target, original, scan, seen));
  }
  return distinct(found);
}

type Resolution =
  | { readonly kind: "declaration"; readonly declaration: ClassDeclaration }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "unresolved" };

/** The declarations an import in `file` binds `name` to, or undefined if none does. */
function importedCandidates(
  file: string,
  name: string,
  scan: Scan,
): ClassDeclaration[] | undefined {
  const imported = scan.files.get(file)?.imports.get(name);
  if (imported === undefined) return undefined;
  const target = resolveSpecifier(file, imported.specifier, scan.sources);
  return target === undefined
    ? []
    : exportedDeclarations(target, imported.exported, scan, new Set());
}

/**
 * The declaration `name` denotes where `file` writes it. A name the file neither
 * declares nor imports falls back to the scanned declarations holding it, which
 * is where two trees can offer the same name: the resolver records the collision
 * and resolves nothing rather than picking a side.
 */
function resolveClassName(file: string, name: string, scan: Scan): Resolution {
  const own = scan.files.get(file)?.classes.get(name);
  if (own !== undefined) return { kind: "declaration", declaration: own };
  const candidates =
    importedCandidates(file, name, scan) ?? scan.byName.get(name) ?? [];
  if (candidates.length === 0) return { kind: "unresolved" };
  if (candidates.length === 1)
    return { kind: "declaration", declaration: candidates[0] };
  scan.ambiguities.set(`${file} :: ${name}`, { file, name, candidates });
  return { kind: "ambiguous" };
}

/**
 * Every class declaration that is the root member or extends one, transitively,
 * as a set of declaration keys.
 */
function memberDeclarations(scan: Scan, root: DeclarationRef): Set<string> {
  const rootDeclaration = scan.files.get(root.file)?.classes.get(root.name);
  if (rootDeclaration === undefined)
    throw new Error(
      `${refKey(root)} is not declared in the scanned trees, so the category has no root to close over. Point ROOT_MEMBER at the declaration it moved to.`,
    );
  const members = new Set([refKey(rootDeclaration)]);
  for (let grew = true; grew;) {
    grew = false;
    for (const declaration of scan.declarations) {
      if (members.has(refKey(declaration))) continue;
      const extendsMember = declaration.baseNames.some((base) => {
        const resolution = resolveClassName(declaration.file, base, scan);
        return (
          resolution.kind === "declaration" &&
          members.has(refKey(resolution.declaration))
        );
      });
      if (!extendsMember) continue;
      members.add(refKey(declaration));
      grew = true;
    }
  }
  return members;
}

/**
 * The collisions that can move the fence: one whose candidates are all
 * non-members leaves both the member set and the site list as they are.
 */
function materialAmbiguities(scan: Scan, members: Set<string>): string[] {
  return [...scan.ambiguities.values()]
    .filter((ambiguity) =>
      ambiguity.candidates.some((candidate) => members.has(refKey(candidate))),
    )
    .map(
      (ambiguity) =>
        `${ambiguity.file}: \`${ambiguity.name}\` resolves to ${ambiguity.candidates.map(refKey).join(" and ")}`,
    )
    .sort();
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

/** Whether `scope` binds `name` itself: a parameter, a local, or a catch variable. */
function bindsName(scope: ts.Node, name: string): boolean {
  if (ts.isFunctionLike(scope))
    return scope.parameters.some((parameter) =>
      bindingNames(parameter.name).includes(name),
    );
  if (ts.isCatchClause(scope))
    return (
      scope.variableDeclaration !== undefined &&
      bindingNames(scope.variableDeclaration.name).includes(name)
    );
  const declarations: ts.VariableDeclaration[] = [];
  if (
    ts.isBlock(scope) ||
    ts.isModuleBlock(scope) ||
    ts.isCaseClause(scope) ||
    ts.isDefaultClause(scope)
  )
    for (const statement of scope.statements)
      if (ts.isVariableStatement(statement))
        declarations.push(...statement.declarationList.declarations);
  if (
    (ts.isForStatement(scope) ||
      ts.isForOfStatement(scope) ||
      ts.isForInStatement(scope)) &&
    scope.initializer !== undefined &&
    ts.isVariableDeclarationList(scope.initializer)
  )
    declarations.push(...scope.initializer.declarations);
  return declarations.some((declaration) =>
    bindingNames(declaration.name).includes(name),
  );
}

/** Whether a scope between `node` and its module binds `name`, hiding the module's. */
function isShadowed(node: ts.Node, name: string): boolean {
  for (
    let scope: ts.Node | undefined = node.parent;
    scope !== undefined && !ts.isSourceFile(scope);
    scope = scope.parent
  )
    if (bindsName(scope, name)) return true;
  return false;
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
  if (
    ts.isIdentifier(expr) &&
    !resolved.has(expr.text) &&
    !isShadowed(expr, expr.text)
  ) {
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

/** Every construction of a member class in the scanned trees, in source order. */
function foundSites(
  scan: Scan,
  members: Set<string>,
): Omit<ConfigErrorSite, "provenance">[] {
  const sites: Omit<ConfigErrorSite, "provenance">[] = [];
  for (const [file, source] of scan.sources) {
    for (const node of descendants(source)) {
      if (!ts.isNewExpression(node)) continue;
      if (!ts.isIdentifier(node.expression)) continue;
      const resolution = resolveClassName(file, node.expression.text, scan);
      if (
        resolution.kind !== "declaration" ||
        !members.has(refKey(resolution.declaration))
      )
        continue;
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

/**
 * Each site with its ledger key: file, anchor, and the site's ordinal within
 * that anchor, so two constructions under one anchor stay two rows.
 */
function keyed<T extends { file: string; anchor: string }>(
  sites: readonly T[],
): [string, T][] {
  const seen = new Map<string, number>();
  return sites.map((site) => {
    const anchor = `${site.file} :: ${site.anchor}`;
    const ordinal = (seen.get(anchor) ?? 0) + 1;
    seen.set(anchor, ordinal);
    return [`${anchor} #${ordinal}`, site];
  });
}

const SOURCES = new Map(
  SOURCE_TREES.flatMap(sourceModules).map((file) => [
    file,
    parseSource(file, readFileSync(resolve(ROOT, file), "utf8")),
  ]),
);

const SCAN = scanSources(SOURCES);
const MEMBERS = memberDeclarations(SCAN, ROOT_MEMBER);
const FOUND_SITES = foundSites(SCAN, MEMBERS);

// What a member's message may hold, quoted into both failures below so the
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

const AMBIGUITY_GUIDANCE =
  "A class name written in an `extends` clause or a `new` matches more than " +
  "one declaration in the scanned trees, and the scan will not pick one, so " +
  "the member set below cannot be trusted. Import the class the site means, or " +
  "rename one of the two declarations.";

test("every class name the scan resolves lands on one declaration", () => {
  expect(materialAmbiguities(SCAN, MEMBERS), AMBIGUITY_GUIDANCE).toStrictEqual(
    [],
  );
});

test("the config event category's members are the recorded ones", () => {
  // A new subclass is a second way the site list can grow: it inherits the
  // category through the instanceof check without naming the base type anywhere.
  expect([...MEMBERS].sort()).toStrictEqual([
    "packages/core/src/errors.ts :: OperatorConfigError",
    "packages/core/src/errors.ts :: StandardizationTermsError",
  ]);
});

test("every OperatorConfigError construction site is accounted for", () => {
  const found = keyed(FOUND_SITES)
    .map(([siteKey]) => siteKey)
    .sort();
  const recorded = keyed(RECORDED_SITES)
    .map(([siteKey]) => siteKey)
    .sort();
  expect(found, SITE_SET_GUIDANCE).toStrictEqual(recorded);
});

test("no recorded site interpolates a partner-sourced value into its message", () => {
  const recorded = new Map(keyed(RECORDED_SITES));
  for (const [siteKey, site] of keyed(FOUND_SITES)) {
    const entry = recorded.get(siteKey);
    expect(entry, `${siteKey} was found but is not recorded`).toBeDefined();
    if (entry === undefined) continue;
    expect(site.raises).toBe(entry.raises);
    // Equality, not containment: an interpolation added to a site already in the
    // ledger would otherwise inherit a verdict taken for the values beside it.
    expect(
      site.interpolates,
      `${siteKey}: ${INTERPOLATION_GUIDANCE} Recorded verdict: ${entry.provenance}`,
    ).toStrictEqual([...entry.interpolates]);
    expect(entry.provenance.length).toBeGreaterThan(0);
  }
});

const FIXTURE_ROOT: DeclarationRef = {
  file: "fixture/errors.ts",
  name: "OperatorConfigError",
};

const FIXTURE_ERRORS = "export class OperatorConfigError extends Error {}\n";

function fixtureScan(files: Record<string, string>): Scan {
  return scanSources(
    new Map(
      Object.entries(files).map(([file, text]) => [
        file,
        parseSource(file, text),
      ]),
    ),
  );
}

// The reach cases the shipped trees do not exercise, held over synthetic sources
// so they stay pinned whatever the product code happens to declare today.
describe("the scan's reach", () => {
  test("a same-named class elsewhere does not drop a member", () => {
    const scan = fixtureScan({
      "fixture/errors.ts": FIXTURE_ERRORS,
      "fixture/member.ts": `
import { OperatorConfigError } from "./errors.js";
export class Refusal extends OperatorConfigError {
  static raise(): never {
    throw new Refusal("refused");
  }
}
`,
      "fixture/unrelated.ts": "export class Refusal {}\n",
    });
    const members = memberDeclarations(scan, FIXTURE_ROOT);
    expect([...members].sort()).toStrictEqual([
      "fixture/errors.ts :: OperatorConfigError",
      "fixture/member.ts :: Refusal",
    ]);
    expect(
      keyed(foundSites(scan, members)).map(([siteKey]) => siteKey),
    ).toStrictEqual(["fixture/member.ts :: raise #1"]);
  });

  test("a name matching two declarations fails rather than picking one", () => {
    const scan = fixtureScan({
      "fixture/errors.ts": FIXTURE_ERRORS,
      "fixture/member.ts": `
import { OperatorConfigError } from "./errors.js";
export class Refusal extends OperatorConfigError {}
`,
      "fixture/unrelated.ts": "export class Refusal {}\n",
      "fixture/derived.ts": "export class Narrower extends Refusal {}\n",
    });
    const members = memberDeclarations(scan, FIXTURE_ROOT);
    expect(materialAmbiguities(scan, members)).toStrictEqual([
      "fixture/derived.ts: `Refusal` resolves to fixture/member.ts :: Refusal and fixture/unrelated.ts :: Refusal",
    ]);
    expect(members.has("fixture/derived.ts :: Narrower")).toBe(false);
  });

  test("two constructions under one anchor are two ledger rows", () => {
    const scan = fixtureScan({
      "fixture/errors.ts": FIXTURE_ERRORS,
      "fixture/sites.ts": `
import { OperatorConfigError } from "./errors.js";
export function guard(count: number): void {
  if (count === 0) throw new OperatorConfigError("no rows are configured");
  throw new OperatorConfigError(\`too many rows: \${count}\`);
}
`,
    });
    const sites = keyed(
      foundSites(scan, memberDeclarations(scan, FIXTURE_ROOT)),
    );
    expect(
      sites.map(([siteKey, site]) => [siteKey, site.interpolates]),
    ).toStrictEqual([
      ["fixture/sites.ts :: guard #1", []],
      ["fixture/sites.ts :: guard #2", ["count"]],
    ]);
  });

  test("a shadowed constant is recorded as an opaque interpolation", () => {
    const scan = fixtureScan({
      "fixture/errors.ts": FIXTURE_ERRORS,
      "fixture/shadowing.ts": `
import { OperatorConfigError } from "./errors.js";
const detail = "the configured signing mode";
export function fixedDetail(): never {
  throw new OperatorConfigError(\`unsupported: \${detail}\`);
}
export function parameterShadows(detail: string): never {
  throw new OperatorConfigError(\`unsupported: \${detail}\`);
}
export function localShadows(input: string): never {
  const detail = input.trim();
  throw new OperatorConfigError(\`unsupported: \${detail}\`);
}
`,
    });
    const sites = keyed(
      foundSites(scan, memberDeclarations(scan, FIXTURE_ROOT)),
    );
    expect(
      sites.map(([siteKey, site]) => [siteKey, site.interpolates]),
    ).toStrictEqual([
      ["fixture/shadowing.ts :: fixedDetail #1", []],
      ["fixture/shadowing.ts :: parameterShadows #1", ["detail"]],
      ["fixture/shadowing.ts :: localShadows #1", ["detail"]],
    ]);
  });
});
