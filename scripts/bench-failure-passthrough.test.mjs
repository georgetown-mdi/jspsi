import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  descendants,
  parseFile,
  parseSource,
  readSource,
  sourceModules,
} from "./lib/typeScriptSources.mjs";

// Every seat hands the failure `failureFor` composed straight to `setFailure`,
// with nothing of its own added to it.
//
// A failure's alert is composed from the lifecycle's category alone, which is
// what keeps relayed terminal text inert: a rendezvous directory is
// partner-writable and core's foreign-file terminal names the offending files
// verbatim, so a filename an untrusted party chose -- holding the CLI's own
// refusal wording -- reaches a seat inside a message this app composed no part
// of. It can never select a title or the copy that tells an operator what to do,
// because no per-run value reaches that choice. A seat that decorated the
// composed failure -- retitling it, splicing a fragment of the terminal into its
// message, reading a member off it to render alone -- would reopen exactly that.
//
// The unit pins in apps/web/test/unit/jobRunDiagnostics.unit.test.ts and
// apps/web/test/unit/reattachOnBusy.test.ts measure `failureFor` itself, which
// is where the composition happens; a decorating call site would redden neither,
// since the unit project is node-only and renders no seat. Those pins state that
// limit in prose, and prose asserting a code fact rots silently; this is the
// other half as a check.
//
// It is an INCLUSION check over the directory: the call sites are found by
// walking the bench tree, so a seat nobody thought to list is covered the day it
// lands, and a module elsewhere in the web app's source that binds the name is
// folded into the same enumeration rather than left outside the walk. There is
// no allowance list -- every call site passes its result through.
//
// Reach and limits, stated rather than implied.
//
// The binding is matched by imported name and specifier tail, not resolved, so a
// same-named export of some other module would satisfy it; a module declaring a
// function of that name -- the declaring module itself, and anything that came to
// share the name -- is read through the declaration. A call to the name that
// neither of those attributes, reached through a namespace import say, is
// reported rather than skipped. What it decides about a call is SYNTACTIC: the
// result passes through when the call sits directly in the argument list of a
// call whose callee's final name is `setFailure`, with only type-level wrappers
// (parentheses, `as`, `!`) in between. Anything else done with the result --
// handing it to another call first, reading a member off it, spreading it into a
// value composed around it -- fails. A use the check does not read, including
// binding the result to a name or returning it, is reported as a shape it cannot
// read rather than passed over: a new idiom is a failure to answer, never a
// silent gap.
//
// What it does NOT decide: what `setFailure` does with the failure it is handed,
// or that the alert renders the title and message verbatim. Those are the seats'
// own tests. It reads sources only, so a call in a test file is outside it.

const SELF = "scripts/bench-failure-passthrough.test.mjs";

// The seats' directory, the wider source tree a stray binding could sit in, and
// the module declaring the composer, all repository-relative.
const BENCH_DIR = "apps/web/src/bench";
const WEB_SOURCE_DIR = "apps/web/src";
const COMPOSER_MODULE = "apps/web/src/bench/useInviterExchange.ts";

// The exported name the seats import, the tail every import specifier of it must
// include, and the sink its result is passed to.
const COMPOSER = "failureFor";
const COMPOSER_MODULE_TAIL = "useInviterExchange";
const SINK = "setFailure";

/**
 * The modules read: every source in the bench tree, plus any other source in the
 * web app that writes the composer's name at all. A mention that turns out to be
 * a comment binds nothing and contributes no call site, so the widening costs a
 * read rather than a false failure.
 */
function modulesToRead() {
  const written = new RegExp(`\\b${COMPOSER}\\b`);
  const bench = sourceModules(BENCH_DIR);
  const elsewhere = sourceModules(WEB_SOURCE_DIR).filter(
    (file) =>
      !file.startsWith(`${BENCH_DIR}/`) && written.test(readSource(file)),
  );
  return [...bench, ...elsewhere].sort();
}

/**
 * The local names a module binds to the composer: the aliases of a `failureFor`
 * named import from a specifier naming the declaring module, and the name the
 * declaring module gives its own function.
 */
function composerBindings(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === COMPOSER
    ) {
      names.add(COMPOSER);
      continue;
    }
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    if (!specifier.text.endsWith(COMPOSER_MODULE_TAIL)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements)
      if ((element.propertyName ?? element.name).text === COMPOSER)
        names.add(element.name.text);
  }
  return names;
}

/**
 * The node the result is handed to, reached out through the wrappers that pass
 * a value through unchanged, with the expression that arrives there.
 */
