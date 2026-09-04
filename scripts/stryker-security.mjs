#!/usr/bin/env node
// Mutation-testing leg over the core security-bearing files: `npm run
// test:mutation`, and nightly through .github/workflows/nightly_mutation.yaml.
//
// It runs Stryker over the files listed in packages/core/stryker.config.mjs,
// then fails when any one of them scores below the floor committed beside it
// there. A per-file gate rather than Stryker's own `thresholds.break`, which is
// whole-run: a file whose tests were gutted can be offset by the others, and
// the score this leg exists to defend is each security-bearing file's own.
//
// Mutation score, per file, is the mutation-testing report definition:
// (killed + timeout) / (killed + timeout + survived + no coverage). Mutants
// Stryker could not run -- compile errors, runtime errors, ignored -- are
// outside both sides of the ratio.
//
// Stryker is NOT a repository dependency. It is installed on demand into a
// private prefix under the work directory (below), never into the repository's
// node_modules, because it drags in a second copy of vitest and its own
// typescript; a devDependency here would put both in every contributor's and
// every CI job's install for a leg that runs nightly. The prefix is reused
// across runs when it already holds the pinned versions.
//
// Two things the leg does need from the repository tree, so it must run against
// a provisioned checkout (`npm ci` plus the core build):
//   - vitest. Stryker's vitest runner resolves vitest through the working
//     directory's package.json, so this runs Stryker with the repository root as
//     its working directory and the runner picks up the pinned vitest there.
//   - typescript, whose version is read from the installed copy so the private
//     prefix gets the same one the repository resolves. Stryker's own
//     configuration step needs it at runtime, no checker plugin involved.
//
// What it cannot see:
//   - A mutant is only killed by a test that reaches the mutated source. These
//     files are exercised through packages/core's unit tier alone (the vitest
//     configuration at packages/core/vitest.stryker.config.ts): coverage that
//     lives in apps/cli's suites does not count here, and a file whose only
//     tests are there scores as uncovered.
//   - The score answers whether a test distinguishes the mutated behavior, not
//     whether the behavior is correct. A survivor whose only observable effect
//     is message text is a real survivor; it is not necessarily worth a test.
//   - The floors are compared per file, so a corpus file that stops being
//     mutated at all -- renamed, deleted, or dropped from the configuration --
//     is a hard failure here rather than a silently vacuous pass.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STRYKER_VERSION = "10.0.0";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(repoRoot, "packages", "core", "stryker.config.mjs");

// Everything the run writes lives outside the repository: the toolchain, the
// Stryker sandboxes and temp files, the derived configuration, and the reports.
// A report written under the repository root (Stryker's default is
// reports/mutation/) would leave an untracked directory in the working tree.
const workDir =
  process.env.PSILINK_STRYKER_WORK_DIR ??
  join(process.env.RUNNER_TEMP ?? tmpdir(), "psilink-stryker");
const toolchainDir = join(workDir, "toolchain");
const reportDir = join(workDir, "reports");
const jsonReportPath = join(reportDir, "mutation.json");
const htmlReportPath = join(reportDir, "mutation.html");
const derivedConfigPath = join(workDir, "stryker.derived.json");

function fail(message) {
  console.error(`stryker-security: ${message}`);
  process.exit(1);
}

function readPackageVersion(packageDir) {
  const manifest = join(packageDir, "package.json");
  if (!existsSync(manifest)) return undefined;
  return JSON.parse(readFileSync(manifest, "utf8")).version;
}

