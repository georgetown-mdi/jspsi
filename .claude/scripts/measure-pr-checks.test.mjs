import { describe, expect, it } from "vitest";
import {
  buildReport,
  criticalPath,
  criticalPathForSha,
  DEFAULT_RUN_SAMPLE,
  earliest,
  formatSeconds,
  latest,
  median,
  parseArgs,
  percentile,
  renderReport,
  requiredContextsFromRules,
  secondsBetween,
  summarizeJobs,
  summarizeSteps,
  summarizeReruns,
  summarizeWorkflows,
} from "./measure-pr-checks.mjs";

/** A job as the normalized sample carries it. Minutes in, ISO timestamps out. */
function job(name, { queued, started, ran, conclusion = "success" }) {
  const startedAt = new Date(Date.parse(queued) + started * 1000).toISOString();
  return {
    name,
    createdAt: queued,
    startedAt,
    completedAt: new Date(Date.parse(startedAt) + ran * 1000).toISOString(),
    status: "completed",
    conclusion,
  };
}

function attempt(workflowName, headSha, createdAt, jobs, extra = {}) {
  return {
    runId: 1,
    workflowName,
    headSha,
    headBranch: "topic",
    attempt: 1,
    superseded: false,
    runCreatedAt: createdAt,
    runStartedAt: createdAt,
    conclusion: "success",
    jobs,
    ...extra,
  };
}

function check(name, completedAt, appSlug = "github-actions") {
  return {
    name,
    appSlug,
    startedAt: completedAt,
    completedAt,
    conclusion: "success",
  };
}

// Two head shas plus a third whose Static Checks run was rerun. The gating set
// holds one context no Actions job produces ("Code scanning"), which is the
// shape that makes a job-only critical path wrong.
const RULES = [
  { type: "deletion" },
  {
    type: "required_status_checks",
    parameters: {
      required_status_checks: [
        { context: "Typecheck, Lint, Format", integration_id: 15368 },
        { context: "Code scanning", integration_id: 57789 },
      ],
    },
  },
];

const SAMPLE = {
  repo: "owner/repo",
  base: "staging",
  fetchedAt: "2026-09-02T20:00:00Z",
  rules: RULES,
  shas: [
    {
      sha: "aaa",
      pullRequest: 10,
      runs: [
        attempt("Static Checks", "sha", "2026-09-01T10:00:00Z", [
          job("Typecheck, Lint, Format", {
            queued: "2026-09-01T10:00:00Z",
            started: 10,
            ran: 240,
          }),
        ]),
        attempt("Heavy Suite", "sha", "2026-09-01T10:00:00Z", [
          job("Test", {
            queued: "2026-09-01T10:00:00Z",
            started: 20,
            ran: 600,
          }),
          job("Optional leg", {
            queued: "2026-09-01T10:00:00Z",
            started: 0,
            ran: 0,
            conclusion: "skipped",
          }),
        ]),
      ],
      checkRuns: [
        check("Typecheck, Lint, Format", "2026-09-01T10:04:10Z"),
        check(
          "Code scanning",
          "2026-09-01T10:02:00Z",
          "github-advanced-security",
        ),
        check("Test", "2026-09-01T10:10:20Z"),
      ],
    },
    {
      sha: "bbb",
      pullRequest: 11,
      runs: [
        attempt("Static Checks", "bbb", "2026-09-02T10:00:00Z", [
          job("Typecheck, Lint, Format", {
            queued: "2026-09-02T10:00:00Z",
            started: 20,
            ran: 300,
          }),
        ]),
      ],
      checkRuns: [
        check("Typecheck, Lint, Format", "2026-09-02T10:05:20Z"),
        check(
          "Code scanning",
          "2026-09-02T10:09:00Z",
          "github-advanced-security",
        ),
      ],
    },
    {
      sha: "ccc",
      pullRequest: 12,
      runs: [
        attempt(
          "Static Checks",
          "ccc",
          "2026-09-02T11:00:00Z",
          [
            job("Typecheck, Lint, Format", {
              queued: "2026-09-02T11:00:00Z",
              started: 0,
              ran: 120,
            }),
          ],
          { superseded: true, conclusion: "failure" },
        ),
        attempt("Static Checks", "ccc", "2026-09-02T11:00:00Z", [
          job("Typecheck, Lint, Format", {
            queued: "2026-09-02T11:10:00Z",
            started: 0,
            ran: 180,
          }),
        ]),
      ],
      checkRuns: [
        check("Typecheck, Lint, Format", "2026-09-02T11:13:00Z"),
        check(
          "Code scanning",
          "2026-09-02T11:02:00Z",
          "github-advanced-security",
        ),
      ],
    },
  ],
};