function receiverOfResult(call) {
  let arriving = call;
  for (;;) {
    const parent = arriving.parent;
    if (
      parent !== undefined &&
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isNonNullExpression(parent))
    ) {
      arriving = parent;
      continue;
    }
    return { receiver: parent, arriving };
  }
}

/** The name a callee ends in, for an identifier or a property access. */
function calleeName(callee) {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/**
 * What a call site does with the composed failure: `{}` when it passes through,
 * `{ decorated }` when it does something else with it, `{ unreadable }` when the
 * use is one this check does not follow.
 */
function useOfResult(call) {
  const { receiver, arriving } = receiverOfResult(call);
  if (receiver === undefined)
    return { unreadable: "the result reaches no enclosing expression" };
  if (ts.isCallExpression(receiver) && receiver.arguments.includes(arriving)) {
    const name = calleeName(receiver.expression);
    if (name === SINK) return {};
    return {
      decorated: `the result is passed to \`${name ?? ts.SyntaxKind[receiver.expression.kind]}\` rather than straight to ${SINK}`,
    };
  }
  if (ts.isPropertyAccessExpression(receiver))
    return {
      decorated: `the result is read for its \`${receiver.name.text}\` member rather than passed on whole`,
    };
  if (ts.isElementAccessExpression(receiver))
    return {
      decorated:
        "the result is read for a computed member rather than passed on whole",
    };
  if (ts.isSpreadAssignment(receiver) || ts.isSpreadElement(receiver))
    return {
      decorated: "the result is spread into a value composed around it",
    };
  return {
    unreadable: `the result reaches ${ts.SyntaxKind[receiver.kind]}, which this check does not follow`,
  };
}

/** Read a set of modules into one entry per call site of the composer. */
function readCallSites(modules, parse = parseFile) {
  const sites = [];
  for (const file of modules) {
    const sourceFile = parse(file);
    const bindings = composerBindings(sourceFile);
    for (const node of descendants(sourceFile)) {
      if (!ts.isCallExpression(node)) continue;
      const callee = node.expression;
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(),
      );
      const site = { file, line: line + 1 };
      if (ts.isIdentifier(callee) && bindings.has(callee.text)) {
        sites.push({ ...site, ...useOfResult(node) });
        continue;
      }
      if (calleeName(callee) === COMPOSER)
        sites.push({
          ...site,
          unreadable: `the call is written as \`${callee.getText()}\`, which this check cannot attribute to an import of the ${COMPOSER_MODULE_TAIL} module`,
        });
    }
  }
  return sites;
}

/** `path:line: what it does with the result`, the way a failure names a site. */
function describeSite(site) {
  return `${site.file}:${site.line}: ${site.decorated ?? site.unreadable}`;
}

/** A site's verdict alone, the way the pins below read a synthetic source. */
function verdictOf(site) {
  if (site.decorated) return `decorated: ${site.decorated}`;
  if (site.unreadable) return `unreadable: ${site.unreadable}`;
  return "passthrough";
}

const modules = modulesToRead();
const sites = readCallSites(modules);

