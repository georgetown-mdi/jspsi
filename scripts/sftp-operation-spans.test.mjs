import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  allowanceFor,
  describeSite,
  parseAdapter,
  requestIssuingSites,
  unwrap,
} from "./lib/sftpAdapterSites.mjs";
import { descendants, parseSource } from "./lib/typeScriptSources.mjs";

// Every data-plane call the SFTP adapter issues to the server must enter through
// runOperation, which opens the one outstanding-operation span per operation --
// from issue to final settlement, recovery arm included. That count is the
// idle-boundary release's precondition: a release reads it, and a non-zero
// reading returns without closing. A round trip issued outside every span is a
// round trip a release cannot see, so a boundary can close the session out from
// under it.
//
// docs/spec/CHANNEL_SECURITY.md states which round trips are excluded, and prose
// asserting a code fact rots silently. This is that claim as a check, and it is
// an INCLUSION check -- it fails on any request-issuing call site no span
// encloses, whether or not anyone thought to list it, so an entry added later
// that forgets runOperation fails here rather than passing unnoticed. The known
// exceptions below are what it ALLOWS, each with its reason; an allowance that no
// longer matches a call site fails too, so the list cannot rot into a record of
// what used to be true.
//
// What counts as a request-issuing call site, and the reach of that decision, is
// scripts/lib/sftpAdapterSites.mjs -- shared with the per-attempt bracket check
// in scripts/sftp-tracked-round-trips.test.mjs so the two cannot come to cover
// different sets. The bracket is the layer BELOW this one: each tracked() bracket
// marks one attempt on the wire, and several of them can fall inside one span.
//
// Limits, stated rather than implied. The span propagation is syntactic and is
// not a proof in either direction; what follows is where it can be wrong, and
// which way.
//
// What it decides is LEXICAL enclosure, not enclosure in time. A call issued from
// inside a span's body that settles after the operation itself has settled has
// left the span without leaving the source, and reads here as inside it. A
// listing's best-effort handle close is exactly that shape -- allowed by name in
// the bracket check, and unremarkable to this one -- which is why the two
// allowance lists differ rather than being copies.
//
// Its interprocedural reach is per METHOD, not per call path: entering a method
// from one span marks every site in that method's body, whatever else calls it.
// So a second, unrouted caller of an already-routed private method is not
// detected here. What that leaves unverified is the direction the private *Once
// layer states -- that those methods are reachable ONLY through runOperation --
// which this analysis does not decide.
//
// Failing CLOSED is a property of that reach. A span extends through a call
// written `this.<method>(...)` that resolves to a method declared on the class
// declaring runOperation, and through nothing else: a body reached by a bound
// reference, by a property holding an arrow function, or from a base class is not
// followed, so its sites are reported outside every span. A new plumbing idiom
// therefore shows up as a failure to be answered (by extending the rules here, or
// by routing the site) rather than passing unseen.

const SELF = "scripts/sftp-operation-spans.test.mjs";

// The entry point whose call opens a span, and whose declaring class bounds the
// interprocedural reach above.
const OPERATION_ENTRY = "runOperation";

// The round trips issued outside every outstanding span by design, matched by
// the method they are issued from and the callee they issue. Each reason states
// why no span may cover it.
const ALLOWED_OUTSIDE_THE_SPAN = [
  {
    enclosingMethod: "sendKeepalive",
    callee: "realPath",
    reason:
      "the heartbeat's own keepalive, which is not an operation: counting it " +
      "would let a beat hold the very idle boundary the beat exists to make " +
      "safe, and the mode that reads this count arms no heartbeat at all",
  },
  {
    enclosingMethod: "reissueCleanupDelete",
    callee: "delete",
    reason:
      "the drain's re-issue of a recorded cleanup delete, the one UNSETTLED " +
      "round trip an idle release MAY tear: it is issued from the drain at the " +
      "tail of a re-establishment rather than from an operation. The tear " +
      "rejects it, which records the path again for the next " +
      "re-establishment, so the release defers the work rather than losing it " +
      "-- while counting it would let a server that accepts DELETE and " +
      "withholds its callback hold every boundary, reverting " +
      "connection-per-poll to a held session",
  },
];

/** Class declarations holding a `runOperation` method: the adapter's own. */
function classesDeclaringTheEntry(sourceFile) {
  return descendants(sourceFile).filter(
    (node) =>
      ts.isClassDeclaration(node) &&
      node.members.some(
        (member) =>
          ts.isMethodDeclaration(member) &&
          member.name &&
          member.name.getText() === OPERATION_ENTRY,
      ),
  );
}

/**
 * The function bodies an outstanding span encloses: each `runOperation` body
 * argument, plus the body of every method it reaches through a `this.<method>()`
 * call on the class declaring the entry point, transitively.
 */
