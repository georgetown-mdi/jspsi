import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  descendants,
  parseFile,
  parseSource,
  readSource,
  sourceModules,
} from "./typeScriptSources.mjs";

// Every check that reads source through this module is only as good as the tree
// it walks, and a tree missing what it was asked about fails silent: the check
// finds nothing to report and passes a file it never read. What is pinned here
// is the tree -- the JSX a .tsx source keeps, the parent pointers an ancestor
// walk needs, the descendants a walk reaches -- and that a repository-relative
// path names the file this checkout ships.

/** A seat in the app's idiom: two calls, both written inside JSX. */
const SEAT = `export function Seat({ error }: SeatProps) {
  const alert = <Alert message={describe(error)}>{retry(error)}</Alert>;
  return <section>{alert}</section>;
}`;

/** The name each call in a parsed source is written on, in source order. */
function calledNames(sourceFile) {
  return descendants(sourceFile)
    .filter((node) => ts.isCallExpression(node))
    .map((node) => node.expression.getText());
}

describe("parsing a TypeScript source", () => {
  it("keeps the calls inside JSX for a .tsx file name", () => {
    expect(calledNames(parseSource("seat.tsx", SEAT))).toEqual([
      "describe",
      "retry",
    ]);
  });

  it("loses them for the same text under a .ts file name", () => {
    // Why the extension decides the script kind and no caller does: the
    // plain-TypeScript parse of a JSX element leaves nothing in the tree for a
    // walk to find, so a check over it reports a clean file rather than a shape
    // it could not read. There is no fail-closed direction to fall back on.
    expect(calledNames(parseSource("seat.ts", SEAT))).toEqual([]);
  });

  it("sets the parent pointers an ancestor walk needs", () => {
    const sourceFile = parseSource("ancestors.ts", "const a = f(1);");
    const call = descendants(sourceFile).find((node) =>
      ts.isCallExpression(node),
    );
    let outermost = call;
    while (outermost.parent) outermost = outermost.parent;
    expect(outermost).toBe(sourceFile);
    // getText() walks to the source file through those pointers, so it answers
    // only for a tree that holds them.
    expect(call.getText()).toBe("f(1)");
  });
});

describe("walking a parsed source", () => {
  it("reaches every node beneath it, in source order", () => {
    const sourceFile = parseSource("walk.ts", "const a = f(g(1));");
    expect(
      descendants(sourceFile)
        .filter((node) => ts.isIdentifier(node))
        .map((node) => node.text),
    ).toEqual(["a", "f", "g"]);
    const starts = descendants(sourceFile).map((node) => node.getStart());
    expect(starts).toEqual([...starts].sort((left, right) => left - right));
  });
});

describe("reading a repository-relative source", () => {
  const SELF = "scripts/lib/typeScriptSources.mjs";

  it("parses the file this checkout ships, under the path it was given", () => {
    const sourceFile = parseFile(SELF);
    expect(sourceFile.fileName).toBe(SELF);
    expect(sourceFile.getText()).toBe(readSource(SELF));
  });

  it("lists a tree's TypeScript sources, nested ones included", () => {
    const dir = "apps/web/src/routes/api/jobs";
    const modules = sourceModules(dir);
    expect(modules.length).toBeGreaterThan(0);
    expect(modules).toEqual([...modules].sort());
    expect(modules.filter((file) => !file.startsWith(`${dir}/`))).toEqual([]);
    expect(
      modules.some((file) => file.slice(dir.length + 1).includes("/")),
    ).toBe(true);
  });

  it("lists nothing for a tree that holds no TypeScript", () => {
    // test_data ships the practice CSVs and nothing else, so an entry here
    // would be the extension filter having stopped filtering.
    expect(sourceModules("test_data")).toEqual([]);
  });
});
