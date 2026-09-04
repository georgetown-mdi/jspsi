#!/usr/bin/env node
//
// Measure the wall clock a pull request pays for its checks, and name the
// critical path that gates a merge.
//
// Usage:
//   node measure-pr-checks.mjs [runs] [--base BRANCH] [--repo OWNER/REPO]
//                              [--json] [--cache DIR] [--offline]
//
// A bare command line prints this usage rather than starting a measurement:
// the run makes several hundred API calls and takes minutes, so it is asked
// for explicitly. `runs` is how many pull-request workflow runs against --base
// to sample, newest first, defaulting to DEFAULT_RUN_SAMPLE.
//
// Four measurements, from two sources that answer different questions:
//
//   - Per workflow and per job, queue time and wall clock, from
//     `actions/runs` plus each run's `jobs`. This is where the minutes go.
//   - Per step inside each long job, from the same payload. A job's own median
//     says how long it takes and not which of its serial steps to attack, so a
//     trim proposal that names no step is not a measurement.
//   - The set of check contexts that gate a merge, read from the LIVE branch
//     ruleset (`repos/{repo}/rules/branches/{base}`) rather than a list
//     transcribed into this file, so the measurement cannot claim a gate the
//     repository stopped enforcing.
//   - The critical path per pull-request head sha, from that sha's
//     `check-runs`. Contexts, not job names, are what a required status check
//     names, and not every context is an Actions job -- code scanning posts
//     its own -- so a job-only view cannot see the whole gate. Measured from
//     the earliest run creation on the sha, which is when the contributor
//     starts waiting.
//
// Reruns are counted per sha and reported separately. A rerun does not create
// a new run id, it raises `run_attempt`, so a sample read only from the runs
// list sees the last attempt's clock and none of the wall clock the earlier
// attempts cost. Each attempt below its own is fetched and measured.
//
// --cache DIR writes every API response under DIR and reads them back on a
// later run, so re-analyzing a sample (or changing the output) costs no API
// calls. --offline makes no request at all and fails on a cache miss, which is
// how a re-analysis proves it re-read the recorded sample rather than quietly
// measuring today's runs instead.
//
// The computation is pure and lives above the fetch layer, so the colocated
// test drives it on a fixture. Run it with the rest of the scripts project:
// `npx vitest run --project scripts` (or `npm run test:scripts`).

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { githubToken } from "./lib/projectItems.mjs";

/** Pull-request runs sampled when the command line names no count. */
export const DEFAULT_RUN_SAMPLE = 300;

const USAGE =
  "Usage: npm run measure:pr-checks -- [runs] [--base BRANCH] [--repo OWNER/REPO] [--json] [--cache DIR] [--offline]\n" +
  `       (samples the newest [runs] pull-request workflow runs against --base; default ${DEFAULT_RUN_SAMPLE}, default base staging)\n`;

/**
 * Parse the command line. Returns { ok: true, runs, base, repo, asJson,
 * cacheDir, offline } or { ok: false, message } with a newline-terminated
 * string ready for stderr. An empty argv is a usage request, not a default
 * measurement.
 */
export function parseArgs(argv) {
  if (argv.length === 0) return { ok: false, message: USAGE };

  let runs = DEFAULT_RUN_SAMPLE;
  let base = "staging";
  let repo = null;
  let asJson = false;
  let cacheDir = null;
  let offline = false;
  const positionals = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--json") {
      asJson = true;
      i += 1;
    } else if (arg === "--offline") {
      offline = true;
      i += 1;
    } else if (arg === "--base" || arg === "--repo" || arg === "--cache") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, message: `error: ${arg} requires a value\n` };
      }
      if (arg === "--base") base = value;
      else if (arg === "--repo") repo = value;
      else cacheDir = value;
      i += 2;
    } else if (arg.startsWith("--")) {
      return { ok: false, message: USAGE };
    } else {
      positionals.push(arg);
      i += 1;
    }
  }

  if (positionals.length > 1) return { ok: false, message: USAGE };
  if (positionals.length === 1) {
    const parsed = Number(positionals[0]);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { ok: false, message: USAGE };
    }
    runs = parsed;
  }
  if (offline && (cacheDir === null || repo === null)) {
    return {
      ok: false,
      message:
        "error: --offline needs --cache DIR to read the sample from and --repo OWNER/REPO to name it\n",
    };
  }

  return { ok: true, runs, base, repo, asJson, cacheDir, offline };
}

