import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  parseActionReference,
  parseWorkflow,
  readWorkflows,
  usesNodes,
} from "./lib/workflows.mjs";

// The container image vulnerability scan runs from more than one place -- the
// pull-request gate in image_smoke.yaml, the weekly scan of the published tag
// beside it, and one gate per image in release.yaml ahead of the push -- and
// each writes its threshold out as literal `with:` inputs. Nothing makes them
// one setting, so the severity list, the vulnerability types read, the fixable
// filter or the exception list can be raised on the pre-merge gate and left
// where it was on the ship gate. The result passes review as a single-line
// change and leaves two gates answering different questions under one name,
// with no run that reports the difference. This holds them identical.
//
// The comparison is the whole `with:` block minus the inputs below, so an input
// nobody has thought of yet is compared too rather than needing to be named
// here first. The action reference is compared with it: two invocations at
// different versions of the scanner are not the same gate whatever their inputs
// say, and release.yaml's comment claims they are the same scanner.
//
// A gate is also what its failure reaches, and no `with:` input states that, so
// the keys that decide it are read beside the inputs: the step's
// `continue-on-error:` and `if:`, and the `continue-on-error:` of the job it
// sits in. An invocation whose finding cannot fail the workflow is a report
// under the gate's name and its threshold says nothing about what any run
// refuses, so it is held apart from the invocations that gate unless
// RECORDED_FAILURE_MODES names it with the reason.
//
// What it cannot see: whether the threshold is the right one, whether a run
// used the file the tree holds, and any scan invoked by a `run:` line rather
// than by the action. The failure keys are read as text and no expression is
// evaluated, so `continue-on-error: ${{ ... }}` counts as report-only on every
// leg rather than the ones the expression picks, and an `if:` is read as a
// condition without reading what it selects -- an invocation narrowed from
// every trigger to one keeps the failure mode it had. Only `.github/workflows`
// is read, so a scan moved behind a reusable workflow or a composite action is
// not compared at all. A tree with fewer than two invocations would satisfy
// every property here vacuously, so the count is asserted too.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TRIVY_ACTION = "aquasecurity/trivy-action";

// Inputs that name the site rather than the gate. `image-ref` is the image each
// one reads; `format`, `output` and `limit-severities-for-sarif` are where the
// findings go, which is SARIF for the legs that upload code-scanning alerts and
// a table for the ones that report on a run summary. Adding an input here
// exempts it from the comparison, so an entry is a decision that the input says
// nothing about what the gate accepts -- `exit-code` is not one of them, a scan
// that cannot fail being a different gate from one that can.
const PER_SITE_INPUTS = new Set([
  "image-ref",
  "format",
  "output",
  "limit-severities-for-sarif",
]);

// Inputs no invocation may leave to the action's default: each is part of what
// the gate accepts, and a default is not visible in the diff that drops one.
const REQUIRED_INPUTS = [
  "scan-type",
  "scanners",
  "vuln-type",
  "severity",
  "ignore-unfixed",
  "trivyignores",
  "exit-code",
];

// Invocations whose failure controls hold them to something other than what
// the rest of the tree runs, each named by file, job and step id with the
// reason in words. An entry is a decision that a scan under this name reports
// rather than gates, so it states what makes it report-only and what ends
// that. The `if:` and `continue-on-error:` are recorded as written and
// compared against the file, so an entry the step it names does not match
// fails instead of standing as an exemption for a reason the step has
// dropped.
const RECORDED_FAILURE_MODES = [];

/**
 * What names one step across the tree: its file, the job it sits in, and its
 * own id. A step id is unique within its job only, so two jobs of one file may
 * each hold a step called `scan` and the job name is part of this name. A step
 * with no id, and a composite action's step under no job at all, are named by
 * the position they sit at instead.
 */
const siteOf = (path, node) =>
  node.id === null || node.jobName === null
    ? `${path} ${node.location}`
    : `${path} ${node.jobName} ${node.id}`;

/** Every trivy-action step in the given workflows, in file and document order. */
function invocationsIn(workflows) {
  return workflows.flatMap(({ path, source }) =>
    usesNodes(parseWorkflow(path, source))
      .filter((node) => {
        const reference = parseActionReference(node.uses);
        return reference !== null && reference.name.trim() === TRIVY_ACTION;
      })
      .map((node) => ({
        site: siteOf(path, node),
        ref: parseActionReference(node.uses).ref,
        inputs: node.inputs ?? {},
        condition: node.condition,
        continueOnError: node.continueOnError,
        jobContinueOnError: node.jobContinueOnError,
      })),
  );
}

