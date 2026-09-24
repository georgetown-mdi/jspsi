import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { widenTestNamePattern } from "../packages/core/vitest.stryker.config.ts";
import { evaluateFloors, scoreOf } from "./stryker-security.mjs";

// The scoreOf and evaluateFloors tests cover the pure gating decision only --
// the tally, the score ratio, the floor comparison, the missing-mutants and
// zero-denominator failure branches, and the raised-floor suggestion --
// against hand-built report fixtures shaped like the real Stryker JSON report
// this script reads at runtime (`files[<path>].mutants[].status`). They do
// NOT drive Stryker itself or the toolchain install; that live half is `npm
// run test:mutation`.

function mutants(statuses) {
  return statuses.map((status) => ({ status }));
}

describe("scoreOf", () => {
  it("counts timeout as killed and no coverage as survived", () => {
    const result = scoreOf(
      mutants([
        "Killed",
        "Killed",
        "Timeout",
        "Survived",
        "NoCoverage",
        // Outside the ratio entirely: not in the numerator, not in the
        // denominator.
        "CompileError",
        "Ignored",
      ]),
    );
    // killed + timeout = 3; denominator = 3 (killed/timeout) + 1 (survived) + 1
    // (no coverage) = 5; the compile error and ignored mutants count toward
    // neither side.
    expect(result).toEqual({ killed: 3, denominator: 5, score: 60 });
  });

  it("reports a zero denominator rather than dividing by it", () => {
    const result = scoreOf(mutants(["CompileError", "Ignored"]));
    expect(result.denominator).toBe(0);
    expect(Number.isNaN(result.score)).toBe(true);
  });
});

describe("evaluateFloors", () => {
  const FILE = "packages/core/src/example.ts";

  it("passes a file exactly at its floor", () => {
    const report = {
      files: {
        [FILE]: {
          mutants: mutants(["Killed", "Killed", "Survived", "Survived"]),
        },
      },
    };
    const { rows, failures } = evaluateFloors(report, { [FILE]: 50 });
    expect(failures).toEqual([]);
    expect(rows).toEqual([
      {
        file: FILE,
        floor: 50,
        score: 50,
        killed: 2,
        denominator: 4,
        verdict: "ok",
        raisedFloorSuggestion: undefined,
      },
    ]);
  });

  it("fails a file one point below its floor, naming the file and both numbers", () => {
    const report = {
      files: {
        [FILE]: {
          mutants: mutants([
            ...Array(49).fill("Killed"),
            ...Array(51).fill("Survived"),
          ]),
        },
      },
    };
    const { rows, failures } = evaluateFloors(report, { [FILE]: 50 });
    expect(rows).toEqual([
      {
        file: FILE,
        floor: 50,
        score: 49,
        killed: 49,
        denominator: 100,
        verdict: "BELOW FLOOR",
        raisedFloorSuggestion: undefined,
      },
    ]);
    expect(failures).toEqual([
      `${FILE}: mutation score 49.00% is below its committed floor of 50% (49 of 100 mutants killed).`,
    ]);
  });

  it("fails a file missing from the report", () => {
    const report = { files: {} };
    const { rows, failures } = evaluateFloors(report, { [FILE]: 50 });
    expect(rows).toEqual([]);
    expect(failures).toEqual([
      `${FILE}: the report carries no mutants for this file. It is listed in packages/core/stryker.config.mjs, so either it was renamed or moved without the configuration following, or Stryker could not mutate it.`,
    ]);
  });

  it("fails a file with zero mutants in the ratio", () => {
    const report = { files: { [FILE]: { mutants: [] } } };
    const { rows, failures } = evaluateFloors(report, { [FILE]: 50 });
    expect(rows).toEqual([]);
    expect(failures).toEqual([
      `${FILE}: every mutant was excluded from the score (compile error, runtime error, or ignored), so the floor cannot be checked.`,
    ]);
  });

  it("fails a file whose every mutant was excluded from the ratio", () => {
    const report = {
      files: { [FILE]: { mutants: mutants(["CompileError", "Ignored"]) } },
    };
    const { rows, failures } = evaluateFloors(report, { [FILE]: 50 });
    expect(rows).toEqual([]);
    expect(failures).toEqual([
      `${FILE}: every mutant was excluded from the score (compile error, runtime error, or ignored), so the floor cannot be checked.`,
    ]);
  });

  it("suggests a raised floor only when the floored score exceeds the current floor", () => {
    const scoring = (killedCount, total) =>
      mutants([
        ...Array(killedCount).fill("Killed"),
        ...Array(total - killedCount).fill("Survived"),
      ]);

    // 55.00% floors to 55, which exceeds the committed floor of 40.
    const above = evaluateFloors(
      { files: { [FILE]: { mutants: scoring(55, 100) } } },
      { [FILE]: 40 },
    );
    expect(above.rows[0].raisedFloorSuggestion).toBe(55);

    // 40.90% floors to 40, which does not exceed the committed floor of 40.
    const atFloor = evaluateFloors(
      { files: { [FILE]: { mutants: scoring(409, 1000) } } },
      { [FILE]: 40 },
    );
    expect(atFloor.rows[0].score).toBeCloseTo(40.9);
    expect(atFloor.rows[0].raisedFloorSuggestion).toBeUndefined();
  });

  it("evaluates every configured file independently", () => {
    const other = "packages/core/src/other.ts";
    const report = {
      files: {
        [FILE]: { mutants: mutants(["Killed", "Survived"]) },
        [other]: { mutants: mutants(["Killed", "Killed"]) },
      },
    };
    const { rows, failures } = evaluateFloors(report, {
      [FILE]: 90,
      [other]: 90,
    });
    expect(failures).toEqual([
      `${FILE}: mutation score 50.00% is below its committed floor of 90% (1 of 2 mutants killed).`,
    ]);
    expect(rows.map((row) => row.file)).toEqual([FILE, other]);
  });
});

