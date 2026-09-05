import { describe, expect, test, vi } from "vitest";

import SkippedLegReporter, {
  formatSkippedLegs,
  summarizeSkippedLegs,
} from "./skippedLegReporter.mjs";

// The shapes below mirror what vitest hands a reporter's onTestRunEnd: a test
// module exposing its project, its repo-relative id, and children.allTests(),
// each test holding options.mode and a result() whose state is "skipped" for a
// skipIf, a test.skip, a skipped suite, and a runtime ctx.skip (the last keeping
// mode "run" and putting its reason in result().note). Driven from a real run in
// this repo, not from the vitest type declarations.

function testStub(fullName, { state = "passed", mode = "run", note } = {}) {
  return { fullName, options: { mode }, result: () => ({ state, note }) };
}

function moduleStub(project, relativeModuleId, tests) {
  return {
    project: { name: project },
    relativeModuleId,
    children: { allTests: () => tests },
  };
}

const skipped = (fullName, note) =>
  testStub(fullName, { state: "skipped", mode: "skip", note });

describe("summarizeSkippedLegs", () => {
  test("a run with nothing skipped summarizes to nothing", () => {
    const summary = summarizeSkippedLegs([
      moduleStub("unit", "test/unit/a.test.ts", [testStub("a passes")]),
    ]);
    expect(summary).toEqual({ total: 0, files: [] });
    expect(formatSkippedLegs(summary)).toBeNull();
  });

  test("groups skipped tests by the file they sit in", () => {
    const summary = summarizeSkippedLegs([
      moduleStub("unit", "test/unit/a.test.ts", [
        testStub("a passes"),
        skipped("a > skipped one"),
        skipped("a > skipped two"),
      ]),
      moduleStub("integration", "test/integration/b.test.ts", [
        skipped("b > skipped"),
      ]),
    ]);
    expect(summary).toEqual({
      total: 3,
      files: [
        {
          project: "unit",
          path: "test/unit/a.test.ts",
          tests: [
            { name: "a > skipped one", note: null },
            { name: "a > skipped two", note: null },
          ],
        },
        {
          project: "integration",
          path: "test/integration/b.test.ts",
          tests: [{ name: "b > skipped", note: null }],
        },
      ],
    });
  });

  // A todo is a placeholder the author wrote down and vitest already reports
  // under its own heading, not a leg that stopped running.
  test("leaves test.todo out", () => {
    const summary = summarizeSkippedLegs([
      moduleStub("unit", "test/unit/a.test.ts", [
        testStub("a > todo", { state: "skipped", mode: "todo" }),
      ]),
    ]);
    expect(summary.total).toBe(0);
  });

  test("keeps the reason a runtime skip supplied", () => {
    const summary = summarizeSkippedLegs([
      moduleStub("unit", "test/unit/a.test.ts", [
        testStub("a > conditional", {
          state: "skipped",
          mode: "run",
          note: "no chroot here",
        }),
      ]),
    ]);
    expect(summary.files[0].tests).toEqual([
      { name: "a > conditional", note: "no chroot here" },
    ]);
  });
});

describe("formatSkippedLegs", () => {
  test("names the project, the file, and each test", () => {
    const report = formatSkippedLegs(
      summarizeSkippedLegs([
        moduleStub("unit", "test/unit/a.test.ts", [
          skipped("a > skipped one"),
          skipped("a > skipped two", "no openssl"),
        ]),
      ]),
    );
    expect(report).toContain("Skipped legs: 2 tests in 1 file did not run");
    expect(report).toContain("[unit] test/unit/a.test.ts (2)");
    expect(report).toContain("- a > skipped one");
    expect(report).toContain("- a > skipped two: no openssl");
  });

  // The SFTP matrix legs skip whole classes of file at once; the report has to
  // stay readable there without hiding how much did not run.
  test("caps the names and counts the rest", () => {
    const tests = Array.from({ length: 5 }, (_, i) => skipped(`a > case ${i}`));
    const report = formatSkippedLegs(
      summarizeSkippedLegs([moduleStub("unit", "test/unit/a.test.ts", tests)]),
      2,
    );
    expect(report).toContain("- a > case 0");
    expect(report).toContain("- a > case 1");
    expect(report).not.toContain("- a > case 2");
    expect(report).toContain("... and 3 more");
  });
});

describe("SkippedLegReporter", () => {
  test("reports at the end of a run that skipped something", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      new SkippedLegReporter().onTestRunEnd([
        moduleStub("unit", "test/unit/a.test.ts", [skipped("a > skipped")]),
      ]);
      expect(log).toHaveBeenCalledOnce();
      expect(log.mock.calls[0][0]).toContain("a > skipped");
    } finally {
      log.mockRestore();
    }
  });

  test("says nothing about a run that skipped nothing", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      new SkippedLegReporter().onTestRunEnd([
        moduleStub("unit", "test/unit/a.test.ts", [testStub("a passes")]),
      ]);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
