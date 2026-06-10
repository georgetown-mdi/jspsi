import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, test } from "vitest";

// Structural guard for the consumer-side terminal-on-UsageError invariant.
//
// The typed transport bounds -- FrameSizeExceededError, DirectoryListingBoundsError,
// and TransportOperationStalledError, all UsageError subclasses -- are terminal by
// design: a consumer that awaits a transport list()/get()/createExclusive() must
// propagate, never retry, a UsageError, because retrying loops straight back into
// the hang or over-allocation the bound exists to prevent (see
// docs/SECURITY_DESIGN.md, "Channel security"). readControlFileWithGate's catch
// rethrows it, poll()'s catch stops the poller on it; the invariant otherwise holds
// only by convention.
//
// This is the enforced backstop the convention lacked: it AST-scans the transport
// consumer's source so it fails not just on today's call sites but on a retry loop
// added LATER that catches a transport-call rejection and swallows a UsageError
// instead of propagating it. A behavioral test would only cover the paths it drives;
// scanning the source covers code that does not exist yet.
//
// It targets the UsageError BASE class, not each subclass: the poll loop and the
// gate key their terminal behavior off the base, so a future subclass added to the
// family is covered without touching this guard.

const TRANSPORT_READ_METHODS = new Set(["get", "list", "createExclusive"]);

const here = dirname(fileURLToPath(import.meta.url));
// The sole FileTransportClient consumer with transport-call retry loops. If a
// second such consumer is ever added, extend this list (and the architectural
// change that introduced it should re-justify the invariant for the new module).
const CONSUMER_SOURCE = join(
  here,
  "..",
  "src",
  "connection",
  "fileSyncConnection.ts",
);

interface Violation {
  line: number;
  text: string;
}

const FUNCTION_LIKE = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Constructor,
]);

// True when `match` holds for any node in `root`'s OWN scope. Descent stops at
// nested function bodies -- a throw or await buried in an arrow/callback belongs
// to that inner scope, not to `root`'s control flow -- and at any subtree `prune`
// rejects. This scoping is what keeps the catch checker from being fooled by a
// nested throw (a logging wrapper that internally throws is not a rethrow of the
// caught error) and the try scan from counting a read inside a defined-but-
// uncalled inner function.
function someInScope(
  root: ts.Node,
  match: (n: ts.Node) => boolean,
  prune?: (n: ts.Node) => boolean,
): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (match(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, (child) => {
      if (found || FUNCTION_LIKE.has(child.kind)) return;
      if (prune?.(child)) return;
      walk(child);
    });
  };
  walk(root);
  return found;
}

// An `await x.get(...)` / `await x.list(...)` / `await x.createExclusive(...)`.
// Requiring the await distinguishes a transport read from an unrelated
// synchronous `.get(` (e.g. a Map lookup), which is never awaited.
//
// Matched by method name on any receiver, deliberately. The guard scans only the
// transport consumer (fileSyncConnection.ts), where these names are always the
// transport client, and a backstop should err toward a false positive rather than
// a false negative: an unrelated `await someMap.get(k)` in a swallowing try would
// be flagged loudly and is trivially silenced by propagating UsageError, whereas a
// receiver-type filter risks a SILENT miss if the transport variable is ever
// renamed -- the worse failure for a guard whose whole job is to not miss a
// reintroduced swallow.
function isAwaitedTransportRead(node: ts.Node): boolean {
  if (!ts.isAwaitExpression(node)) return false;
  const call = node.expression;
  if (!ts.isCallExpression(call)) return false;
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    TRANSPORT_READ_METHODS.has(callee.name.text)
  );
}

// `err instanceof UsageError` -- the terminal-handling branch poll() uses (set a
// flag rather than rethrow). Matching the instanceof expression specifically,
// rather than any identifier named UsageError, excludes type positions such as
// `err as UsageError` or a `: UsageError` annotation that carry no runtime check.
function isUsageErrorInstanceofCheck(node: ts.Node): boolean {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    ts.isIdentifier(node.right) &&
    node.right.text === "UsageError"
  );
}