/**
 * The check contexts a merge to the branch requires, read from the
 * `repos/{repo}/rules/branches/{branch}` payload. Returns them sorted, each
 * with the integration that posts it (an Actions job and an app-posted check
 * are both required contexts but come from different places, and only the
 * former appears in a workflow's job list).
 */
export function requiredContextsFromRules(rules) {
  const contexts = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (rule?.type !== "required_status_checks") continue;
    for (const check of rule.parameters?.required_status_checks ?? []) {
      if (typeof check?.context !== "string") continue;
      contexts.push({
        context: check.context,
        integrationId: check.integration_id ?? null,
      });
    }
  }
  contexts.sort((a, b) => a.context.localeCompare(b.context));
  return contexts;
}

/** Seconds between two ISO timestamps, or null when either is missing. */
export function secondsBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(0, Math.round((to - from) / 1000));
}

/** The smallest parseable ISO timestamp in the list, or null. */
export function earliest(timestamps) {
  const times = timestamps
    .filter(Boolean)
    .map(Date.parse)
    .filter(Number.isFinite);
  if (times.length === 0) return null;
  return new Date(Math.min(...times)).toISOString().replace(".000Z", "Z");
}

/** The largest parseable ISO timestamp in the list, or null. */
export function latest(timestamps) {
  const times = timestamps
    .filter(Boolean)
    .map(Date.parse)
    .filter(Number.isFinite);
  if (times.length === 0) return null;
  return new Date(Math.max(...times)).toISOString().replace(".000Z", "Z");
}

/** Median of the numbers, null on an empty list. Even counts average the pair. */
export function median(values) {
  const sorted = values
    .filter((v) => typeof v === "number")
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Nearest-rank percentile: the smallest observation at or above the requested
 * fraction of the sample. Nearest-rank rather than an interpolated one so
 * every reported value is a run that actually happened.
 */
export function percentile(values, fraction) {
  const sorted = values
    .filter((v) => typeof v === "number")
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/** `1m 05s`, or `-` for a missing value. Seconds in, human string out. */
export function formatSeconds(seconds) {
  if (typeof seconds !== "number") return "-";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes === 0
    ? `${rest}s`
    : `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

function statBlock(values) {
  return {
    n: values.length,
    medianSeconds: median(values),
    p90Seconds: percentile(values, 0.9),
    maxSeconds: values.length === 0 ? null : Math.max(...values),
  };
}

/**
 * Per-job queue and wall clock across every sampled attempt. Queue is the job's
 * creation to its start, which for a job behind `needs:` also holds the time it
 * spent waiting on its dependency -- that is real waiting, and the workflow
 * files say which jobs have one. Wall clock is start to completion. A job the
 * run skipped is left out entirely -- its start and completion are the same
 * instant, which would pull a median toward zero for work that did not happen.
 */
export function summarizeJobs(attempts, requiredSet) {
  const byKey = new Map();
  for (const attempt of attempts) {
    for (const job of attempt.jobs) {
      if (job.conclusion === "skipped") continue;
      const key = `${attempt.workflowName}\u0000${job.name}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          workflow: attempt.workflowName,
          job: job.name,
          gating: requiredSet.has(job.name),
          queue: [],
          wall: [],
        };
        byKey.set(key, entry);
      }
      const queue = secondsBetween(job.createdAt, job.startedAt);
      const wall = secondsBetween(job.startedAt, job.completedAt);
      if (queue !== null) entry.queue.push(queue);
      if (wall !== null) entry.wall.push(wall);
    }
  }

  return [...byKey.values()]
    .map((entry) => ({
      workflow: entry.workflow,
      job: entry.job,
      gating: entry.gating,
      n: entry.wall.length,
      queue: statBlock(entry.queue),
      wall: statBlock(entry.wall),
    }))
    .sort((a, b) => (b.wall.medianSeconds ?? 0) - (a.wall.medianSeconds ?? 0));
}

