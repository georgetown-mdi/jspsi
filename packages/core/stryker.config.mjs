// Stryker configuration for the mutation-testing leg over the core
// security-bearing files, run by scripts/stryker-security.mjs (`npm run
// test:mutation`) and nightly by .github/workflows/nightly_mutation.yaml.
//
// The runner reads BOTH exports: `scoreFloors` below is the corpus -- its keys
// are what gets mutated and each value is that file's committed floor -- and the
// default export is the Stryker configuration itself. Widening the corpus to a
// fourth file is one line in scoreFloors, whose floor is the score that file
// measures when it is added.
//
// Every path here is repository-root-relative: Stryker runs from the repository
// root so its vitest runner resolves vitest through the root package.json.

// Per-file mutation-score floors, in whole percent, measured on the commit that
// set them and rounded down. A floor is RAISED when tests are added that raise
// the score; it is never lowered to make a red leg green -- a drop is the
// finding the leg exists to report. Chasing the number itself is not the goal:
// the survivors these floors sit above are error-message text and private
// bookkeeping flags with no external observer, which a test can only pin by
// asserting the text.
export const scoreFloors = {
  "packages/core/src/auth.ts": 73,
  "packages/core/src/connection/abortMarker.ts": 57,
  "packages/core/src/connection/encryptedMessageConnection.ts": 89,
};

export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: {
    configFile: "packages/core/vitest.stryker.config.ts",
    // Stryker's default is to run only the tests vitest reports as related to a
    // mutated file, which it cannot resolve inside the sandbox copy ("Vitest
    // failed to find test files related to mutated files"). Running the whole
    // core suite, narrowed per mutant by the perTest coverage analysis below,
    // is what works.
    related: false,
  },
  mutate: Object.keys(scoreFloors),
  // Per-mutant test selection from the dry-run coverage, rather than the whole
  // suite per mutant.
  coverageAnalysis: "perTest",
  // The core suite runs in seconds; a mutant that reaches two minutes is a
  // hang, not a slow test.
  timeoutMS: 120000,
  timeoutFactor: 3,
  reporters: ["clear-text", "progress", "html", "json"],
  // No `thresholds.break`: Stryker's thresholds are whole-run, and the gate
  // here is per file. scripts/stryker-security.mjs enforces scoreFloors against
  // the JSON report instead.
};