describe("parseArgs", () => {
  it("treats an empty command line as a usage request", () => {
    const parsed = parseArgs([]);
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toMatch(/^Usage: node measure-pr-checks\.mjs/);
  });

  it("defaults the sample size and the base branch", () => {
    expect(parseArgs(["--json"])).toEqual({
      ok: true,
      runs: DEFAULT_RUN_SAMPLE,
      base: "staging",
      repo: null,
      asJson: true,
      cacheDir: null,
      offline: false,
    });
  });

  it("reads the sample size from the positional, in any position", () => {
    expect(parseArgs(["50"])).toMatchObject({ ok: true, runs: 50 });
    expect(parseArgs(["--json", "50", "--base", "main"])).toMatchObject({
      ok: true,
      runs: 50,
      base: "main",
      asJson: true,
    });
  });

  it("rejects a non-positive or non-integer sample size", () => {
    for (const bad of ["0", "-5", "12.5", "many"]) {
      expect(parseArgs([bad]).ok).toBe(false);
    }
  });

  it("rejects a value flag with no value, including one swallowed by a flag", () => {
    expect(parseArgs(["--base"]).message).toBe(
      "error: --base requires a value\n",
    );
    expect(parseArgs(["--cache", "--json"]).message).toBe(
      "error: --cache requires a value\n",
    );
  });

  it("rejects an unknown flag and a second positional with the usage string", () => {
    expect(parseArgs(["--bogus"]).message).toMatch(/^Usage:/);
    expect(parseArgs(["10", "20"]).message).toMatch(/^Usage:/);
  });

  it("refuses --offline without both a cache to read and a repo to name", () => {
    expect(parseArgs(["--offline"]).message).toMatch(/--offline needs --cache/);
    expect(parseArgs(["--offline", "--cache", "/tmp/c"]).message).toMatch(
      /--offline needs --cache/,
    );
    expect(
      parseArgs(["--offline", "--cache", "/tmp/c", "--repo", "o/r"]),
    ).toMatchObject({ ok: true, offline: true });
  });
});

describe("requiredContextsFromRules", () => {
  it("reads every required context out of the ruleset, sorted", () => {
    expect(requiredContextsFromRules(RULES)).toEqual([
      { context: "Code scanning", integrationId: 57789 },
      { context: "Typecheck, Lint, Format", integrationId: 15368 },
    ]);
  });

  it("returns nothing for a branch whose ruleset requires no status check", () => {
    expect(requiredContextsFromRules([{ type: "deletion" }])).toEqual([]);
    expect(requiredContextsFromRules(null)).toEqual([]);
    expect(
      requiredContextsFromRules([
        { type: "required_status_checks", parameters: {} },
      ]),
    ).toEqual([]);
  });
});

describe("time helpers", () => {
  it("measures whole seconds and clamps a negative interval to zero", () => {
    expect(secondsBetween("2026-09-01T10:00:00Z", "2026-09-01T10:04:10Z")).toBe(
      250,
    );
    expect(secondsBetween("2026-09-01T10:04:10Z", "2026-09-01T10:00:00Z")).toBe(
      0,
    );
    expect(secondsBetween(null, "2026-09-01T10:00:00Z")).toBeNull();
    expect(secondsBetween("2026-09-01T10:00:00Z", "not a date")).toBeNull();
  });

  it("finds the bounds of a list holding nulls", () => {
    const times = [null, "2026-09-01T10:05:00Z", "2026-09-01T10:01:00Z"];
    expect(earliest(times)).toBe("2026-09-01T10:01:00Z");
    expect(latest(times)).toBe("2026-09-01T10:05:00Z");
    expect(earliest([null])).toBeNull();
    expect(latest([])).toBeNull();
  });

  it("computes a median and a nearest-rank percentile", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([10], 0.9)).toBe(10);
    expect(percentile([], 0.9)).toBeNull();
  });

  it("formats seconds as minutes and zero-padded seconds", () => {
    expect(formatSeconds(0)).toBe("0s");
    expect(formatSeconds(59)).toBe("59s");
    expect(formatSeconds(65)).toBe("1m 05s");
    expect(formatSeconds(600)).toBe("10m 00s");
    expect(formatSeconds(null)).toBe("-");
  });
});

