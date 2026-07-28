import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Every server round trip the SFTP adapter issues must pass through its
// tracked() bracket, which is what keeps the outstanding-operation count -- the
// idle-boundary release's precondition (a boundary reached with a counted
// operation outstanding closes nothing, because the close would tear that
// operation off the wire). A round trip issued outside the bracket is invisible
// to that precondition, so a release falls while it is on the wire and tears it;
// the same bracket is where the heartbeat's in-flight state is kept, so an
// unbracketed round trip can also draw a concurrent keepalive onto a client that
// permits one operation at a time.
//
// docs/spec/CHANNEL_SECURITY.md states which round trips are excluded, and prose
// asserting a code fact rots silently: the exclusion set has been wrong before
// (rename()'s re-issue existence probe was issued a layer above the bracket).
// This is that claim as a check, and it is an INCLUSION check -- it fails on any
// request-issuing call site the bracket does not cover, whether or not anyone
// thought to list it. The two known exceptions are what it ALLOWS, each with its
// reason; an allowance that no longer matches a call site fails too, so the list
// cannot rot into a record of what used to be true.
//
// The adapter is parsed with the TypeScript compiler API rather than matched by
// regex: coverage here is a promise flowing through wrapper calls, callbacks and
// executors, which no pattern over text can follow.
//
// Limits, stated rather than implied. The analysis is syntactic and is not a
// proof in either direction; what follows is where it can be wrong, and which
// way.
//
// It can call a site bracketed that is not. Inside a covered promise's executor,
// a call is marked bracketed when one of its argument functions MENTIONS a
// settler binding, not when the settlement is shown to lie on the path that
// answers. A best-effort close written as `sftp.close(handle, (err) => { if
// (err) reject(err); })` and fired after the operation has already settled would
// therefore read as bracketed and never reach the allowance list. The mention
// test is deliberate: it is what carries coverage through listOnce's
// opendir/readdir callback chain and createExclusiveOnce's open ->
// code-4-exists -> close handshake, which a reachability test would reclassify.
//
// It can miss a site altogether, because being a site is itself decided
// syntactically: a call that decision does not reach is never examined at all,
// so it is never reported. A site is a call whose callee is written
// as a property access, `receiver.member(...)` with optional chaining included;
// whose member is not one of the session-lifecycle and EventEmitter names listed
// below; and whose receiver is `this.client`, or an identifier bearing a name
// bound anywhere in this file to the raw SFTPWrapper (destructured off the
// internals cast or off a local resolving to a receiver, or declared as a
// parameter of the wrapper's type), or an identifier declared in an enclosing
// block -- plainly or by destructuring -- whose initializer leads through a
// chain of such declarations back to either.
//
// That is the whole reach, and the reach is the claim: a callee or a receiver
// written some other way is not decided here. No enumeration of those other
// forms is kept, deliberately. A list of what an analysis cannot see is a second
// claim about the analysis that nothing checks, and a wrong entry in it reads as
// a guarantee -- take the rules above as exhaustive instead, and anything they
// do not name as unseen.
//
// Where the reach errs it errs toward over-reporting: the wrapper name match is
// file-wide rather than scoped, so an unrelated binding that happens to share a
// wrapper's name is reported as a site too. That direction costs a spurious
// failure to be answered, never a miss.
//
// Failing CLOSED is a property of the coverage propagation and not of the site
// rules above. A site the propagation cannot reach is reported unbracketed, so a
// new promise-plumbing idiom shows up as a failure to be answered (by extending
// the rules here, or by bracketing the site) rather than passing unseen; a call
// the site rules do not reach has no such backstop and simply passes. An
// allowance matches by enclosing method and callee name, so a SECOND unbracketed
// call to the same method in the same method is admitted by the same reason --
// that is the class the reason names, not an unexamined site.

const ADAPTER = "apps/cli/src/connection/ssh2SftpAdapter.ts";
const SELF = "scripts/sftp-tracked-round-trips.test.mjs";

// Members of the ssh2-sftp-client / raw SFTPWrapper surface that are not server
// round trips: session lifecycle and the EventEmitter surface. Everything else
// reached on those objects counts as request-issuing, so a method this file has
// never seen is treated as a round trip rather than ignored.
const NON_REQUEST_MEMBERS = new Set([
  "connect",
  "end",
  "on",
  "once",
  "off",
  "addListener",
  "removeListener",
  "emit",
  "destroy",
]);

