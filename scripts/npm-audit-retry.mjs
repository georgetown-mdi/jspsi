#!/usr/bin/env node
// Production-scope dependency audit with a bounded retry, run by
// static_checks.yaml as the merge gate's blocking audit step.
//
// The command it runs is exactly the one CONTRIBUTING.md's Dependency Policy
// and docs/RELEASES.md step 4 hand a maintainer, so the local answer and the
// gate cannot diverge; the retry is the only thing this file adds. npm's audit
// endpoint is a network service the branch under test has no relationship
// with: when it answers 503, every pull request open at that moment goes red
// after all of its tests have passed, and the only remedy a contributor has is
// to push an empty commit. A bounded retry converts that into a slower green.
//
// What is retried, and what is never retried. npm exits 1 both for a genuine
// advisory finding and for an endpoint failure, so the exit code cannot tell
// them apart; the message can. A run that reached the endpoint prints its
// report and exits, and a run that did not prints `npm error audit endpoint
// returned an error` and has no report at all. Only that line, matched on
// npm's own stderr and anchored to the whole line, is retried -- so an
// advisory finding fails on the first attempt, and anything this file cannot
// classify fails on the first attempt too.
//
// Measured against npm 11.19 (a local stub registry, so no outage was needed):
// a 503 from the bulk advisories endpoint and a socket hang up both produce
// that one line and exit 1; npm itself issues a single request per invocation
// on a 503 rather than retrying inside the run, so each attempt below is one
// hit on the endpoint; and a stub serving a real advisory produces a report on
// stdout, exit 1, and no such line. scripts/npm-audit-retry.test.mjs drives all
// three against the real npm rather than modelling them (CLAUDE.md: an external
// tool's behavior is settled by driving the tool).
//
// What this does not cover:
//   - A silenced npm (`npm_config_loglevel=silent`) prints no error line, so an
//     endpoint failure under it is treated as unclassifiable and fails on the
//     first attempt -- the safe direction, and why the classification is an
//     allowlist of one message rather than a denylist of report shapes.
//   - An outage outliving the delay table below still fails the run, which is
//     the intent: this buys a bounded wait, not an unbounded one.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, the audit's working directory. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The production-scope audit, as argv. `npm audit` answers `found 0
 * vulnerabilities` against the committed lockfile over this scope, so the gate
 * takes any finding at all: no `--audit-level`, no allowlist. Kept beside
 * AUDIT_COMMAND so the command this file runs and the command CONTRIBUTING.md
 * and docs/RELEASES.md hand a maintainer cannot drift apart.
 */
export const AUDIT_ARGS = [
  "audit",
  "--omit=dev",
  "-w",
  "packages/core",
  "-w",
  "apps/cli",
  "-w",
  "apps/web",
];

/** The same command as the string the two documents spell out. */
export const AUDIT_COMMAND = `npm ${AUDIT_ARGS.join(" ")}`;

/**
 * The wait before each retry, one entry per retry: three attempts in all, and
 * at most 40 seconds of waiting added to a job that fails anyway. Rising, so a
 * one-second blip and a half-minute outage are both covered without holding a
 * runner for either's worst case.
 */
export const RETRY_DELAYS_MS = [10_000, 30_000];

/** npm's line for "I got no report from the endpoint", the only retried state. */
const ENDPOINT_ERROR = /^npm error audit endpoint returned an error\s*$/m;

/**
 * Whether a failed audit run is the endpoint failing rather than the tree. Read
 * from stderr alone: the advisory report -- package names and advisory titles,
 * neither of them this repository's text -- goes to stdout, so no text a
 * dependency or an advisory supplies can reach this match. The whole-line
 * anchor holds because the run below pipes npm's output, and npm colors nothing
 * it writes into a pipe.
 */
export function isEndpointFailure({ code, stderr }) {
  return code !== 0 && ENDPOINT_ERROR.test(stderr);
}

function runAudit(args, { cwd, env }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("npm", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", rejectPromise);
    child.on("close", (code) =>
      resolvePromise({ code: code ?? 1, stdout, stderr }),
    );
  });
}

const wait = (ms) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/**
 * Run the audit, retrying an endpoint failure on the delay table, and return
 * the exit code to leave with. Everything the run emits -- npm's own output for
 * each attempt, then the retry notices -- goes through the single `report` sink
 * in the order it happened, so a job log holds one transcript.
 */
export async function auditWithRetry({
  args = AUDIT_ARGS,
  cwd = REPO_ROOT,
  env = process.env,
  delaysMs = RETRY_DELAYS_MS,
  sleep = wait,
  report = (text) => process.stderr.write(text),
} = {}) {
  const attempts = delaysMs.length + 1;
  for (let attempt = 1; ; attempt++) {
    const result = await runAudit(args, { cwd, env });
    report(result.stdout);
    report(result.stderr);
    if (result.code === 0) return 0;
    if (!isEndpointFailure(result)) return result.code;
    if (attempt === attempts) {
      report(
        `npm audit could not reach the audit endpoint on ${attempts} attempts; failing the run.\n`,
      );
      return result.code;
    }
    const delay = delaysMs[attempt - 1];
    report(
      `npm audit could not reach the audit endpoint (attempt ${attempt} of ${attempts}); retrying in ${Math.round(delay / 1000)}s.\n`,
    );
    await sleep(delay);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await auditWithRetry();
}
