// A skipped leg is coverage the run does not have. Vitest's default reporter
// counts skips ("2 passed | 3 skipped") but names none of them, so a leg that
// starts skipping -- a prerequisite that stopped being available, a condition
// that inverted -- displays as green and nobody can tell which suite went quiet.
// This reporter names every one at the end of a run: project, file, test, and
// the reason where a runtime `ctx.skip(reason)` supplied one.
//
// It is registered in the ROOT `test` block of each workspace's vitest config,
// which is the whole run's config rather than one project's, so a project added
// later is covered without touching it -- and in the repository root's config
// too, because a reporter belongs to the config that STARTS a run and is dropped
// from a workspace config reached through the root's `projects`, unlike a
// globalSetup, which survives that reach. Reporting is all it does: which skips
// are legitimate is a per-suite question (the CLI's SFTP matrix legs skip the
// backends they are not running), so failing on one belongs with whatever
// declares the prerequisite, not here.
//
// It can only name a skip vitest was told about, so a test body that returns
// early instead reports PASSED and reaches nothing here.
// `scripts/platform-gate-skips.test.mjs` is what keeps a platform gate from
// being written that way.

/** Named tests past this cap are summarized as a count. */
export const DEFAULT_NAME_LIMIT = 40;

/**
 * The skipped tests of a run, grouped by test module, in the order the reporter
 * received them. `test.todo` is left out: it is an explicit placeholder vitest
 * already reports under its own heading, not a leg that quietly stopped running.
 */
export function summarizeSkippedLegs(testModules) {
  const files = [];
  let total = 0;
  for (const testModule of testModules) {
    const tests = [];
    for (const test of testModule.children.allTests()) {
      if (test.result().state !== "skipped") continue;
      if (test.options?.mode === "todo") continue;
      tests.push({ name: test.fullName, note: test.result().note ?? null });
    }
    if (tests.length === 0) continue;
    total += tests.length;
    files.push({
      project: testModule.project.name,
      path: testModule.relativeModuleId ?? testModule.moduleId,
      tests,
    });
  }
  return { total, files };
}

/**
 * The report block for a {@link summarizeSkippedLegs} result, or `null` when the
 * run skipped nothing.
 */
export function formatSkippedLegs(summary, nameLimit = DEFAULT_NAME_LIMIT) {
  if (summary.total === 0) return null;
  const lines = [
    `Skipped legs: ${summary.total} test${summary.total === 1 ? "" : "s"} ` +
      `in ${summary.files.length} file${summary.files.length === 1 ? "" : "s"} ` +
      `did not run. Coverage the run reports is smaller than the suite's.`,
  ];
  let named = 0;
  for (const file of summary.files) {
    const label = file.project ? `[${file.project}] ${file.path}` : file.path;
    lines.push(`  ${label} (${file.tests.length})`);
    for (const test of file.tests) {
      if (named >= nameLimit) break;
      named += 1;
      lines.push(`    - ${test.name}${test.note ? `: ${test.note}` : ""}`);
    }
  }
  if (summary.total > named) {
    lines.push(`    ... and ${summary.total - named} more`);
  }
  return lines.join("\n");
}

/** The vitest reporter. Registered alongside `default`, never in place of it. */
export default class SkippedLegReporter {
  onTestRunEnd(testModules) {
    const report = formatSkippedLegs(summarizeSkippedLegs(testModules));
    if (report !== null) console.log(`\n${report}\n`);
  }
}
