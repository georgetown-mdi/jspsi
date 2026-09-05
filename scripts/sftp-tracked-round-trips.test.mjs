import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  allowanceFor,
  declarationOf,
  describeSite,
  isFunctionLike,
  parseAdapter,
  requestIssuingSites,
  unwrap,
} from "./lib/sftpAdapterSites.mjs";
import { descendants } from "./lib/typeScriptSources.mjs";

// Every server round trip the SFTP adapter issues must pass through its
// tracked() bracket, which is where the heartbeat's in-flight state is kept: an
// unbracketed round trip can draw a concurrent keepalive onto a client that
// permits one operation at a time, and it leaves the idle window un-reset on real
// traffic.
//
// What this check is NOT. The outstanding-operation count -- the idle-boundary
// release's precondition -- is opened one layer up, by runOperation, and spans an
// operation from issue to final settlement; every tracked() bracket in the
// adapter is one ATTEMPT inside such a span. This analysis checks bracket
// coverage and nothing about the span above it: the inclusion check over that
// span is the sibling file, scripts/sftp-operation-spans.test.mjs.
//
// docs/spec/CHANNEL_SECURITY.md states which round trips are excluded, and prose
// asserting a code fact rots silently: the exclusion set has been wrong before
// (rename()'s re-issue existence probe was issued a layer above the bracket).
// This is that claim as a check, and it is an INCLUSION check -- it fails on any
// request-issuing call site the bracket does not cover, whether or not anyone
// thought to list it. The known exceptions below are what it ALLOWS, each with
// its reason; an allowance that no longer matches a call site fails too, so the list
// cannot rot into a record of what used to be true.
//
// What counts as a request-issuing call site, and the reach of that decision, is
// scripts/lib/sftpAdapterSites.mjs -- shared with the span check so the two
// cannot come to cover different sets.
//
// Limits, stated rather than implied. The coverage propagation below is
// syntactic and is not a proof in either direction; what follows is where it can
// be wrong, and which way.
//
// It can call a site bracketed that is not. Inside a covered promise's executor,
// a call is marked bracketed when one of its argument functions MENTIONS a
// settler binding, not when the settlement is shown to lie on the path that
// answers. A best-effort close written as `sftp.close(handle, (err) => { if
// (err) reject(err); })` and fired after the operation has already settled would
// therefore read as bracketed and never reach the allowance list. The mention
// test is by design: it is what propagates coverage through listOnce's
// opendir/readdir callback chain and createExclusiveOnce's open ->
// code-4-exists -> close handshake, which a reachability test would reclassify.
//
// Failing CLOSED is a property of the coverage propagation and not of the site
// rules. A site the propagation cannot reach is reported unbracketed, so a
// new promise-plumbing idiom shows up as a failure to be answered (by extending
// the rules here, or by bracketing the site) rather than passing unseen; a call
// the site rules do not reach has no such safety check and simply passes.

const SELF = "scripts/sftp-tracked-round-trips.test.mjs";

// The round trips issued outside the bracket by design, matched by the method
// they are issued from and the callee they issue. Each reason states why the
// bracket must not cover it.
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
  {
    enclosingMethod: "reissueCleanupDelete",
    callee: "delete",
    reason:
      "the drain's re-issue of a recorded cleanup delete, the one UNSETTLED " +
      "round trip an idle release MAY tear: it is issued from the drain rather " +
      "than from an operation, so no outstanding span covers it either. The " +
      "tear rejects it, which records the path again for the next " +
      "re-establishment, so the release defers the work rather than losing it " +
      "-- while counting it would let a server that accepts DELETE and " +
      "withholds its callback hold every boundary and so revert " +
      "connection-per-poll to a held session. The bracket's own duty does not " +
      "reach it either: the record and the drain exist only in " +
      "connection-per-poll mode, which arms no heartbeat, so there is no " +
      "keepalive to draw alongside it",
  },
];

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
 * The set of nodes the tracked() bracket covers, computed by marking each
 * `this.tracked(...)` argument and propagating along the ways this adapter
 * passes a pending promise. A site is covered only where the propagation
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

const sourceFile = parseAdapter();
const sites = requestIssuingSites(sourceFile);
const { covered, seeds } = trackedCoverage(sourceFile);
const outsideTheBracket = sites.filter((site) => !covered.has(site.node));

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
      .filter(
        (site) => allowanceFor(ALLOWED_OUTSIDE_THE_BRACKET, site) === undefined,
      )
      .map(describeSite);
    expect(
      unexplained,
      `${unexplained.length} SFTP round trip(s) are issued outside the ` +
        `tracked() bracket and are not named exceptions, so the heartbeat can ` +
        `post a keepalive alongside them on a client that permits one ` +
        `operation at a time. Route each through the bracket (the private ` +
        `*Once layer of the matching operation, which runOperation's ` +
        `outstanding span encloses), or add it to ` +
        `ALLOWED_OUTSIDE_THE_BRACKET in ${SELF} with the reason it must not ` +
        `be bracketed, and update the enumeration in ` +
        `docs/spec/CHANNEL_SECURITY.md.`,
    ).toEqual([]);
  });

  it("keeps no allowance that has stopped matching a call site", () => {
    const stale = ALLOWED_OUTSIDE_THE_BRACKET.filter(
      (allowance) =>
        !outsideTheBracket.some(
          (site) =>
            allowanceFor(ALLOWED_OUTSIDE_THE_BRACKET, site) === allowance,
        ),
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
});