// A catch "accounts for" UsageError if, in its own scope, it either rethrows (any
// `throw`, which propagates the caught error or a derived one) or branches on
// `instanceof UsageError` (the shape poll() uses to stop terminally without
// rethrowing). A catch that does neither swallows whatever it caught -- including
// a UsageError -- and falls through to retry, which is the violation.
//
// The nested-try prune drops any `throw` buried inside an INNER try/catch/finally:
// such a throw may be absorbed by the inner catch (`try { throw err } catch {}`) or
// handle a different error, so it is not a guaranteed propagation of the error
// THIS catch received. A real rethrow sits in the catch's own flow, as both
// readControlFileWithGate and poll() do; requiring that (and erring toward
// flagging when propagation hides in a nested handler) keeps the guard from a
// silent false negative.
function catchAccountsForUsageError(clause: ts.CatchClause): boolean {
  return someInScope(
    clause.block,
    (n) => ts.isThrowStatement(n) || isUsageErrorInstanceofCheck(n),
    (n) => ts.isTryStatement(n),
  );
}

/**
 * Returns every catch clause in `source` that guards a try whose body awaits a
 * transport read yet neither rethrows nor branches on UsageError -- a retry site
 * that could swallow a terminal UsageError. Empty means the invariant holds.
 */
function findSwallowingTransportRetries(source: ts.SourceFile): Violation[] {
  const violations: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTryStatement(node) && node.catchClause) {
      if (
        someInScope(node.tryBlock, isAwaitedTransportRead) &&
        !catchAccountsForUsageError(node.catchClause)
      ) {
        const { line } = source.getLineAndCharacterOfPosition(
          node.catchClause.getStart(source),
        );
        violations.push({
          line: line + 1,
          text: node.catchClause.getText(source).split("\n")[0],
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile(
    "snippet.ts",
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
}

describe("terminal-on-UsageError guard", () => {
  test("no transport-call retry loop in the consumer swallows a UsageError", () => {
    const source = parse(readFileSync(CONSUMER_SOURCE, "utf-8"));
    const violations = findSwallowingTransportRetries(source);
    expect(
      violations,
      "A catch around an awaited transport list()/get()/createExclusive() must " +
        "propagate a UsageError (rethrow it, or branch on `instanceof UsageError`), " +
        "never swallow and retry it -- retrying loops back into the hang or " +
        "over-allocation the bound prevents. Offending catch clauses:\n" +
        violations.map((v) => `  line ${v.line}: ${v.text}`).join("\n"),
    ).toEqual([]);
  });

  // Self-tests: prove the checker FAILS on the swallow pattern and PASSES on the
  // sanctioned shapes, so the "catches a newly added site" guarantee is concrete
  // and the checker itself is regression-proof. Each "bad" case is what a future
  // reintroduction would look like.
  test("flags a retry loop that swallows a transport-read rejection", () => {
    const bad = `
      async function f(client: FileTransportClient) {
        do {
          let raw;
          try {
            raw = await client.get(p);
          } catch (err) {
            await delay();
            continue;
          }
          return raw;
        } while (Date.now() < deadline);
      }
    `;
    expect(findSwallowingTransportRetries(parse(bad))).toHaveLength(1);
  });

  test("flags a swallowed list() and a swallowed createExclusive()", () => {
    const badList = `
      async function f(c) {
        while (true) {
          try { return await c.list(p); } catch (e) { await delay(); }
        }
      }`;
    const badCreate = `
      async function f(c) {
        while (true) {
          try { await c.createExclusive(p); return; } catch (e) { await delay(); }
        }
      }`;
    expect(findSwallowingTransportRetries(parse(badList))).toHaveLength(1);
    expect(findSwallowingTransportRetries(parse(badCreate))).toHaveLength(1);
  });

  test("flags a swallow whose only throw is inside a nested function", () => {
    // The throw belongs to the inner arrow's scope, not the catch's control flow,
    // so it must not count as a rethrow of the caught transport error.
    const bad = `
      async function f(client) {
        do {
          try {
            return await client.get(p);
          } catch (err) {
            const wrap = () => { throw new Error("inner"); };
            await delay();
            continue;
          }
        } while (cond);
      }`;
    expect(findSwallowingTransportRetries(parse(bad))).toHaveLength(1);
  });

  test("flags a swallow whose only throw is inside an inner catch", () => {
    // The inner catch's throw handles the cleanup failure, not the transport error
    // the outer catch received, so the outer catch still swallows.
    const bad = `
      async function f(client) {
        do {
          try {
            return await client.get(p);
          } catch (err) {
            try { cleanup(); } catch (e) { throw e; }
            await delay();
            continue;
          }
        } while (cond);
      }`;
    expect(findSwallowingTransportRetries(parse(bad))).toHaveLength(1);
  });

  test("flags a swallow whose only throw is inside an inner try body", () => {
    // The throw is absorbed by the inner catch, not propagated out of the outer
    // catch, so the outer catch still swallows the transport error.
    const bad = `
      async function f(client) {
        do {
          try {
            return await client.get(p);
          } catch (err) {
            try { throw err; } catch (e) {}
            await delay();
            continue;
          }
        } while (cond);
      }`;
    expect(findSwallowingTransportRetries(parse(bad))).toHaveLength(1);
  });

  test("flags a swallow that names UsageError only in a type position", () => {
    // A type cast or annotation carries no runtime check, so it must not be read
    // as accounting for the error.
    const badCast = `
      async function f(client) {
        while (true) {
          try {
            return await client.list(p);
          } catch (err) {
            const e = err as UsageError;
            log(e);
            await delay();
          }
        }
      }`;
    const badAnnotation = `
      async function f(client) {
        while (true) {
          try {
            return await client.list(p);
          } catch (err) {
            const e: UsageError | undefined = undefined;
            log(e);
            await delay();
          }
        }
      }`;
    expect(findSwallowingTransportRetries(parse(badCast))).toHaveLength(1);
    expect(findSwallowingTransportRetries(parse(badAnnotation))).toHaveLength(
      1,
    );
  });

  test("passes a catch that rethrows UsageError and retries other errors", () => {
    const good = `
      async function f(client) {
        do {
          let raw;
          try {
            raw = await client.get(p);
          } catch (err) {
            if (err instanceof UsageError) throw err;
            await delay();
            continue;
          }
          return raw;
        } while (Date.now() < deadline);
      }`;
    expect(findSwallowingTransportRetries(parse(good))).toEqual([]);
  });

  test("passes a catch that unconditionally rethrows", () => {
    const good = `
      async function f(client) {
        try {
          return await client.list(p);
        } catch (err) {
          throw err instanceof Error ? err : new Error(String(err));
        }
      }`;
    expect(findSwallowingTransportRetries(parse(good))).toEqual([]);
  });

  test("passes a catch that branches on UsageError without rethrowing", () => {
    // poll()'s shape: terminal-on-UsageError handled by stopping rather than
    // rethrowing, so the catch branches on UsageError but has no throw.
    const good = `
      async function f(client) {
        try {
          await client.list(p);
          await client.get(q);
        } catch (err) {
          if (err instanceof UsageError) active = false;
          emit(err);
        }
      }`;
    expect(findSwallowingTransportRetries(parse(good))).toEqual([]);
  });

  test("ignores a retry loop whose try awaits no transport read", () => {
    // A swallow-and-retry around a write (put/rename) or a non-awaited Map.get is
    // outside the invariant; the guard must not flag it.
    const fine = `
      async function f(client, map) {
        while (true) {
          try {
            await client.put(src, dest);
            const cached = map.get(k);
          } catch (err) {
            await delay();
          }
        }
      }`;
    expect(findSwallowingTransportRetries(parse(fine))).toEqual([]);
  });

  test("ignores a transport read inside a defined-but-uncalled nested function", () => {
    // The awaited read lives in an inner arrow's scope, not the try's own control
    // flow, so the surrounding catch (which legitimately swallows a non-transport
    // error) must not be paired with it.
    const fine = `
      async function f(client) {
        while (true) {
          try {
            const helper = async () => { return await client.list(p); };
            await somethingElse();
          } catch (err) {
            await delay();
          }
        }
      }`;
    expect(findSwallowingTransportRetries(parse(fine))).toEqual([]);
  });
});