/**
 * Per-step wall clock inside each job, which is where a trim to a job on the
 * critical path has to come from: a job's own median says how long it takes,
 * not which of its serial steps to attack. Only jobs whose steps sum to
 * `minJobSeconds` or more are broken down, since the point is the long ones.
 */
export function summarizeSteps(attempts, minJobSeconds = 60) {
  const byJob = new Map();
  for (const attempt of attempts) {
    for (const job of attempt.jobs) {
      if (job.conclusion === "skipped") continue;
      const key = `${attempt.workflowName} / ${job.name}`;
      let steps = byJob.get(key);
      if (!steps) {
        steps = new Map();
        byJob.set(key, steps);
      }
      for (const step of job.steps ?? []) {
        if (step.conclusion === "skipped") continue;
        const seconds = secondsBetween(step.startedAt, step.completedAt);
        if (seconds === null) continue;
        const bucket = steps.get(step.name) ?? [];
        bucket.push(seconds);
        steps.set(step.name, bucket);
      }
    }
  }

  return [...byJob.entries()]
    .map(([job, steps]) => {
      const rows = [...steps.entries()]
        .map(([name, values]) => ({ step: name, ...statBlock(values) }))
        .sort((a, b) => (b.medianSeconds ?? 0) - (a.medianSeconds ?? 0));
      return {
        job,
        medianTotalSeconds: rows.reduce(
          (sum, row) => sum + (row.medianSeconds ?? 0),
          0,
        ),
        steps: rows,
      };
    })
    .filter((row) => row.medianTotalSeconds >= minJobSeconds)
    .sort((a, b) => b.medianTotalSeconds - a.medianTotalSeconds);
}

/**
 * Per-workflow queue and wall clock. Queue is run creation to its first job
 * starting; wall clock is that first start to its last job completing, so a
 * workflow whose jobs run in parallel is measured once end to end rather than
 * as the sum of its legs.
 */
export function summarizeWorkflows(attempts, requiredSet) {
  const byName = new Map();
  for (const attempt of attempts) {
    let entry = byName.get(attempt.workflowName);
    if (!entry) {
      entry = {
        workflow: attempt.workflowName,
        gating: false,
        queue: [],
        wall: [],
        total: [],
      };
      byName.set(attempt.workflowName, entry);
    }
    if (attempt.jobs.some((job) => requiredSet.has(job.name)))
      entry.gating = true;
    const ran = attempt.jobs.filter((job) => job.conclusion !== "skipped");
    const firstStart = earliest(ran.map((job) => job.startedAt));
    const lastEnd = latest(ran.map((job) => job.completedAt));
    const queue = secondsBetween(attempt.runCreatedAt, firstStart);
    const wall = secondsBetween(firstStart, lastEnd);
    const total = secondsBetween(attempt.runCreatedAt, lastEnd);
    if (queue !== null) entry.queue.push(queue);
    if (wall !== null) entry.wall.push(wall);
    if (total !== null) entry.total.push(total);
  }

  return [...byName.values()]
    .map((entry) => ({
      workflow: entry.workflow,
      gating: entry.gating,
      n: entry.total.length,
      queue: statBlock(entry.queue),
      wall: statBlock(entry.wall),
      total: statBlock(entry.total),
    }))
    .sort(
      (a, b) => (b.total.medianSeconds ?? 0) - (a.total.medianSeconds ?? 0),
    );
}

/**
 * The critical path for one head sha: the check that finished last, measured
 * from the earliest workflow-run creation on that sha. `contexts` is the set to
 * consider -- the required contexts for the gating path, every observed context
 * for the path a contributor watching an all-green PR actually waits through.
 */
export function criticalPathForSha(shaSample, contexts) {
  const start = earliest(shaSample.runs.map((attempt) => attempt.runCreatedAt));
  if (start === null) return null;
  let holder = null;
  let holderEnd = null;
  for (const check of shaSample.checkRuns) {
    if (contexts !== null && !contexts.has(check.name)) continue;
    if (!check.completedAt) continue;
    if (
      holderEnd === null ||
      Date.parse(check.completedAt) > Date.parse(holderEnd)
    ) {
      holderEnd = check.completedAt;
      holder = check.name;
    }
  }
  if (holder === null) return null;
  return {
    sha: shaSample.sha,
    pullRequest: shaSample.pullRequest,
    startedAt: start,
    holder,
    completedAt: holderEnd,
    seconds: secondsBetween(start, holderEnd),
  };
}