// The round trips deliberately issued outside the bracket, matched by the method
// they are issued from and the callee they issue. Each reason states why the
// count must not include it.
const ALLOWED_OUTSIDE_THE_BRACKET = [
  {
    enclosingMethod: "sendKeepalive",
    callee: "realPath",
    reason:
      "the heartbeat's own keepalive: it owns its in-flight state and only " +
      "beats when no tracked operation is running, and counting it would let " +
      "a beat hold an idle boundary the beat itself exists to make safe",
  },
  {
    enclosingMethod: "listOnce",
    callee: "close",
    reason:
      "a listing's best-effort handle close, fired once the listing has " +
      "already settled: the listing accounts for its loss (a withheld close " +
      "leaks the handle until session teardown), and awaiting it would " +
      "restore the unbounded wait the listing's deadline exists to defeat",
  },
];

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/** Parse a TypeScript source file with parent pointers, for ancestor walks. */
export function parseSource(fileName, text) {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

/** Every descendant of `node`, in source order. */
function descendants(node) {
  const found = [];
  const visit = (child) => {
    found.push(child);
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

/** Strip the wrappers that carry a value through unchanged. */
function unwrap(node) {
  let current = node;
  for (;;) {
    if (
      current &&
      (ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isAwaitExpression(current) ||
        ts.isTypeAssertionExpression(current))
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function isFunctionLike(node) {
  return node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

/** The nearest enclosing named method or function declaration, for reporting. */
function enclosingMethodName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      (ts.isMethodDeclaration(current) ||
        ts.isFunctionDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current)) &&
      current.name
    )
      return current.name.getText();
    if (ts.isConstructorDeclaration(current)) return "constructor";
  }
  return "<top level>";
}

/** Return statements belonging to `fn` itself, not to a nested function. */
function ownReturnStatements(fn) {
  const returns = [];
  const visit = (node) => {
    if (isFunctionLike(node) || ts.isFunctionDeclaration(node)) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return returns;
}

/** Identifier names bound anywhere inside `node`. */
function identifierNamesIn(node) {
  const names = new Set();
  for (const child of descendants(node))
    if (ts.isIdentifier(child)) names.add(child.text);
  return names;
}

/**
 * The variable declaration binding `name` in the nearest enclosing scope of
 * `from`, or undefined. A scope here is any ancestor carrying statements, which
 * is enough for this file's `const` plumbing.
 */
function declarationOf(name, from) {
  for (let current = from.parent; current; current = current.parent) {
    const statements = ts.isSourceFile(current)
      ? current.statements
      : ts.isBlock(current)
        ? current.statements
        : undefined;
    if (!statements) continue;
    for (const statement of statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name)
          return declaration;
        if (ts.isObjectBindingPattern(declaration.name)) {
          for (const element of declaration.name.elements)
            if (ts.isIdentifier(element.name) && element.name.text === name)
              return declaration;
        }
      }
    }
  }
  return undefined;
}

/** The `this.client` property: the client every high-level operation runs on. */
function isTheClient(node) {
  const target = unwrap(node);
  return (
    !!target &&
    ts.isPropertyAccessExpression(target) &&
    target.expression.kind === ts.SyntaxKind.ThisKeyword &&
    target.name.text === "client"
  );
}

/**
 * Whether `identifier` is bound to something requests are issued on: a raw
 * SFTPWrapper binding, `this.client`, or a local initialized from either,
 * followed through a chain of such locals (`const client = this.client`). Only
 * a wrapper name and a declaration initializer are followed; the header states
 * that reach.
 */
function bindsARequestReceiver(identifier, wrappers = new Set()) {
  const seen = new Set();
  for (let current = identifier; ;) {
    if (wrappers.has(current.text)) return true;
    const declaration = declarationOf(current.text, current);
    if (!declaration || !declaration.initializer || seen.has(declaration))
      return false;
    seen.add(declaration);
    const initializer = unwrap(declaration.initializer);
    if (isTheClient(initializer)) return true;
    if (!ts.isIdentifier(initializer)) return false;
    current = initializer;
  }
}

/**
 * Identifiers bound to the raw ssh2 SFTPWrapper: the `const { sftp } = ...`
 * idiom over the internals cast or over a local holding it, and a parameter
 * declared as the wrapper's type. Calls on these are server round trips exactly
 * as calls on the high-level client are.
 */
export function wrapperBindings(sourceFile) {
  const names = new Set();
  for (const node of descendants(sourceFile)) {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isObjectBindingPattern(node.name) &&
      (node.initializer.getText().includes("Ssh2SftpClientInternals") ||
        (ts.isIdentifier(unwrap(node.initializer)) &&
          bindsARequestReceiver(unwrap(node.initializer))))
    ) {
      for (const element of node.name.elements)
        if (ts.isIdentifier(element.name)) names.add(element.name.text);
    }
    if (
      ts.isParameter(node) &&
      node.type &&
      node.type.getText().includes('Ssh2SftpClientInternals["sftp"]') &&
      ts.isIdentifier(node.name)
    )
      names.add(node.name.text);
  }
  return names;
}

/**
 * The call expressions the site rules reach: a property-access call on
 * `this.client`, on a raw SFTPWrapper binding, or on a local aliasing either,
 * whose member is not session lifecycle or EventEmitter plumbing. A callee
 * written any other way is not a site; see the header.
 */
export function requestIssuingSites(sourceFile) {
  const wrappers = wrapperBindings(sourceFile);
  const sites = [];
  for (const node of descendants(sourceFile)) {
    if (!ts.isCallExpression(node)) continue;
    const callee = unwrap(node.expression);
    if (!ts.isPropertyAccessExpression(callee)) continue;
    const receiver = unwrap(callee.expression);
    const onClient = isTheClient(receiver);
    const onWrapper =
      ts.isIdentifier(receiver) && bindsARequestReceiver(receiver, wrappers);
    if (!onClient && !onWrapper) continue;
    const member = callee.name.text;
    if (NON_REQUEST_MEMBERS.has(member)) continue;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    sites.push({
      node,
      callee: `${onClient ? "this.client" : receiver.text}.${member}`,
      member,
      line: line + 1,
      enclosingMethod: enclosingMethodName(node),
    });
  }
  return sites;
}

/**
 * The set of nodes the tracked() bracket covers, computed by marking each
 * `this.tracked(...)` argument and propagating along the ways this adapter
 * carries a pending promise. A site is covered only where the propagation
 * reaches it, save the settler-mention rule below; see the header.
 */
export function trackedCoverage(sourceFile) {
  const covered = new Set();
  const queue = [];
  // Names bound alongside a covered promise by one destructuring -- the
  // settlement handshake `const { source, result, complete, fail } = ...`, where
  // the request is issued as a statement and settles the covered promise through
  // those callbacks rather than by being returned.
  const settlementBindings = new Set();
  let seeds = 0;

  const mark = (node) => {
    if (!node) return;
    const target = unwrap(node);
    if (!target || covered.has(target)) return;
    covered.add(target);
    queue.push(target);
  };

  // A request issued inside a covered promise's executor, one of whose argument
  // functions names a settler, is taken to be inside the bracket: the promise
  // stays pending until it answers. Naming is the whole test -- what that admits
  // is in the header.
  const markSettlingCallsIn = (executor) => {
    const settlers = new Set(
      executor.parameters
        .filter((parameter) => ts.isIdentifier(parameter.name))
        .map((parameter) => parameter.name.text),
    );
    if (settlers.size === 0) return;
    for (const node of descendants(executor)) {
      if (!ts.isCallExpression(node)) continue;
      const settlesIt = node.arguments.some((argument) => {
        const value = unwrap(argument);
        if (!isFunctionLike(value)) return false;
        for (const name of identifierNamesIn(value))
          if (settlers.has(name)) return true;
        return false;
      });
      if (settlesIt) mark(node);
    }
  };

  for (const node of descendants(sourceFile)) {
    if (!ts.isCallExpression(node)) continue;
    const callee = unwrap(node.expression);
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.expression.kind === ts.SyntaxKind.ThisKeyword &&
      callee.name.text === "tracked"
    ) {
      seeds += 1;
      mark(node.arguments[0]);
    }
  }

  const drain = () => {
    while (queue.length > 0) {
      const node = queue.pop();
      if (ts.isIdentifier(node)) {
        const declaration = declarationOf(node.text, node);
        if (declaration) {
          mark(declaration.initializer);
          if (ts.isObjectBindingPattern(declaration.name))
            for (const element of declaration.name.elements)
              if (ts.isIdentifier(element.name))
                settlementBindings.add(element.name.text);
        }
        continue;
      }
      if (isFunctionLike(node)) {
        if (ts.isBlock(node.body))
          for (const statement of ownReturnStatements(node))
            mark(statement.expression);
        else mark(node.body);
        continue;
      }
      if (ts.isNewExpression(node)) {
        const executor = node.arguments && unwrap(node.arguments[0]);
        if (isFunctionLike(executor)) {
          mark(executor);
          markSettlingCallsIn(executor);
        }
        continue;
      }
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        if (
          ts.isPropertyAccessExpression(callee) &&
          ["then", "catch", "finally"].includes(callee.name.text)
        )
          mark(callee.expression);
        // The promise-wrapping convention: warnIfSlow, boundByDeadline,
        // countedOperationRetry, withSftpOperationDeadline and the settlement
        // handlers all take what they wrap first.
        if (node.arguments.length > 0) mark(node.arguments[0]);
        continue;
      }
    }
  };

  // A settlement binding discovered in one round can cover a call issued in
  // another, so alternate the two until neither adds anything.
  for (;;) {
    drain();
    const before = covered.size;
    for (const node of descendants(sourceFile)) {
      if (!ts.isCallExpression(node) || covered.has(node)) continue;
      const callee = unwrap(node.expression);
      if (
        !ts.isPropertyAccessExpression(callee) ||
        !["then", "catch"].includes(callee.name.text)
      )
        continue;
      const settlesCovered = node.arguments.some((argument) => {
        const value = unwrap(argument);
        return ts.isIdentifier(value) && settlementBindings.has(value.text);
      });
      if (settlesCovered) mark(node);
    }
    if (covered.size === before && queue.length === 0) break;
  }

  return { covered, seeds };
}