describe("summarizeJobs", () => {
  const rows = summarizeJobs(
    SAMPLE.shas.flatMap((s) => s.runs),
    new Set(["Typecheck, Lint, Format"]),
  );

  it("ranks jobs by median wall clock and marks the gating ones", () => {
    expect(rows.map((row) => `${row.workflow} / ${row.job}`)).toEqual([
      "Heavy Suite / Test",
      "Static Checks / Typecheck, Lint, Format",
    ]);
    expect(rows[0].gating).toBe(false);
    expect(rows[1].gating).toBe(true);
  });

  it("aggregates every attempt of a job, reruns included", () => {
    const staticChecks = rows[1];
    expect(staticChecks.n).toBe(4);
    expect(staticChecks.wall.medianSeconds).toBe(210);
    expect(staticChecks.wall.maxSeconds).toBe(300);
    expect(staticChecks.queue.medianSeconds).toBe(5);
  });

  it("leaves a skipped job out rather than counting it as instant work", () => {
    expect(rows.some((row) => row.job === "Optional leg")).toBe(false);
  });
});

describe("summarizeWorkflows", () => {
  const rows = summarizeWorkflows(
    SAMPLE.shas.flatMap((s) => s.runs),
    new Set(["Typecheck, Lint, Format"]),
  );

  it("measures a run end to end rather than summing its parallel legs", () => {
    const heavy = rows.find((row) => row.workflow === "Heavy Suite");
    expect(heavy.n).toBe(1);
    expect(heavy.queue.medianSeconds).toBe(20);
    expect(heavy.wall.medianSeconds).toBe(600);
    expect(heavy.total.medianSeconds).toBe(620);
    expect(heavy.gating).toBe(false);
  });

  it("marks a workflow gating when any of its jobs is a required context", () => {
    expect(rows.find((row) => row.workflow === "Static Checks").gating).toBe(
      true,
    );
  });
});

describe("criticalPath", () => {
  const requiredSet = new Set(["Typecheck, Lint, Format", "Code scanning"]);

  it("measures one sha from its earliest run creation to the last required check", () => {
    expect(criticalPathForSha(SAMPLE.shas[0], requiredSet)).toEqual({
      sha: "aaa",
      pullRequest: 10,
      startedAt: "2026-09-01T10:00:00Z",
      holder: "Typecheck, Lint, Format",
      completedAt: "2026-09-01T10:04:10Z",
      seconds: 250,
    });
  });

  it("counts a required context no Actions job produces", () => {
    const row = criticalPathForSha(SAMPLE.shas[1], requiredSet);
    expect(row.holder).toBe("Code scanning");
    expect(row.seconds).toBe(540);
  });

  it("ignores a non-required check that finished later", () => {
    const gated = criticalPathForSha(SAMPLE.shas[0], requiredSet);
    const everything = criticalPathForSha(SAMPLE.shas[0], null);
    expect(everything.holder).toBe("Test");
    expect(everything.seconds).toBe(620);
    expect(gated.seconds).toBeLessThan(everything.seconds);
  });

  it("tallies which check held the path, and its median and p90", () => {
    const path = criticalPath(SAMPLE.shas, requiredSet);
    expect(path.n).toBe(3);
    expect(path.medianSeconds).toBe(540);
    expect(path.maxSeconds).toBe(780);
    expect(path.holders).toEqual([
      { name: "Typecheck, Lint, Format", count: 2 },
      { name: "Code scanning", count: 1 },
    ]);
    expect(path.perSha[0].sha).toBe("ccc");
  });

  it("drops a sha whose checks are all still running", () => {
    const pending = {
      sha: "ddd",
      pullRequest: 13,
      runs: [attempt("Static Checks", "ddd", "2026-09-02T12:00:00Z", [])],
      checkRuns: [
        { name: "Typecheck, Lint, Format", startedAt: null, completedAt: null },
      ],
    };
    expect(criticalPathForSha(pending, requiredSet)).toBeNull();
    expect(criticalPath([pending], requiredSet).n).toBe(0);
  });
});