/**
 * Median, p90, and which check held the path how often, across every sha in
 * the sample. `contexts` of null measures every observed check.
 */
export function criticalPath(shaSamples, contexts) {
  const perSha = shaSamples
    .map((sample) => criticalPathForSha(sample, contexts))
    .filter((row) => row !== null && row.seconds !== null);
  const holders = new Map();
  for (const row of perSha) {
    holders.set(row.holder, (holders.get(row.holder) ?? 0) + 1);
  }
  const seconds = perSha.map((row) => row.seconds);
  return {
    ...statBlock(seconds),
    holders: [...holders.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    perSha: perSha.sort((a, b) => b.seconds - a.seconds),
  };
}

/**
 * The wall clock reruns added, which a sample read only from the runs list
 * cannot see: every attempt below a run's last one is time the contributor
 * waited and no per-workflow median holds.
 */
export function summarizeReruns(attempts) {
  const superseded = attempts.filter((attempt) => attempt.superseded);
  const byWorkflow = new Map();
  let addedSeconds = 0;
  for (const attempt of superseded) {
    const lastEnd = latest(
      attempt.jobs
        .filter((job) => job.conclusion !== "skipped")
        .map((job) => job.completedAt),
    );
    const total = secondsBetween(attempt.runCreatedAt, lastEnd) ?? 0;
    addedSeconds += total;
    const entry = byWorkflow.get(attempt.workflowName) ?? {
      attempts: 0,
      seconds: 0,
    };
    entry.attempts += 1;
    entry.seconds += total;
    byWorkflow.set(attempt.workflowName, entry);
  }
  return {
    rerunAttempts: superseded.length,
    shasWithReruns: new Set(superseded.map((attempt) => attempt.headSha)).size,
    addedSeconds,
    byWorkflow: [...byWorkflow.entries()]
      .map(([workflow, entry]) => ({ workflow, ...entry }))
      .sort((a, b) => b.seconds - a.seconds),
  };
}

/**
 * The whole measurement, computed from a normalized sample. Pure: `sample` is
 * { repo, base, fetchedAt, rules, shas: [{ sha, pullRequest, runs, checkRuns }] },
 * where each run is one attempt with its jobs.
 */
export function buildReport(sample) {
  const required = requiredContextsFromRules(sample.rules);
  const requiredSet = new Set(required.map((entry) => entry.context));
  const attempts = sample.shas.flatMap((shaSample) => shaSample.runs);
  const observedContexts = new Set(
    sample.shas.flatMap((shaSample) =>
      shaSample.checkRuns.map((check) => check.name),
    ),
  );
  const observedJobs = new Set(
    attempts.flatMap((a) => a.jobs.map((job) => job.name)),
  );

  const createdTimes = attempts.map((attempt) => attempt.runCreatedAt);
  return {
    repo: sample.repo,
    base: sample.base,
    fetchedAt: sample.fetchedAt,
    sample: {
      runAttempts: attempts.length,
      headShas: sample.shas.length,
      pullRequests: new Set(
        sample.shas
          .map((s) => s.pullRequest)
          .filter((n) => typeof n === "number"),
      ).size,
      runsRequested: sample.runsRequested ?? null,
      runsSampled: sample.runsSampled ?? null,
      windowExhausted: sample.windowExhausted === true,
      from: earliest(createdTimes),
      to: latest(createdTimes),
    },
    required: required.map((entry) => ({
      ...entry,
      observedAsCheck: observedContexts.has(entry.context),
      observedAsJob: observedJobs.has(entry.context),
    })),
    workflows: summarizeWorkflows(attempts, requiredSet),
    jobs: summarizeJobs(attempts, requiredSet),
    criticalPath: {
      required: criticalPath(sample.shas, requiredSet),
      allChecks: criticalPath(sample.shas, null),
    },
    reruns: summarizeReruns(attempts),
    steps: summarizeSteps(attempts),
  };
}

function table(headers, rows) {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => String(row[column]).length)),
  );
  const line = (cells) =>
    cells
      .map((cell, column) =>
        column === 0
          ? String(cell).padEnd(widths[column])
          : String(cell).padStart(widths[column]),
      )
      .join("  ");
  return [
    line(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map(line),
  ].join("\n");
}