const sourceFile = parseSource(
  ADAPTER,
  readFileSync(resolve(root, ADAPTER), "utf8"),
);
const sites = requestIssuingSites(sourceFile);
const { covered, seeds } = trackedCoverage(sourceFile);
const outsideTheBracket = sites.filter((site) => !covered.has(site.node));
const allowanceFor = (site) =>
  ALLOWED_OUTSIDE_THE_BRACKET.find(
    (allowance) =>
      allowance.enclosingMethod === site.enclosingMethod &&
      allowance.callee === site.member,
  );
const describeSite = (site) =>
  `${ADAPTER}:${site.line} ${site.callee}() in ${site.enclosingMethod}()`;

describe("SFTP adapter round trips are bracketed by tracked()", () => {
  it("finds the adapter's request sites and its tracked() brackets", () => {
    // A rot guard: an adapter refactor that renames the bracket, or moves the
    // client behind another property, would otherwise empty one of these and
    // make every assertion below vacuous.
    expect(seeds).toBeGreaterThan(0);
    expect(sites.length).toBeGreaterThan(0);
  });

  it("brackets every request-issuing call site, save the named exceptions", () => {
    const unexplained = outsideTheBracket
      .filter((site) => allowanceFor(site) === undefined)
      .map(describeSite);
    expect(
      unexplained,
      `${unexplained.length} SFTP round trip(s) are issued outside the ` +
        `tracked() bracket and are not named exceptions, so an idle-boundary ` +
        `release can tear them off the wire and the heartbeat can post a ` +
        `keepalive alongside them. Route each through the bracket (the ` +
        `private *Once layer of the matching operation), or add it to ` +
        `ALLOWED_OUTSIDE_THE_BRACKET in ${SELF} with the reason it must not ` +
        `be counted, and update the enumeration in ` +
        `docs/spec/CHANNEL_SECURITY.md.`,
    ).toEqual([]);
  });

  it("keeps no allowance that has stopped matching a call site", () => {
    const stale = ALLOWED_OUTSIDE_THE_BRACKET.filter(
      (allowance) =>
        !outsideTheBracket.some((site) => allowanceFor(site) === allowance),
    ).map(
      (allowance) =>
        `${allowance.enclosingMethod}() -> ${allowance.callee}(), allowed ` +
        `because ${allowance.reason}`,
    );
    expect(
      stale,
      `an allowance in ${SELF} names a round trip that is no longer issued ` +
        "outside the bracket (or no longer issued at all). Delete it, so the " +
        "list stays what the adapter does rather than what it once did.",
    ).toEqual([]);
  });

  it("follows a promise into an executor held in a local, not only a nested call", () => {
    // createExclusiveOnce is the shape that forces it: its SFTPv3 code-4
    // existence fallback is issued inside an executor assigned to `attempt`,
    // which only reaches this.tracked() further down the method. Reading that
    // site as unbracketed would be wrong, and would invite a bracket around an
    // operation the outer bound already covers.
    const fallback = sites.find(
      (site) =>
        site.enclosingMethod === "createExclusiveOnce" &&
        site.member === "exists",
    );
    expect(fallback).toBeDefined();
    expect(covered.has(fallback.node)).toBe(true);
  });

  it("finds a round trip issued on a local aliasing the client or the wrapper", () => {
    // The adapter issues every round trip on `this.client` or on a `{ sftp }`
    // destructured from the internals cast, so nothing above exercises the alias
    // rule and a regression in it would fail no assertion here. Pinned against a
    // source of its own instead: without the rule these two sites are simply not
    // seen, and an uncounted round trip written this way passes the check.
    const aliasing = parseSource(
      "aliasing.ts",
      `class A {
         private issue(path: string) {
           const client = this.client;
           const relayed = client;
           void relayed.stat(path);
           const internals = this.client as unknown as Ssh2SftpClientInternals;
           const { sftp } = internals;
           sftp.readdir(path, () => {});
         }
       }`,
    );
    expect(requestIssuingSites(aliasing).map((site) => site.callee)).toEqual([
      "relayed.stat",
      "sftp.readdir",
    ]);
  });
});