/** Every trivy-action step in the workflow tree under `root`. */
const trivyInvocations = (root) => invocationsIn(readWorkflows(root));

/** What one invocation states about the gate, as a comparable object. */
const gateOf = (invocation) => ({
  ref: invocation.ref,
  inputs: Object.fromEntries(
    Object.entries(invocation.inputs)
      .filter(([key]) => !PER_SITE_INPUTS.has(key))
      .sort(([first], [second]) => (first < second ? -1 : 1)),
  ),
});

/** A failure key as the file writes it, or null where it is unset. */
const asWritten = (value) =>
  value === null || value === undefined ? null : String(value).trim();

/** Whether a `continue-on-error:` value leaves a failure able to fail the run. */
const leavesFailuresEnforced = (value) => {
  const written = asWritten(value);
  return written === null || written === "false";
};

/** Whether a finding at this invocation fails the workflow it runs in. */
const failsTheWorkflow = (invocation) =>
  leavesFailuresEnforced(invocation.continueOnError) &&
  leavesFailuresEnforced(invocation.jobContinueOnError);

/** When an invocation runs at all, as far as the file says. */
const runsWhen = (invocation) =>
  invocation.condition === null
    ? "on every run of its job"
    : "under a condition";

/** The keys deciding what a finding at one site reaches, as written. */
const failureControlsOf = (entry) => ({
  condition: asWritten(entry.condition),
  continueOnError: asWritten(entry.continueOnError),
  jobContinueOnError: asWritten(entry.jobContinueOnError),
});

const CONTROL_KEYS = {
  condition: "if",
  continueOnError: "continue-on-error",
  jobContinueOnError: "the job's continue-on-error",
};

const describeControls = (controls) =>
  Object.entries(controls)
    .map(
      ([key, value]) =>
        `${CONTROL_KEYS[key]} ${value === null ? "unset" : value}`,
    )
    .join(", ");

const sameControls = (first, second) =>
  Object.keys(first).every((key) => first[key] === second[key]);

/**
 * Which keys keep a report-only invocation's finding out of the run's result.
 * Both are named where both are set: dropping only the key a message states
 * leaves the invocation reporting under the other one.
 */
const reportsBecause = (invocation) =>
  [
    leavesFailuresEnforced(invocation.continueOnError)
      ? null
      : `it sets continue-on-error to ${asWritten(invocation.continueOnError)}`,
    leavesFailuresEnforced(invocation.jobContinueOnError)
      ? null
      : `its job sets continue-on-error to ${asWritten(invocation.jobContinueOnError)}`,
  ]
    .filter((cause) => cause !== null)
    .join(" and ");

/**
 * Every departure from one failure mode across `invocations`, as messages: an
 * entry in `records` the step it names does not match, a report-only
 * invocation no entry admits, and a difference in when two of them run.
 */
function failureModeProblems(invocations, records) {
  const problems = [];
  const bySite = new Map(
    invocations.map((invocation) => [invocation.site, invocation]),
  );

  for (const record of records) {
    const invocation = bySite.get(record.site);
    if (invocation === undefined) {
      problems.push(
        `RECORDED_FAILURE_MODES names ${record.site}, which matches no ${TRIVY_ACTION} step under .github/workflows. Point the entry at the step's file, job and id, or drop it with the step.`,
      );
      continue;
    }
    if ((asWritten(record.reason) ?? "") === "") {
      problems.push(
        `RECORDED_FAILURE_MODES admits ${record.site} without saying why. State what makes this invocation report-only and what ends that, so the entry can be retired by whoever ends it.`,
      );
    }
    const held = failureControlsOf(invocation);
    const recorded = failureControlsOf(record);
    if (!sameControls(recorded, held)) {
      problems.push(
        `${record.site} holds ${describeControls(held)} and RECORDED_FAILURE_MODES records it at ${describeControls(recorded)}, so the reason the entry states is not the one in force. Rewrite the entry against the step, or drop it where the step gates like the rest.`,
      );
    }
  }

  const compared = invocations.filter(
    ({ site }) => !records.some((record) => record.site === site),
  );
  for (const invocation of compared) {
    if (!failsTheWorkflow(invocation)) {
      problems.push(
        `${invocation.site} reports rather than gates, because ${reportsBecause(invocation)}, so a finding there cannot fail the workflow while its inputs hold it out as the same gate as the invocations that can. Drop the key, or record the site in RECORDED_FAILURE_MODES with what makes it report-only and what ends that.`,
      );
    }
  }

  const [first, ...rest] = compared;
  for (const invocation of rest) {
    if (runsWhen(invocation) !== runsWhen(first)) {
      problems.push(
        `${invocation.site} runs ${runsWhen(invocation)} and ${first.site} runs ${runsWhen(first)}, so the two do not answer for the same runs and the threshold they share is enforced on different ones. Give them the same condition, or record the difference in RECORDED_FAILURE_MODES with the reason.`,
      );
    }
  }

  return problems;
}

