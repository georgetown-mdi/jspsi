import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

import { reportBlocked, reportViolations } from "./deferredObligation.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const roots = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** The stderr of a call, with the real console left alone. */
function captured(call) {
  const lines = [];
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((line) => lines.push(line));
  try {
    return { result: call(), stderr: lines.join("\n") };
  } finally {
    spy.mockRestore();
  }
}

/**
 * A script reading its root through the module, printed rather than acted on,
 * driven as the command line runs it.
 */
function runWithArgs(...args) {
  const root = mkdtempSync(resolve(tmpdir(), "deferred-obligation-"));
  roots.push(root);
  const script = resolve(root, "check.mjs");
  writeFileSync(
    script,
    `import { obligationRoot } from "${resolve(here, "deferredObligation.mjs")}";
console.log(obligationRoot(process.argv.slice(2), "scripts/check.mjs"));
`,
  );
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [script, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (error) {
    return { status: error.status, stdout: error.stdout, stderr: error.stderr };
  }
}

describe("the tree a run reads", () => {
  it("is the one --root names", () => {
    const { status, stdout } = runWithArgs("--root", "/tmp");

    expect(status).toBe(0);
    expect(stdout.trim()).toBe(resolve("/tmp"));
  });

  it("is the repository when the arguments name none", () => {
    const { status, stdout } = runWithArgs();

    expect(status).toBe(0);
    expect(stdout.trim()).toBe(resolve(here, "../.."));
  });

  it("refuses a --root it was handed no value for, rather than reading the repository", () => {
    const { status, stderr } = runWithArgs("--root");

    expect(status).toBe(2);
    expect(stderr).toContain("usage: node scripts/check.mjs [--root <tree>]");
  });
});

describe("what a run reports", () => {
  it("says nothing and reports nothing to act on when there is nothing", () => {
    const blocked = captured(() => reportBlocked("A check", []));
    const violations = captured(() => reportViolations("A check", []));

    expect([blocked.result, violations.result]).toEqual([false, false]);
    expect(blocked.stderr + violations.stderr).toBe("");
  });

  it("names every reason a run could not be made", () => {
    const { result, stderr } = captured(() =>
      reportBlocked("A check", [
        "the marker is unreadable",
        "and so is the pin",
      ]),
    );

    expect(result).toBe(true);
    expect(stderr).toContain("A check could not run:");
    expect(stderr).toContain("  the marker is unreadable");
    expect(stderr).toContain("  and so is the pin");
  });

  it("names every way the tree stands elsewhere", () => {
    const { result, stderr } = captured(() =>
      reportViolations("A check", [
        { kind: "moved", message: "the literal moved" },
        { kind: "record", message: "and nothing recorded it" },
      ]),
    );

    expect(result).toBe(true);
    expect(stderr).toContain("A check failed:");
    expect(stderr).toContain("the literal moved");
    expect(stderr).toContain("and nothing recorded it");
  });
});
