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

function some(node: ts.Node, predicate: (n: ts.Node) => boolean): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (predicate(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

// An `await x.get(...)` / `await x.list(...)` / `await x.createExclusive(...)`.
// Requiring the await is what distinguishes a transport read from an unrelated
// synchronous `.get(` (e.g. a Map lookup), which is never awaited.
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

// A catch "accounts for" UsageError if it either rethrows (any `throw`, which
// propagates the caught error or a derived one) or names UsageError (an
// `instanceof UsageError` branch, the terminal-handling shape poll() uses). A
// catch that does neither swallows whatever it caught -- including a UsageError --
// and falls through to retry, which is the violation.
function catchAccountsForUsageError(clause: ts.CatchClause): boolean {
  return some(
    clause.block,
    (n) =>
      ts.isThrowStatement(n) || (ts.isIdentifier(n) && n.text === "UsageError"),
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
        some(node.tryBlock, isAwaitedTransportRead) &&
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
    // rethrowing, so the catch names UsageError but has no throw.
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
});