describe("widenTestNamePattern", () => {
  const vitestBin = fileURLToPath(
    new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
  );

  // Runs the repository's vitest over a two-test fixture, one test nested in
  // a describe and one at the top level, and returns the titles of the tests
  // the name pattern selected.
  function selectedTests(pattern) {
    const dir = mkdtempSync(join(tmpdir(), "stryker-name-pattern-"));
    try {
      writeFileSync(
        join(dir, "fixture.test.js"),
        [
          'describe("outer", () => {',
          '  test("nested case", () => {});',
          "});",
          'test("top case", () => {});',
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "vitest.config.mjs"),
        "export default { test: { globals: true } };\n",
      );
      const outputFile = join(dir, "result.json");
      execFileSync(
        process.execPath,
        [
          vitestBin,
          "run",
          "--root",
          dir,
          "--reporter=json",
          `--outputFile=${outputFile}`,
          "--testNamePattern",
          pattern.source,
        ],
        { cwd: dir, stdio: "ignore" },
      );
      const result = JSON.parse(readFileSync(outputFile, "utf8"));
      return result.testResults
        .flatMap((file) => file.assertionResults)
        .filter((test) => test.status === "passed")
        .map((test) => test.title)
        .sort();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // The pattern Stryker's runner sends: its recorded names, space-joined.
  const strykerPattern = /outer nested case|top case/;

  it(
    "is needed: vitest does not match a space-joined name to a nested test",
    {
      timeout: 60_000,
    },
    () => {
      expect(selectedTests(strykerPattern)).toEqual(["top case"]);
    },
  );

  it(
    "selects the nested test and still selects the top-level one",
    {
      timeout: 60_000,
    },
    () => {
      expect(selectedTests(widenTestNamePattern(strykerPattern))).toEqual([
        "nested case",
        "top case",
      ]);
    },
  );
});