/** The human-readable report: the same numbers `--json` emits, as tables. */
export function renderReport(report) {
  const out = [];
  const shortfall = report.sample.windowExhausted
    ? `, run listing exhausted at ${report.sample.runsSampled} of the ` +
      `${report.sample.runsRequested} runs asked for`
    : "";
  out.push(
    `${report.repo} -- pull-request checks against ${report.base}`,
    `sample: ${report.sample.runAttempts} run attempts over ${report.sample.headShas} head shas ` +
      `(${report.sample.pullRequests} pull requests), ${report.sample.from} .. ${report.sample.to}${shortfall}`,
    "",
    "Required check contexts (live branch ruleset):",
  );
  for (const entry of report.required) {
    const seen = entry.observedAsJob
      ? "Actions job"
      : entry.observedAsCheck
        ? "app-posted check, no Actions job of this name"
        : "not observed in the sample";
    out.push(`  ${entry.context}  [${seen}]`);
  }

  out.push(
    "",
    "Per workflow (queue = run creation to first job start; wall = first start to last completion):",
    table(
      [
        "workflow",
        "gates",
        "n",
        "queue med",
        "wall med",
        "wall p90",
        "total med",
        "total p90",
      ],
      report.workflows.map((row) => [
        row.workflow,
        row.gating ? "yes" : "no",
        row.n,
        formatSeconds(row.queue.medianSeconds),
        formatSeconds(row.wall.medianSeconds),
        formatSeconds(row.wall.p90Seconds),
        formatSeconds(row.total.medianSeconds),
        formatSeconds(row.total.p90Seconds),
      ]),
    ),
    "",
    "Per job (queue includes any wait on a `needs:` dependency):",
    table(
      [
        "workflow / job",
        "gates",
        "n",
        "queue med",
        "wall med",
        "wall p90",
        "wall max",
      ],
      report.jobs.map((row) => [
        `${row.workflow} / ${row.job}`,
        row.gating ? "yes" : "no",
        row.n,
        formatSeconds(row.queue.medianSeconds),
        formatSeconds(row.wall.medianSeconds),
        formatSeconds(row.wall.p90Seconds),
        formatSeconds(row.wall.maxSeconds),
      ]),
    ),
  );

  for (const [label, path] of [
    ["required contexts only", report.criticalPath.required],
    ["every check on the sha", report.criticalPath.allChecks],
  ]) {
    out.push(
      "",
      `Critical path, ${label} (earliest run creation to the last of them completing):`,
      `  n=${path.n}  median ${formatSeconds(path.medianSeconds)}  p90 ${formatSeconds(path.p90Seconds)}  max ${formatSeconds(path.maxSeconds)}`,
      "  held by:",
      ...path.holders.map(
        (holder) =>
          `    ${holder.count.toString().padStart(4)}x  ${holder.name}` +
          ` (${Math.round((100 * holder.count) / Math.max(path.n, 1))}%)`,
      ),
    );
  }

  for (const job of report.steps) {
    const shown = job.steps.filter((step) => (step.medianSeconds ?? 0) >= 3);
    const rest = job.steps
      .filter((step) => (step.medianSeconds ?? 0) < 3)
      .reduce((sum, step) => sum + (step.medianSeconds ?? 0), 0);
    out.push(
      "",
      `Steps of ${job.job} (medians summing to ${formatSeconds(job.medianTotalSeconds)}):`,
      table(
        ["step", "median", "p90", "max"],
        [
          ...shown.map((step) => [
            step.step,
            formatSeconds(step.medianSeconds),
            formatSeconds(step.p90Seconds),
            formatSeconds(step.maxSeconds),
          ]),
          ...(job.steps.length > shown.length
            ? [
                [
                  `(${job.steps.length - shown.length} steps under 3s)`,
                  formatSeconds(rest),
                  "-",
                  "-",
                ],
              ]
            : []),
        ],
      ),
    );
  }

  out.push(
    "",
    `Reruns: ${report.reruns.rerunAttempts} superseded attempts across ${report.reruns.shasWithReruns} shas, ` +
      `adding ${formatSeconds(report.reruns.addedSeconds)} of wall clock the per-workflow medians do not hold.`,
  );
  for (const row of report.reruns.byWorkflow) {
    out.push(
      `  ${row.workflow}: ${row.attempts} attempts, ${formatSeconds(row.seconds)}`,
    );
  }

  return out.join("\n") + "\n";
}