/** One synthetic job running the scanner, with the entry's keys written in. */
const fixtureJob = (name, stepId, entry) => [
  `  ${name}:`,
  ...(entry.job ?? []).map((line) => `    ${line}`),
  "    steps:",
  `      - id: ${stepId}`,
  ...(entry.step ?? []).map((line) => `        ${line}`),
  `        uses: ${TRIVY_ACTION}@v0.36.0`,
  "        with:",
  "          image-ref: example:latest",
  "          severity: HIGH,CRITICAL",
  '          exit-code: "1"',
];

/** Trivy invocations in one synthetic workflow per entry, for the cases below. */
const fixtureInvocations = (entries) =>
  invocationsIn(
    entries.map((entry, index) => ({
      path: `.github/workflows/fixture-${index}.yaml`,
      source: ["jobs:", ...fixtureJob("scan", `scan_${index}`, entry)].join(
        "\n",
      ),
    })),
  );

const fixtureSite = (index) =>
  `.github/workflows/fixture-${index}.yaml scan scan_${index}`;

const SHARED_ID_FIXTURE = ".github/workflows/fixture-shared-id.yaml";

/**
 * Trivy invocations in one synthetic workflow whose jobs all give their step
 * the same id, which GitHub accepts: a step id is unique within its job only.
 */
const sharedStepIdInvocations = (entries) =>
  invocationsIn([
    {
      path: SHARED_ID_FIXTURE,
      source: [
        "jobs:",
        ...entries.flatMap((entry, index) =>
          fixtureJob(`job_${index}`, "scan", entry),
        ),
      ].join("\n"),
    },
  ]);

const sharedStepIdSite = (index) => `${SHARED_ID_FIXTURE} job_${index} scan`;

describe("the image vulnerability scan's threshold", () => {
  const invocations = trivyInvocations(repoRoot);

  it("is set by more than one invocation, so the comparison is not vacuous", () => {
    expect(
      invocations.map(({ site }) => site).length,
      `fewer than two ${TRIVY_ACTION} steps were found under .github/workflows, so this comparison holds nothing. Point it at the scan's new home, or drop it with the scan.`,
    ).toBeGreaterThan(1);
  });

  it("is written out at every invocation rather than left to a default", () => {
    for (const invocation of invocations) {
      const missing = REQUIRED_INPUTS.filter(
        (key) => !Object.hasOwn(invocation.inputs, key),
      );
      expect(
        missing,
        `${invocation.site} names no ${missing.join(", ")}, so the action's default decides what this gate accepts and no diff shows it. State every threshold input at the step.`,
      ).toEqual([]);
    }
  });

  it("is the same at every invocation", () => {
    const [first, ...rest] = invocations;
    for (const invocation of rest) {
      expect(
        gateOf(invocation),
        `${invocation.site} and ${first.site} run the image scan at different settings, so one gate accepts what the other refuses. Move both in the same change, or record the difference in PER_SITE_INPUTS here with the reason it says nothing about what the gate accepts.`,
      ).toEqual(gateOf(first));
    }
  });

  it("fails the workflow at every invocation, or records what stops it", () => {
    expect(failureModeProblems(invocations, RECORDED_FAILURE_MODES)).toEqual(
      [],
    );
  });
});