describe("summarizeReruns", () => {
  it("charges the superseded attempts the wall clock the medians hide", () => {
    const reruns = summarizeReruns(SAMPLE.shas.flatMap((s) => s.runs));
    expect(reruns).toEqual({
      rerunAttempts: 1,
      shasWithReruns: 1,
      addedSeconds: 120,
      byWorkflow: [{ workflow: "Static Checks", attempts: 1, seconds: 120 }],
    });
  });
});

describe("summarizeSteps", () => {
  function step(name, seconds, base, conclusion = "success") {
    return {
      name,
      startedAt: base,
      completedAt: new Date(Date.parse(base) + seconds * 1000).toISOString(),
      conclusion,
    };
  }

  const base = "2026-09-01T10:00:00Z";
  const attempts = [
    attempt("Static Checks", "aaa", base, [
      {
        name: "Typecheck, Lint, Format",
        createdAt: base,
        startedAt: base,
        completedAt: base,
        status: "completed",
        conclusion: "success",
        steps: [
          step("Setup", 55, base),
          step("Typecheck", 30, base),
          step("Lint", 25, base),
          step("A check that did not run", 0, base, "skipped"),
        ],
      },
      {
        name: "Quick",
        createdAt: base,
        startedAt: base,
        completedAt: base,
        status: "completed",
        conclusion: "success",
        steps: [step("Setup", 5, base)],
      },
    ]),
  ];

  it("breaks a long job into its steps, longest first", () => {
    const rows = summarizeSteps(attempts);
    expect(rows).toHaveLength(1);
    expect(rows[0].job).toBe("Static Checks / Typecheck, Lint, Format");
    expect(rows[0].medianTotalSeconds).toBe(110);
    expect(rows[0].steps.map((row) => row.step)).toEqual([
      "Setup",
      "Typecheck",
      "Lint",
    ]);
    expect(rows[0].steps[0].medianSeconds).toBe(55);
  });

  it("leaves out a job whose steps do not reach the threshold", () => {
    expect(
      summarizeSteps(attempts).some((row) => row.job.endsWith("Quick")),
    ).toBe(false);
    expect(summarizeSteps(attempts, 5).map((row) => row.job)).toContain(
      "Static Checks / Quick",
    );
  });

  it("returns nothing when the sample carries no step timings", () => {
    expect(summarizeSteps(SAMPLE.shas.flatMap((s) => s.runs))).toEqual([]);
  });
});

describe("buildReport", () => {
  const report = buildReport(SAMPLE);

  it("reports the sample's extent and date range", () => {
    expect(report.sample).toEqual({
      runAttempts: 5,
      headShas: 3,
      pullRequests: 3,
      from: "2026-09-01T10:00:00Z",
      to: "2026-09-02T11:00:00Z",
    });
  });

  it("says of each required context whether an Actions job produces it", () => {
    expect(report.required).toEqual([
      {
        context: "Code scanning",
        integrationId: 57789,
        observedAsCheck: true,
        observedAsJob: false,
      },
      {
        context: "Typecheck, Lint, Format",
        integrationId: 15368,
        observedAsCheck: true,
        observedAsJob: true,
      },
    ]);
  });

  it("separates the gating critical path from the one every check imposes", () => {
    expect(report.criticalPath.required.medianSeconds).toBe(540);
    expect(report.criticalPath.allChecks.medianSeconds).toBe(620);
  });

  it("renders without losing the gating column or the rerun line", () => {
    const text = renderReport(report);
    expect(text).toContain("owner/repo -- pull-request checks against staging");
    expect(text).toContain("app-posted check, no Actions job of this name");
    expect(text).toContain("Heavy Suite / Test");
    expect(text).toContain("1 superseded attempts across 1 shas");
    expect(text.endsWith("\n")).toBe(true);
  });
});
