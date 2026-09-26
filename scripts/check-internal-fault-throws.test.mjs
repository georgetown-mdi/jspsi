import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  GUARDED_TREES,
  checkInternalFaultThrows,
  internalFaultPlainThrows,
} from "./check-internal-fault-throws.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, "check-internal-fault-throws.mjs");

function findings(text) {
  return internalFaultPlainThrows("fixture.ts", text);
}

describe("internalFaultPlainThrows over synthetic source", () => {
  it("finds a plain Error thrown in a never-typed switch branch", () => {
    const found = findings(
      [
        "function f(kind: 'a' | 'b'): number {",
        "  switch (kind) {",
        "    case 'a': return 1;",
        "    case 'b': return 2;",
        "    default: {",
        "      const unhandled: never = kind;",
        "      throw new Error(`unhandled ${String(unhandled)}`);",
        "    }",
        "  }",
        "}",
      ].join("\n"),
    );
    expect(found).toEqual([
      { file: "fixture.ts", line: 7, shape: "never-typed branch" },
    ]);
  });

  it("finds a plain Error thrown after a never binding in an if branch", () => {
    const found = findings(
      [
        "function f(c: { channel: 'x' }): void {",
        "  if (c.channel !== 'x') {",
        "    const unsupported: never = c;",
        "    throw new Error(",
        "      'unsupported ' + String(unsupported),",
        "    );",
        "  }",
        "}",
      ].join("\n"),
    );
    expect(found.map((site) => site.shape)).toEqual(["never-typed branch"]);
  });

  it("finds a plain Error in a branch after a never binding", () => {
    const found = findings(
      [
        "function f(kind: 'a'): void {",
        "  if (kind === 'a') return;",
        "  const unhandled: never = kind;",
        "  if (String(unhandled) !== '')",
        "    throw new Error('unhandled');",
        "}",
      ].join("\n"),
    );
    expect(found).toEqual([
      { file: "fixture.ts", line: 5, shape: "never-typed branch" },
    ]);
  });

  it("passes a plain Error in an earlier branch than an unrelated never binding", () => {
    const found = findings(
      [
        "function f(kind: 'a' | 'b', ready: boolean): number {",
        "  if (!ready) {",
        '    throw new Error("the server went away");',
        "  }",
        "  if (kind === 'a') return 1;",
        "  if (kind === 'b') return 2;",
        "  const unhandled: never = kind;",
        "  return unhandled;",
        "}",
      ].join("\n"),
    );
    expect(found).toEqual([]);
  });

  it("passes a plain Error ahead of a never binding in its own block", () => {
    const found = findings(
      [
        "function f(kind: 'a', ok: boolean): void {",
        "  switch (kind) {",
        "    default: {",
        '      if (!ok) throw new Error("not ready");',
        "      const unhandled: never = kind as never;",
        "      void unhandled;",
        "    }",
        "  }",
        "}",
      ].join("\n"),
    );
    expect(found).toEqual([]);
  });

  it("finds a plain Error whose message says internal error", () => {
    const found = findings(
      [
        "function f(v: string | undefined): string {",
        "  if (v === undefined)",
        "    throw new Error(",
        '      "internal error: the value was applied " +',
        '        "without having been read",',
        "    );",
        "  return v;",
        "}",
      ].join("\n"),
    );
    expect(found).toEqual([
      { file: "fixture.ts", line: 3, shape: '"internal error" text' },
    ]);
  });

  it("passes InternalConsistencyError in either shape", () => {
    expect(
      findings(
        [
          "function f(kind: 'a'): number {",
          "  if (kind === 'a') return 1;",
          "  const unhandled: never = kind;",
          "  throw new InternalConsistencyError(String(unhandled));",
          "}",
          "function g(): never {",
          '  throw new InternalConsistencyError("internal error: g");',
          "}",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("passes a plain Error in neither shape", () => {
    expect(
      findings(
        [
          "function f(kind: 'a'): void {",
          "  const unhandled: never = kind as never;",
          "  const inner = () => {",
          '    throw new Error("the server went away");',
          "  };",
          "  inner();",
          "}",
          'function g(): never { throw new Error("not connected"); }',
          '// throw new Error("internal error");',
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("checkInternalFaultThrows", () => {
  it("passes this repository's guarded trees", () => {
    const { ok, message } = checkInternalFaultThrows();
    expect(message).toMatch(/no internal-fault guard/);
    expect(ok).toBe(true);
  });

  it("reads both guarded trees and names each finding", () => {
    const sources = {
      "packages/core/src/a.ts":
        'export function a(): never { throw new Error("internal error: a"); }',
      "apps/cli/src/b.ts": "export const b = 1;",
    };
    const { ok, message } = checkInternalFaultThrows({
      list: (tree) => Object.keys(sources).filter((f) => f.startsWith(tree)),
      read: (file) => sources[file],
    });
    expect(ok).toBe(false);
    expect(message).toContain("packages/core/src/a.ts:1");
    expect(message).toContain("InternalConsistencyError");
  });
});

describe("the CLI entry", () => {
  let tree;
  afterEach(() => {
    if (tree) rmSync(tree, { recursive: true, force: true });
    tree = undefined;
  });

  function writeTree(files) {
    tree = mkdtempSync(join(tmpdir(), "internal-fault-throws-"));
    for (const dir of GUARDED_TREES)
      mkdirSync(join(tree, dir), { recursive: true });
    for (const [path, text] of Object.entries(files))
      writeFileSync(join(tree, path), text);
  }

  it("exits 1 on a finding under --root", () => {
    writeTree({
      "apps/cli/src/x.ts": [
        "export function x(k: 'a'): void {",
        "  if (k === 'a') return;",
        "  const u: never = k;",
        "  throw new Error(String(u));",
        "}",
      ].join("\n"),
    });
    let status = 0;
    let stderr = "";
    try {
      execFileSync("node", [SCRIPT, "--root", tree], { stdio: "pipe" });
    } catch (err) {
      status = err.status;
      stderr = err.stderr.toString();
    }
    expect(status).toBe(1);
    expect(stderr).toContain("apps/cli/src/x.ts:4 (never-typed branch)");
  });

  it("exits 0 on a clean tree under --root", () => {
    writeTree({ "packages/core/src/y.ts": "export const y = 1;" });
    const out = execFileSync("node", [SCRIPT, "--root", tree], {
      encoding: "utf8",
    });
    expect(out).toContain("passed");
  });
});