describe("no seat decorates the failure it composed", () => {
  it("finds the call sites and the composer they are read against", () => {
    // A rot guard: a bench move, a rename of the composer, or an extraction of
    // the seats' failure path behind a helper would otherwise empty the
    // enumeration and make every assertion below vacuous.
    expect(modules.length).toBeGreaterThan(0);
    expect(sites.length).toBeGreaterThan(0);
    const exported = parseFile(COMPOSER_MODULE).statements.some(
      (statement) =>
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === COMPOSER &&
        statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        ),
    );
    expect(
      exported,
      `${COMPOSER_MODULE} no longer exports ${COMPOSER}. Every call site below ` +
        `is read against that name, so the rename has to reach ${SELF} too.`,
    ).toBe(true);
  });

  it("reads what every call site does with the result", () => {
    const unreadable = sites
      .filter((site) => site.unreadable)
      .map(describeSite);
    expect(
      unreadable,
      `${unreadable.length} use(s) of ${COMPOSER}'s result are shapes this ` +
        `check cannot read, so it cannot say whether the seat decorates them. ` +
        `Write the call as \`${SINK}(${COMPOSER}(...))\`, or teach ${SELF} the ` +
        `new idiom.`,
    ).toEqual([]);
  });

  it("passes every composed failure to the sink undecorated", () => {
    const decorated = sites.filter((site) => site.decorated).map(describeSite);
    expect(
      decorated,
      `${decorated.length} call site(s) do something with the failure ` +
        `${COMPOSER} composed other than hand it to ${SINK}. A failure's title ` +
        `and copy are composed from the lifecycle's category alone so that ` +
        `relayed terminal text -- which can carry a partner-chosen filename ` +
        `holding the CLI's own refusal wording verbatim -- selects no part of ` +
        `what an operator reads; a decoration at the seat reopens that, on a ` +
        `path the node-only unit pins cannot see. Pass the result through, and ` +
        `compose the variant inside ${COMPOSER}, where those pins measure it.`,
    ).toEqual([]);
  });

  it("reports a decorating call site beside the tree's own idiom", () => {
    // The defect this check exists for, pinned against a source of its own: a
    // seat in the bench's idiom that raises one failure the way every seat does
    // and then retitles, wraps, and reads members off the next three. Its last
    // call sits inside JSX, which a .tsx source parsed as plain TypeScript drops
    // entirely -- the seats include a component, so the parse has to follow the
    // extension.
    const sources = {
      "decorating/DecoratedSeat.tsx": `import { failureFor } from "./useInviterExchange";
         export function DecoratedSeat({ setFailure, setTitle }: SeatProps) {
           const raise = (category: ExchangeErrorCategory, error: unknown) => {
             setFailure(failureFor(category, error, inputSource, channel));
           };
           const retitle = (category: ExchangeErrorCategory, error: unknown) => {
             setFailure({ ...failureFor(category, error), title: relayed.title });
           };
           const wrap = (category: ExchangeErrorCategory, error: unknown) => {
             setFailure(withPartnerDetail(failureFor(category, error)));
           };
           const showTitle = (category: ExchangeErrorCategory, error: unknown) => {
             setTitle(failureFor(category, error).title);
           };
           const alert = <Alert message={failureFor("exchange", error).message}>{raise}</Alert>;
           return <section>{alert}</section>;
         }`,
    };
    expect(
      readCallSites(Object.keys(sources), (file) =>
        parseSource(file, sources[file]),
      ).map(verdictOf),
    ).toEqual([
      "passthrough",
      "decorated: the result is spread into a value composed around it",
      "decorated: the result is passed to `withPartnerDetail` rather than straight to setFailure",
      "decorated: the result is read for its `title` member rather than passed on whole",
      "decorated: the result is read for its `message` member rather than passed on whole",
    ]);
  });

  it("reports the shapes it cannot read rather than passing them", () => {
    // The fail-closed direction, pinned the same way: a use the check never
    // follows is named, not skipped. Each of these may well hand the failure on
    // untouched -- that is the point, since silence here would be the check
    // reporting a tree it did not read.
    const sources = {
      "unread/boundSeat.ts": `import { failureFor as composeFailure } from "@bench/useInviterExchange";
         export function boundSeat(category: ExchangeErrorCategory, error: unknown) {
           const failure = composeFailure(category, error);
           setFailure(failure);
         }
         export function returningSeat(category: ExchangeErrorCategory, error: unknown) {
           return composeFailure(category, error);
         }
         export function conditionalSeat(category: ExchangeErrorCategory, error: unknown) {
           setFailure(error ? composeFailure(category, error) : undefined);
         }`,
      "unread/namespacedSeat.ts": `import * as inviter from "./useInviterExchange";
         export function namespacedSeat(category: ExchangeErrorCategory, error: unknown) {
           setFailure(inviter.failureFor(category, error));
         }`,
    };
    expect(
      readCallSites(Object.keys(sources), (file) =>
        parseSource(file, sources[file]),
      ).map(verdictOf),
    ).toEqual([
      "unreadable: the result reaches VariableDeclaration, which this check does not follow",
      "unreadable: the result reaches ReturnStatement, which this check does not follow",
      "unreadable: the result reaches ConditionalExpression, which this check does not follow",
      "unreadable: the call is written as `inviter.failureFor`, which this check cannot attribute to an import of the useInviterExchange module",
    ]);
  });

  it("passes a call site the type-level wrappers leave undecorated", () => {
    // Parentheses and a type assertion pass the value through unchanged, so a site
    // written through them is a pass-through and not a shape to answer for.
    const sources = {
      "wrapped/wrappedSeat.ts": `import { failureFor } from "./useInviterExchange";
         export function wrappedSeat(category: ExchangeErrorCategory, error: unknown) {
           setFailure((failureFor(category, error) as RunFailure)!);
         }`,
    };
    expect(
      readCallSites(Object.keys(sources), (file) =>
        parseSource(file, sources[file]),
      ).map(verdictOf),
    ).toEqual(["passthrough"]);
  });
});
