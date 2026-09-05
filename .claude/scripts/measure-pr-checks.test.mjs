import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  buildReport,
  collectSample,
  criticalPath,
  criticalPathForSha,
  DEFAULT_RUN_SAMPLE,
  earliest,
  formatSeconds,
  latest,
  MAX_RUN_PAGES,
  median,
  parseArgs,
  percentile,
  renderReport,
  repoFromRemoteUrl,
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
    conclusion,
  };
}

function attempt(workflowName, headSha, createdAt, jobs, extra = {}) {
  return {
    runId: 1,
    workflowName,
    headSha,
    attempt: 1,
    superseded: false,
    runCreatedAt: createdAt,
    runStartedAt: createdAt,
    jobs,
    ...extra,
  };
}

function check(name, completedAt) {
  return {
    name,
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
  runsRequested: 5,
  runsSampled: 5,
  windowExhausted: false,
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
        check("Code scanning", "2026-09-01T10:02:00Z"),
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
        check("Code scanning", "2026-09-02T10:09:00Z"),
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
          { superseded: true },
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
        check("Code scanning", "2026-09-02T11:02:00Z"),
      ],
    },
  ],
};

describe("parseArgs", () => {
  it("treats an empty command line as a usage request", () => {
    const parsed = parseArgs([]);
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toMatch(/^Usage: npm run measure:pr-checks --/);
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
      runsRequested: 5,
      runsSampled: 5,
      windowExhausted: false,
      from: "2026-09-01T10:00:00Z",
      to: "2026-09-02T11:00:00Z",
    });
  });

  it("says on the sample line when the run listing ran out first", () => {
    const short = buildReport({
      ...SAMPLE,
      runsRequested: 600,
      runsSampled: 5,
      windowExhausted: true,
    });
    expect(short.sample.windowExhausted).toBe(true);
    expect(renderReport(short)).toContain(
      "run listing exhausted at 5 of the 600 runs asked for",
    );
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

describe("renderReport step tables", () => {
  const base = "2026-09-01T10:00:00Z";
  const step = (name, seconds) => ({
    name,
    startedAt: base,
    completedAt: new Date(Date.parse(base) + seconds * 1000).toISOString(),
    conclusion: "success",
  });
  const renderWithSteps = (steps) =>
    renderReport(
      buildReport({
        repo: "owner/repo",
        base: "staging",
        fetchedAt: base,
        rules: RULES,
        runsRequested: 1,
        runsSampled: 1,
        windowExhausted: false,
        shas: [
          {
            sha: "aaa",
            pullRequest: 10,
            runs: [
              attempt("Static Checks", "aaa", base, [
                {
                  name: "Typecheck, Lint, Format",
                  createdAt: base,
                  startedAt: base,
                  completedAt: base,
                  conclusion: "success",
                  steps,
                },
              ]),
            ],
            checkRuns: [],
          },
        ],
      }),
    );

  it("leaves the trailer row out when every step is already shown", () => {
    const text = renderWithSteps([step("Setup", 55), step("Typecheck", 30)]);
    expect(text).toContain("Steps of Static Checks / Typecheck, Lint, Format");
    expect(text).not.toContain("steps under 3s");
  });

  it("folds the steps under 3s into one trailer row", () => {
    const text = renderWithSteps([
      step("Setup", 55),
      step("Typecheck", 30),
      step("Blink", 2),
    ]);
    expect(text).toContain("(1 steps under 3s)");
  });
});

describe("repoFromRemoteUrl", () => {
  it("reads owner/name out of both remote forms git writes", () => {
    expect(repoFromRemoteUrl("git@github.com:georgetown-mdi/jspsi.git")).toBe(
      "georgetown-mdi/jspsi",
    );
    expect(repoFromRemoteUrl("https://github.com/georgetown-mdi/jspsi")).toBe(
      "georgetown-mdi/jspsi",
    );
    expect(
      repoFromRemoteUrl("https://github.com/georgetown-mdi/jspsi.git\n"),
    ).toBe("georgetown-mdi/jspsi");
  });

  it("returns null for a remote naming no GitHub repository", () => {
    expect(repoFromRemoteUrl("git@gitlab.com:owner/name.git")).toBeNull();
    expect(repoFromRemoteUrl("/srv/git/bare.git")).toBeNull();
    expect(repoFromRemoteUrl(null)).toBeNull();
  });
});

describe("collectSample", () => {
  const REPO = "owner/repo";
  const RUNS_PAGE = (page) =>
    `repos/${REPO}/actions/runs?event=pull_request&per_page=100&page=${page}`;

  /** A request that serves a fixture route table (or a function), recording paths. */
  function fixtureRequest(routes) {
    const paths = [];
    const request = async (path) => {
      paths.push(path);
      const payload =
        typeof routes === "function" ? routes(path) : routes[path];
      if (payload === undefined) throw new Error(`unexpected request: ${path}`);
      return payload;
    };
    return { paths, request };
  }

  const apiRun = (id, sha, createdAt, extra = {}) => ({
    id,
    name: "Static Checks",
    head_sha: sha,
    status: "completed",
    created_at: createdAt,
    run_attempt: 1,
    ...extra,
  });

  const apiJobs = (completedAt) => ({
    jobs: [
      {
        name: "Typecheck, Lint, Format",
        created_at: "2026-09-01T10:00:00Z",
        started_at: "2026-09-01T10:00:00Z",
        completed_at: completedAt,
        conclusion: "success",
        steps: [],
      },
    ],
  });

  const jobsPath = (id) =>
    `repos/${REPO}/actions/runs/${id}/jobs?per_page=100&filter=latest`;
  const checkRunsPath = (sha) =>
    `repos/${REPO}/commits/${sha}/check-runs?per_page=100`;
  const checkRuns = (sha) => ({
    check_runs: [
      {
        name: "Typecheck, Lint, Format",
        started_at: "2026-09-01T10:00:00Z",
        completed_at: "2026-09-01T10:04:00Z",
        conclusion: "success",
        app: { slug: `ignored-for-${sha}` },
      },
    ],
  });

  it("admits every run of the sha that met the request, and none of the next", async () => {
    const { paths, request } = fixtureRequest({
      [`repos/${REPO}/rules/branches/staging`]: RULES,
      [RUNS_PAGE(1)]: {
        workflow_runs: [
          apiRun(1, "aaa", "2026-09-01T10:00:00Z"),
          apiRun(2, "aaa", "2026-09-01T10:05:00Z"),
          apiRun(3, "bbb", "2026-09-01T11:00:00Z"),
        ],
      },
      [`repos/${REPO}/commits/aaa/pulls`]: [
        { number: 10, base: { ref: "staging" } },
      ],
      [checkRunsPath("aaa")]: checkRuns("aaa"),
      [jobsPath(1)]: apiJobs("2026-09-01T10:04:00Z"),
      [jobsPath(2)]: apiJobs("2026-09-01T10:09:00Z"),
    });

    const sample = await collectSample(
      { repo: REPO, base: "staging", runs: 1 },
      { request },
    );

    expect(sample.shas).toHaveLength(1);
    expect(sample.shas[0].sha).toBe("aaa");
    expect(sample.shas[0].runs.map((run) => run.runId)).toEqual([1, 2]);
    expect(sample.runsSampled).toBe(2);
    expect(sample.windowExhausted).toBe(false);
    // The next sha is not touched at all, not merely dropped from the sample.
    expect(paths.some((path) => path.includes("bbb"))).toBe(false);
  });

  it("attributes a sha to the pull request against the measured base", async () => {
    const { request } = fixtureRequest({
      [`repos/${REPO}/rules/branches/staging`]: RULES,
      [RUNS_PAGE(1)]: {
        workflow_runs: [
          apiRun(1, "aaa", "2026-09-01T10:00:00Z"),
          apiRun(2, "bbb", "2026-09-01T11:00:00Z"),
        ],
      },
      [RUNS_PAGE(2)]: { workflow_runs: [] },
      [`repos/${REPO}/commits/aaa/pulls`]: [
        { number: 20, base: { ref: "main" } },
        { number: 21, base: { ref: "staging" } },
      ],
      [`repos/${REPO}/commits/bbb/pulls`]: [
        { number: 22, base: { ref: "main" } },
      ],
      [checkRunsPath("aaa")]: checkRuns("aaa"),
      [jobsPath(1)]: apiJobs("2026-09-01T10:04:00Z"),
    });

    const sample = await collectSample(
      { repo: REPO, base: "staging", runs: 50 },
      { request },
    );

    expect(sample.shas.map((entry) => entry.pullRequest)).toEqual([21]);
  });

  it("measures the attempts below a rerun's last one and marks them superseded", async () => {
    const { request } = fixtureRequest({
      [`repos/${REPO}/rules/branches/staging`]: RULES,
      [RUNS_PAGE(1)]: {
        workflow_runs: [
          apiRun(7, "aaa", "2026-09-01T10:20:00Z", { run_attempt: 2 }),
        ],
      },
      [RUNS_PAGE(2)]: { workflow_runs: [] },
      [`repos/${REPO}/commits/aaa/pulls`]: [
        { number: 10, base: { ref: "staging" } },
      ],
      [checkRunsPath("aaa")]: checkRuns("aaa"),
      [`repos/${REPO}/actions/runs/7/attempts/1`]: {
        created_at: "2026-09-01T10:00:00Z",
        run_started_at: "2026-09-01T10:00:00Z",
      },
      [`repos/${REPO}/actions/runs/7/attempts/1/jobs?per_page=100`]: apiJobs(
        "2026-09-01T10:04:00Z",
      ),
      [jobsPath(7)]: apiJobs("2026-09-01T10:24:00Z"),
    });

    const sample = await collectSample(
      { repo: REPO, base: "staging", runs: 50 },
      { request },
    );

    expect(
      sample.shas[0].runs.map((run) => ({
        attempt: run.attempt,
        superseded: run.superseded,
        runCreatedAt: run.runCreatedAt,
      })),
    ).toEqual([
      {
        attempt: 1,
        superseded: true,
        runCreatedAt: "2026-09-01T10:00:00Z",
      },
      {
        attempt: 2,
        superseded: false,
        runCreatedAt: "2026-09-01T10:20:00Z",
      },
    ]);
  });

  it("stops at the page cap and records the window it ran out of", async () => {
    // Every page holds a run against another base, so the request is never met
    // and only the cap ends the loop.
    const { paths, request } = fixtureRequest((path) => {
      if (path === `repos/${REPO}/rules/branches/staging`) return RULES;
      if (path.startsWith(`repos/${REPO}/actions/runs?`)) {
        return { workflow_runs: [apiRun(1, "zzz", "2026-09-01T10:00:00Z")] };
      }
      if (path === `repos/${REPO}/commits/zzz/pulls`) {
        return [{ number: 30, base: { ref: "main" } }];
      }
      return undefined;
    });

    const sample = await collectSample(
      { repo: REPO, base: "staging", runs: 5 },
      { request },
    );

    expect(sample.windowExhausted).toBe(true);
    expect(sample.runsSampled).toBe(0);
    expect(sample.runsRequested).toBe(5);
    expect(sample.shas).toEqual([]);
    expect(
      paths.filter((path) => path.startsWith(`repos/${REPO}/actions/runs?`)),
    ).toHaveLength(MAX_RUN_PAGES);
  });

  it("replays a cached response and refuses a miss when offline", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "measure-pr-checks-"));
    const routes = {
      [`repos/${REPO}/rules/branches/staging`]: RULES,
      [RUNS_PAGE(1)]: { workflow_runs: [] },
    };
    const live = fixtureRequest(routes);
    await collectSample(
      { repo: REPO, base: "staging", runs: 1, cacheDir },
      { request: live.request },
    );
    expect(live.paths.length).toBeGreaterThan(0);

    const replay = fixtureRequest(routes);
    const cached = await collectSample(
      { repo: REPO, base: "staging", runs: 1, cacheDir, offline: true },
      { request: replay.request },
    );
    expect(cached.rules).toEqual(RULES);
    expect(replay.paths).toEqual([]);

    await expect(
      collectSample(
        { repo: REPO, base: "main", runs: 1, cacheDir, offline: true },
        { request: replay.request },
      ),
    ).rejects.toThrow(/no cached response for/);
  });
});