const GITHUB_API_ROOT = "https://api.github.com";
// GitHub rejects API requests without a User-Agent; identify this script.
const USER_AGENT = "psilink-measure-pr-checks";

/**
 * Pages of the pull-request run listing one measurement scans, 100 runs each,
 * bounding the API spend of a large `runs` argument at 4,000 scanned runs. A
 * sample that runs the window out before it has the runs it was asked for says
 * so on the report rather than passing a short sample off as the whole request.
 */
export const MAX_RUN_PAGES = 40;

/**
 * A live API reader: a REST path (no leading slash) in, parsed JSON out. Node
 * `fetch` rather than a `gh api` subprocess, the shape lib/projectItems.mjs
 * uses, because gh's network subcommands fail inside the command sandbox. The
 * token is resolved on the first request, so a replay served entirely from the
 * cache needs no credential.
 */
export function createApiRequest() {
  let token = null;
  return async (path) => {
    token ??= githubToken();
    const url = `${GITHUB_API_ROOT}/${path}`;
    let res;
    let text;
    try {
      res = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": USER_AGENT,
        },
      });
      text = await res.text();
    } catch (err) {
      throw new Error(`GET ${url} failed: ${err.message}`, { cause: err });
    }
    if (!res.ok) {
      throw new Error(
        `GET ${url} failed with HTTP ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        `GET ${url} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`,
      );
    }
  };
}

/**
 * The --cache DIR / --offline replay contract around a request: a recorded
 * response answers without a call, a fresh one is written back under the hash
 * of its path, and --offline fails on a miss.
 */
function cachingRequest(request, { cacheDir, offline }) {
  return async (path) => {
    const key = createHash("sha256").update(path).digest("hex").slice(0, 32);
    const cacheFile = cacheDir === null ? null : join(cacheDir, `${key}.json`);
    if (cacheFile !== null) {
      try {
        return JSON.parse(readFileSync(cacheFile, "utf8"));
      } catch {
        // Not cached yet; fall through to the API unless --offline forbids it.
      }
    }
    if (offline) throw new Error(`no cached response for ${path}`);
    const parsed = await request(path);
    if (cacheFile !== null) writeFileSync(cacheFile, JSON.stringify(parsed));
    return parsed;
  };
}

function normalizeJobs(payload) {
  return (payload.jobs ?? []).map((job) => ({
    name: job.name,
    createdAt: job.created_at ?? null,
    startedAt: job.started_at ?? null,
    completedAt: job.completed_at ?? null,
    conclusion: job.conclusion ?? null,
    steps: (job.steps ?? []).map((step) => ({
      name: step.name,
      startedAt: step.started_at ?? null,
      completedAt: step.completed_at ?? null,
      conclusion: step.conclusion ?? null,
    })),
  }));
}

/**
 * The normalized sample buildReport computes from, fetched a page of runs at a
 * time until `runs` of them are held or the MAX_RUN_PAGES window runs out.
 * `request` is the path -> JSON reader, injectable so the test drives the
 * collection on fixtures rather than the live API.
 * @internal
 */
export async function collectSample(
  { repo, base, runs: wanted, cacheDir = null, offline = false },
  { request = createApiRequest() } = {},
) {
  const api = cachingRequest(request, { cacheDir, offline });
  const rules = await api(`repos/${repo}/rules/branches/${base}`);

  const baseOfSha = new Map();
  const prOfSha = new Map();
  const shas = new Map();
  let selected = 0;
  let page = 1;

  while (page <= MAX_RUN_PAGES) {
    const listing = await api(
      `repos/${repo}/actions/runs?event=pull_request&per_page=100&page=${page}`,
    );
    const workflowRuns = listing.workflow_runs ?? [];
    if (workflowRuns.length === 0) break;
    page += 1;

    for (const run of workflowRuns) {
      // Stop only at a sha boundary: a sha admitted with half its runs would
      // report a critical path shorter than the one that actually ran.
      if (selected >= wanted && !shas.has(run.head_sha)) {
        page = Infinity;
        break;
      }
      if (run.status !== "completed") continue;
      if (!baseOfSha.has(run.head_sha)) {
        const pulls = await api(`repos/${repo}/commits/${run.head_sha}/pulls`);
        // A sha can sit on more than one pull request; attribute it to the one
        // against the measured base, or to none, rather than to whichever the
        // API happens to list first.
        const pull = Array.isArray(pulls)
          ? (pulls.find((entry) => entry?.base?.ref === base) ?? null)
          : null;
        baseOfSha.set(run.head_sha, pull?.base?.ref ?? null);
        prOfSha.set(run.head_sha, pull?.number ?? null);
      }
      if (baseOfSha.get(run.head_sha) !== base) continue;

      if (!shas.has(run.head_sha)) {
        const checks = await api(
          `repos/${repo}/commits/${run.head_sha}/check-runs?per_page=100`,
        );
        shas.set(run.head_sha, {
          sha: run.head_sha,
          pullRequest: prOfSha.get(run.head_sha),
          runs: [],
          checkRuns: (checks.check_runs ?? []).map((check) => ({
            name: check.name,
            startedAt: check.started_at ?? null,
            completedAt: check.completed_at ?? null,
            conclusion: check.conclusion ?? null,
          })),
        });
      }
      const entry = shas.get(run.head_sha);

      const attemptCount = run.run_attempt ?? 1;
      for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
        const isLast = attempt === attemptCount;
        const meta = isLast
          ? run
          : await api(
              `repos/${repo}/actions/runs/${run.id}/attempts/${attempt}`,
            );
        const jobsPath = isLast
          ? `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100&filter=latest`
          : `repos/${repo}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`;
        entry.runs.push({
          runId: run.id,
          workflowName: run.name,
          headSha: run.head_sha,
          attempt,
          superseded: !isLast,
          runCreatedAt: meta.created_at ?? run.created_at,
          runStartedAt: meta.run_started_at ?? null,
          jobs: normalizeJobs(await api(jobsPath)),
        });
      }
      selected += 1;
    }
  }

  return {
    repo,
    base,
    fetchedAt: new Date().toISOString(),
    rules,
    runsRequested: wanted,
    runsSampled: selected,
    windowExhausted: selected < wanted,
    shas: [...shas.values()],
  };
}

/**
 * The `owner/name` a GitHub remote URL names, or null for a URL that names no
 * GitHub repository. Both remote forms git writes: `git@github.com:owner/name.git`
 * and `https://github.com/owner/name`, with or without the `.git` suffix.
 */
export function repoFromRemoteUrl(url) {
  const match =
    /^(?:git@github\.com:|(?:https?|ssh):\/\/(?:[^@/]+@)?github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      String(url ?? "").trim(),
    );
  return match === null ? null : `${match[1]}/${match[2]}`;
}

function resolveRepo(explicit) {
  if (explicit !== null) return explicit;
  const run = spawnSync("git", ["config", "--get", "remote.origin.url"], {
    encoding: "utf8",
  });
  const repo =
    run.error || run.status !== 0 ? null : repoFromRemoteUrl(run.stdout);
  if (repo === null) {
    throw new Error("could not resolve the repository; pass --repo OWNER/REPO");
  }
  return repo;
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without spawning anything.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(parsed.message);
    process.exit(2);
  }
  try {
    if (parsed.cacheDir !== null)
      mkdirSync(parsed.cacheDir, { recursive: true });
    const sample = await collectSample({
      ...parsed,
      repo: resolveRepo(parsed.repo),
    });
    const report = buildReport(sample);
    process.stdout.write(
      parsed.asJson
        ? JSON.stringify(report, null, 2) + "\n"
        : renderReport(report),
    );
  } catch (err) {
    process.stderr.write(`${err.message ?? err}\n`);
    process.exit(1);
  }
}