function installToolchain(typescriptVersion) {
  const wanted = {
    "@stryker-mutator/core": STRYKER_VERSION,
    "@stryker-mutator/vitest-runner": STRYKER_VERSION,
    typescript: typescriptVersion,
  };
  const satisfied = Object.entries(wanted).every(
    ([name, version]) =>
      readPackageVersion(
        join(toolchainDir, "node_modules", ...name.split("/")),
      ) === version,
  );
  if (satisfied) {
    console.log(`stryker-security: reusing the toolchain in ${toolchainDir}`);
    return;
  }
  mkdirSync(toolchainDir, { recursive: true });
  // A manifest of its own keeps npm from walking up out of the work directory
  // and treating this install as one against some enclosing project.
  writeFileSync(
    join(toolchainDir, "package.json"),
    `${JSON.stringify(
      { name: "psilink-stryker-toolchain", version: "0.0.0", private: true },
      undefined,
      2,
    )}\n`,
  );
  console.log(
    `stryker-security: installing the toolchain into ${toolchainDir}`,
  );
  try {
    execFileSync(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        // None of these packages builds anything at install time, and the leg has
        // no reason to run a lifecycle script from a tree the repository does not
        // otherwise depend on.
        "--ignore-scripts",
        ...Object.entries(wanted).map(
          ([name, version]) => `${name}@${version}`,
        ),
      ],
      { cwd: toolchainDir, stdio: "inherit" },
    );
  } catch (error) {
    fail(
      `installing the toolchain into ${toolchainDir} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The killed/timeout/survived/no-coverage tally and mutation-score ratio for
 * one file's mutants, the mutation-testing report definition: timeout counts
 * as killed (it is a mutant a test run distinguished, just slowly); no
 * coverage counts as survived (nothing reached it to distinguish it). Mutants
 * outside both -- compile error, runtime error, ignored -- are outside the
 * ratio entirely, which is why `denominator` can be zero.
 */
export function scoreOf(mutants) {
  const count = (status) =>
    mutants.filter((mutant) => mutant.status === status).length;
  const killed = count("Killed") + count("Timeout");
  const denominator = killed + count("Survived") + count("NoCoverage");
  return { killed, denominator, score: (killed / denominator) * 100 };
}

/**
 * The whole per-file gate: every file in `scoreFloors` checked against the
 * Stryker JSON report, with no I/O of its own. Returns the summary rows for
 * the report (one per file the score could be computed for, each already
 * holding its display verdict and any raised-floor suggestion) and the
 * failure messages -- a file missing from the report, a file whose mutants
 * all fell outside the ratio, and a file below its committed floor all add to
 * `failures` rather than a row, so `failures.length > 0` is the single signal
 * the entry point below exits non-zero on.
 */
export function evaluateFloors(report, scoreFloors) {
  const rows = [];
  const failures = [];
  for (const [file, floor] of Object.entries(scoreFloors)) {
    const mutants = report.files?.[file]?.mutants;
    if (mutants === undefined) {
      failures.push(
        `${file}: the report carries no mutants for this file. It is listed in packages/core/stryker.config.mjs, so either it was renamed or moved without the configuration following, or Stryker could not mutate it.`,
      );
      continue;
    }
    const { killed, denominator, score } = scoreOf(mutants);
    if (denominator === 0) {
      failures.push(
        `${file}: every mutant was excluded from the score (compile error, runtime error, or ignored), so the floor cannot be checked.`,
      );
      continue;
    }
    const belowFloor = score < floor;
    const raisedFloor = Math.floor(score);
    rows.push({
      file,
      floor,
      score,
      killed,
      denominator,
      verdict: belowFloor ? "BELOW FLOOR" : "ok",
      raisedFloorSuggestion: raisedFloor > floor ? raisedFloor : undefined,
    });
    if (belowFloor) {
      failures.push(
        `${file}: mutation score ${score.toFixed(2)}% is below its committed floor of ${floor}% (${killed} of ${denominator} mutants killed).`,
      );
    }
  }
  return { rows, failures };
}

async function runCheck() {
  const { default: strykerConfig, scoreFloors } = await import(
    pathToFileURL(configPath).href
  );

  const typescriptVersion = readPackageVersion(
    join(repoRoot, "node_modules", "typescript"),
  );
  if (typescriptVersion === undefined) {
    fail(
      "no typescript in node_modules -- run `npm ci` (and `npm run build -w packages/core`) before this leg",
    );
  }

  mkdirSync(reportDir, { recursive: true });
  installToolchain(typescriptVersion);

  writeFileSync(
    derivedConfigPath,
    `${JSON.stringify(
      {
        ...strykerConfig,
        // Absolute so the runner resolves the real configuration file rather than
        // a path relative to the sandbox vitest is rooted at.
        vitest: {
          ...strykerConfig.vitest,
          configFile: join(repoRoot, strykerConfig.vitest.configFile),
        },
        tempDirName: join(workDir, "tmp"),
        htmlReporter: { fileName: htmlReportPath },
        jsonReporter: { fileName: jsonReportPath },
      },
      undefined,
      2,
    )}\n`,
  );

  try {
    execFileSync(
      process.execPath,
      [
        join(
          toolchainDir,
          "node_modules",
          "@stryker-mutator",
          "core",
          "bin",
          "stryker.js",
        ),
        "run",
        derivedConfigPath,
      ],
      { cwd: repoRoot, stdio: "inherit" },
    );
  } catch (error) {
    fail(`Stryker exited with status ${error.status ?? "unknown"}`);
  }

  if (!existsSync(jsonReportPath)) {
    fail(`Stryker wrote no JSON report at ${jsonReportPath}`);
  }
  let report;
  try {
    report = JSON.parse(readFileSync(jsonReportPath, "utf8"));
  } catch (error) {
    fail(
      `could not read the JSON report at ${jsonReportPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const { rows, failures } = evaluateFloors(report, scoreFloors);

  console.log("\nMutation score against the committed floors:");
  for (const row of rows) {
    console.log(
      `  ${row.file}: ${row.score.toFixed(2)}% (floor ${row.floor}%, ${row.killed}/${row.denominator} killed) -- ${row.verdict}`,
    );
    if (row.raisedFloorSuggestion !== undefined) {
      console.log(
        `    the floor for this file can be raised to ${row.raisedFloorSuggestion}% in packages/core/stryker.config.mjs`,
      );
    }
  }
  console.log(
    `\nHTML report: ${htmlReportPath}\nJSON report: ${jsonReportPath}`,
  );

  if (failures.length > 0) {
    console.error("");
    for (const failure of failures)
      console.error(`stryker-security: ${failure}`);
    console.error(
      "\nA floor is raised when tests raise the score, never lowered to make this leg green: a drop means a test that used to distinguish the mutated behavior no longer does.",
    );
    process.exit(1);
  }
}

// Only when invoked directly, so the test imports the pure gating functions
// without installing the toolchain, running Stryker, or touching the network.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCheck();
}