describe("the failure-mode comparison", () => {
  it("reads two invocations with no failure keys as answering for the same runs", () => {
    expect(failureModeProblems(fixtureInvocations([{}, {}]), [])).toEqual([]);
  });

  it("fails an invocation whose own continue-on-error keeps a finding out of the run", () => {
    expect(
      failureModeProblems(
        fixtureInvocations([{}, { step: ["continue-on-error: true"] }]),
        [],
      ),
    ).toEqual([
      expect.stringContaining(
        `${fixtureSite(1)} reports rather than gates, because it sets continue-on-error to true`,
      ),
    ]);
  });

  it("fails an invocation whose job's continue-on-error keeps a finding out of the run", () => {
    expect(
      failureModeProblems(
        fixtureInvocations([{}, { job: ["continue-on-error: true"] }]),
        [],
      ),
    ).toEqual([
      expect.stringContaining(
        `${fixtureSite(1)} reports rather than gates, because its job sets continue-on-error to true`,
      ),
    ]);
  });

  it("names both keys where the step and its job each keep a finding out of the run", () => {
    expect(
      failureModeProblems(
        fixtureInvocations([
          {},
          {
            job: ["continue-on-error: true"],
            step: ["continue-on-error: true"],
          },
        ]),
        [],
      ),
    ).toEqual([
      expect.stringContaining(
        `${fixtureSite(1)} reports rather than gates, because it sets continue-on-error to true and its job sets continue-on-error to true`,
      ),
    ]);
  });

  it("reads two jobs of one file sharing a step id as two invocations", () => {
    expect(
      failureModeProblems(
        sharedStepIdInvocations([
          { step: ["continue-on-error: true"] },
          { step: ["continue-on-error: true"] },
        ]),
        [
          {
            site: sharedStepIdSite(1),
            condition: null,
            continueOnError: "true",
            jobContinueOnError: null,
            reason: "Its base image has findings no pin movement clears.",
          },
        ],
      ),
    ).toEqual([
      expect.stringContaining(
        `${sharedStepIdSite(0)} reports rather than gates, because it sets continue-on-error to true`,
      ),
    ]);
  });

  it("fails an invocation running under a condition the others do not", () => {
    expect(
      failureModeProblems(
        fixtureInvocations([
          {},
          { step: ["if: ${{ github.event_name != 'pull_request' }}"] },
        ]),
        [],
      ),
    ).toEqual([
      expect.stringContaining(
        `${fixtureSite(1)} runs under a condition and ${fixtureSite(0)} runs on every run of its job`,
      ),
    ]);
  });

  it("admits a report-only invocation a record names with its reason", () => {
    expect(
      failureModeProblems(
        fixtureInvocations([{}, { step: ["continue-on-error: true"] }]),
        [
          {
            site: fixtureSite(1),
            condition: null,
            continueOnError: "true",
            jobContinueOnError: null,
            reason: "Its base image has findings no pin movement clears.",
          },
        ],
      ),
    ).toEqual([]);
  });

  it("fails a record that admits an invocation without saying why", () => {
    expect(
      failureModeProblems(
        fixtureInvocations([{}, { step: ["continue-on-error: true"] }]),
        [
          {
            site: fixtureSite(1),
            condition: null,
            continueOnError: "true",
            jobContinueOnError: null,
            reason: "  ",
          },
        ],
      ),
    ).toEqual([
      expect.stringContaining(
        `RECORDED_FAILURE_MODES admits ${fixtureSite(1)} without saying why`,
      ),
    ]);
  });

  it("fails a record the step it names does not match", () => {
    expect(
      failureModeProblems(fixtureInvocations([{}, {}]), [
        {
          site: fixtureSite(1),
          condition: null,
          continueOnError: "true",
          jobContinueOnError: null,
          reason: "Its base image has findings no pin movement clears.",
        },
      ]),
    ).toEqual([
      expect.stringContaining(
        `${fixtureSite(1)} holds if unset, continue-on-error unset, the job's continue-on-error unset and RECORDED_FAILURE_MODES records it at if unset, continue-on-error true, the job's continue-on-error unset`,
      ),
    ]);
  });

  it("fails a record naming a step the tree does not hold", () => {
    expect(
      failureModeProblems(fixtureInvocations([{}, {}]), [
        {
          site: fixtureSite(4),
          condition: null,
          continueOnError: "true",
          jobContinueOnError: null,
          reason: "Its base image has findings no pin movement clears.",
        },
      ]),
    ).toEqual([
      expect.stringContaining(
        `RECORDED_FAILURE_MODES names ${fixtureSite(4)}, which matches no ${TRIVY_ACTION} step`,
      ),
    ]);
  });
});