export function operationSpanBodies(sourceFile) {
  const entryClasses = classesDeclaringTheEntry(sourceFile);
  const methods = new Map();
  for (const declaration of entryClasses)
    for (const member of declaration.members)
      if (ts.isMethodDeclaration(member) && member.name)
        methods.set(member.name.getText(), member);

  const bodies = new Set();
  const queue = [];
  let seeds = 0;

  const enter = (node) => {
    if (!node || bodies.has(node)) return;
    bodies.add(node);
    queue.push(node);
  };

  // The entry point is excluded from this reach: a nested runOperation is seeded
  // from its own body argument by the sweep below, and following it instead would
  // pull the recovery machinery it wraps -- the re-dial, the teardown -- into a
  // span that does not contain them.
  const thisCallsIn = (node) => {
    const found = [];
    for (const child of descendants(node)) {
      if (!ts.isCallExpression(child)) continue;
      const callee = unwrap(child.expression);
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.expression.kind === ts.SyntaxKind.ThisKeyword &&
        callee.name.text !== OPERATION_ENTRY
      )
        found.push(callee.name.text);
    }
    return found;
  };

  for (const node of descendants(sourceFile)) {
    if (!ts.isCallExpression(node)) continue;
    const callee = unwrap(node.expression);
    if (
      !ts.isPropertyAccessExpression(callee) ||
      callee.expression.kind !== ts.SyntaxKind.ThisKeyword ||
      callee.name.text !== OPERATION_ENTRY
    )
      continue;
    seeds += 1;
    enter(unwrap(node.arguments[node.arguments.length - 1]));
  }

  while (queue.length > 0) {
    const body = queue.pop();
    for (const name of thisCallsIn(body)) enter(methods.get(name));
  }

  return { bodies, seeds, entryClasses: entryClasses.length };
}

/** Whether `site` sits inside one of the span bodies, by lexical containment. */
export function insideAnOperationSpan(site, bodies) {
  for (let node = site.node; node; node = node.parent)
    if (bodies.has(node)) return true;
  return false;
}

const sourceFile = parseAdapter();
const sites = requestIssuingSites(sourceFile);
const { bodies, seeds, entryClasses } = operationSpanBodies(sourceFile);
const outsideTheSpan = sites.filter(
  (site) => !insideAnOperationSpan(site, bodies),
);

describe("SFTP adapter round trips run inside a runOperation span", () => {
  it("finds the adapter's request sites and its runOperation spans", () => {
    // A rot guard: an adapter refactor that renames the entry point, moves it
    // off the class, splits the adapter into two classes that both declare one,
    // or moves the client behind another property would otherwise empty one of
    // these and make every assertion below vacuous.
    expect(entryClasses).toBe(1);
    expect(seeds).toBeGreaterThan(0);
    expect(sites.length).toBeGreaterThan(0);
  });

  it("encloses every request-issuing call site, save the named exceptions", () => {
    const unexplained = outsideTheSpan
      .filter(
        (site) => allowanceFor(ALLOWED_OUTSIDE_THE_SPAN, site) === undefined,
      )
      .map(describeSite);
    expect(
      unexplained,
      `${unexplained.length} SFTP round trip(s) are issued outside every ` +
        `outstanding-operation span, so an idle-boundary release cannot see ` +
        `them and can close the session out from under one. Route each entry ` +
        `through ${OPERATION_ENTRY}(), or add it to ALLOWED_OUTSIDE_THE_SPAN ` +
        `in ${SELF} with the reason no span may cover it, and update the ` +
        `enumeration in docs/spec/CHANNEL_SECURITY.md.`,
    ).toEqual([]);
  });

  it("keeps no allowance that has stopped matching a call site", () => {
    const stale = ALLOWED_OUTSIDE_THE_SPAN.filter(
      (allowance) =>
        !outsideTheSpan.some(
          (site) => allowanceFor(ALLOWED_OUTSIDE_THE_SPAN, site) === allowance,
        ),
    ).map(
      (allowance) =>
        `${allowance.enclosingMethod}() -> ${allowance.callee}(), allowed ` +
        `because ${allowance.reason}`,
    );
    expect(
      stale,
      `an allowance in ${SELF} names a round trip that is no longer issued ` +
        "outside every span (or no longer issued at all). Delete it, so the " +
        "list stays what the adapter does rather than what it once did.",
    ).toEqual([]);
  });

  it("propagates a span through the private single-attempt layer beneath it", () => {
    // The adapter's own shape, pinned so a propagation regression fails here
    // rather than emptying the check: no data-plane entry issues its round trip
    // directly, every one of them delegating to a private *Once method that
    // runOperation's body calls.
    const delegated = sites.find(
      (site) =>
        site.enclosingMethod === "renameOnce" && site.member === "rename",
    );
    expect(delegated).toBeDefined();
    expect(insideAnOperationSpan(delegated, bodies)).toBe(true);
  });

  it("reports an entry that issues its round trip without opening a span", () => {
    // The defect this check exists for, pinned against a source of its own: an
    // entry added later in the adapter's own idiom -- a public method over a
    // private single-attempt body -- but reaching the client without the entry
    // point above it. Its round trip must land outside every span while the
    // routed one beside it stays inside, so the failure is the missing span
    // rather than the analysis losing both.
    const added = parseSource(
      "added-entry.ts",
      `class A {
         private runOperation<T>(spec: unknown, body: () => Promise<T>) {
           return body();
         }
         routed(path: string): Promise<void> {
           return this.runOperation({ recovery: "verbatim" }, () =>
             this.routedOnce(path),
           );
         }
         private routedOnce(path: string): Promise<void> {
           return this.client.delete(path);
         }
         unrouted(path: string): Promise<void> {
           return this.unroutedOnce(path);
         }
         private unroutedOnce(path: string): Promise<void> {
           return this.client.rename(path, path);
         }
       }`,
    );
    const addedBodies = operationSpanBodies(added).bodies;
    const classified = requestIssuingSites(added).map(
      (site) =>
        `${site.enclosingMethod}/${site.member}: ` +
        (insideAnOperationSpan(site, addedBodies) ? "inside" : "outside"),
    );
    expect(classified).toEqual([
      "routedOnce/delete: inside",
      "unroutedOnce/rename: outside",
    ]);
  });
});
