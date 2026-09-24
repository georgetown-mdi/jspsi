import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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

describe("the Stryker vitest configuration's test-name plugin", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const strykerVitestConfig = join(
    repoRoot,
    "packages",
    "core",
    "vitest.stryker.config.ts",
  );

  // Creates vitest through its Node API as Stryker's vitest runner does,
  // assigns the pattern to each project's config as the runner does before a
  // mutant run, and writes the titles of the tests that passed. Run with the
  // repository root as cwd so "vitest/node" resolves to the repository's copy.
  const runnerScript = `
    import { writeFileSync } from "node:fs";
    import { createVitest } from "vitest/node";
    const [root, configFile, pattern, outputFile] = process.argv.slice(1);
    const vitest = await createVitest("test", {
      root,
      config: configFile === "" ? false : configFile,
      watch: false,
      reporters: [],
    });
    for (const project of vitest.projects) {
      project.config.testNamePattern = new RegExp(pattern);
    }
    await vitest.start();
    const passed = [];
    const collect = (task) => {
      if (task.type === "test") {
        if (task.result?.state === "pass") passed.push(task.name);
      } else {
        (task.tasks ?? []).forEach(collect);
      }
    };
    vitest.state.getFiles().forEach(collect);
    await vitest.close();
    writeFileSync(outputFile, JSON.stringify(passed.sort()));
  `;

  // Runs a two-test fixture, one test nested in a describe and one at the top
  // level, under the given vitest config file ("" for none) and returns the
  // titles of the tests the pattern selected. The fixture sits where the
  // Stryker config's include glob, written repository-root-relative, finds it.
  function selectedTests(configFile, pattern) {
    const dir = mkdtempSync(join(tmpdir(), "stryker-name-pattern-"));
    try {
      const testDir = join(dir, "packages", "core", "test");
      mkdirSync(testDir, { recursive: true });
      writeFileSync(
        join(testDir, "fixture.test.js"),
        [
          'import { describe, test } from "vitest";',
          'describe("outer", () => {',
          '  test("nested case", () => {});',
          "});",
          'test("top case", () => {});',
          "",
        ].join("\n"),
      );
      const outputFile = join(dir, "result.json");
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          runnerScript,
          dir,
          configFile,
          pattern.source,
          outputFile,
        ],
        {
          cwd: repoRoot,
          stdio: ["ignore", "ignore", "pipe"],
          encoding: "utf8",
          timeout: 60_000,
          killSignal: "SIGKILL",
        },
      );
      if (child.error || child.status !== 0 || !existsSync(outputFile)) {
        throw new Error(
          `the vitest run exited with status ${child.status}, signal ${child.signal}${child.error ? `, error ${child.error.message}` : ""}; stderr:\n${child.stderr}`,
        );
      }
      return JSON.parse(readFileSync(outputFile, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // The pattern Stryker's runner assigns: its recorded names, space-joined.
  const strykerPattern = /outer nested case|top case/;

  it(
    "is needed: without it, the assigned pattern skips the nested test",
    { timeout: 90_000 },
    () => {
      expect(selectedTests("", strykerPattern)).toEqual(["top case"]);
    },
  );

  it(
    "widens the assigned pattern to select the nested and top-level tests",
    { timeout: 90_000 },
    () => {
      expect(selectedTests(strykerVitestConfig, strykerPattern)).toEqual([
        "nested case",
        "top case",
      ]);
    },
  );
});
