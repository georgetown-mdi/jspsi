import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  VERIFIER_STDERR_LIMIT,
  checkProvenance,
  markerProblems,
  nonLookupFailure,
  readMarkerSource,
  resolveTarballName,
  verifierOutcome,
  verifyArgv,
} from "./verify-prebuild-provenance.mjs";

// What these cover, and what they do not, by design. They drive this repo's
// own wiring -- arming, the offline digest binding, argv construction, and how
// a failure propagates and is named -- across an injected verifier boundary.
// They do NOT model what `gh attestation verify` decides: reimplementing the
// verifier's semantics here would assert a prediction rather than an outcome.
// The live half is `npm run check:prebuild-provenance`, which drives the real
// tool against the vendored bytes in CI and locally.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ARMED = {
  attestation_expected: true,
  artifact: "openmined-psi.js-9.9.9.tgz",
  sha256: "a".repeat(64),
  producer_repository: "georgetown-mdi/OpenMinedPSI",
  signer_workflow:
    "georgetown-mdi/OpenMinedPSI/.github/workflows/native-prebuilds.yml",
  source_ref: "refs/heads/master",
  source_digest: "b".repeat(40),
};

const DISARMED = {
  attestation_expected: false,
  artifact: ARMED.artifact,
  sha256: ARMED.sha256,
  producer_repository: ARMED.producer_repository,
  signer_workflow: ARMED.signer_workflow,
};

const TARBALL_PATH = "lib/openmined-psi.js-9.9.9.tgz";

// Verbatim stderr from real `gh attestation verify` 2.98.0 runs, captured on
// 2026-08-24: an egress-fenced container for the two unreachable cases, a
// blob with no attestation for the completed lookup, an empty `GH_CONFIG_DIR`
// with no token for the missing credential, and a syntactically valid but
// unknown token for the rejected one. They are fixtures of what the tool said,
// not a model of what it decides; the live half stays
// `npm run check:prebuild-provenance`.
const VERIFIER_STDERR = {
  unreachableBundleHost: `
Error: failed to fetch bundle with URL: failed to fetch bundle with URL: request to fetch bundle from URL failed: Get "https://tmaproduction.blob.core.windows.net/attestations/1015612889/2026/08/24/42646518.json.sn?se=2026-08-24T20%3A00%3A30Z&sp=r&spr=https&sr=b&sv=2026-06-06": dial tcp 20.209.163.161:443: connect: no route to host
`,
  unreachableTrustRoot: `error creating Sigstore verifier: no valid Sigstore verifiers could be initialized
`,
  noAttestation: `
Error: HTTP 404: Not Found (https://api.github.com/repos/georgetown-mdi/OpenMinedPSI/attestations/sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03?per_page=30&predicate_type=https%3A%2F%2Fslsa.dev%2Fprovenance%2Fv1)
`,
  missingCredential: `To get started with GitHub CLI, please run:  gh auth login
Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.
`,
  rejectedCredential: `
Error: HTTP 401: Bad credentials (https://api.github.com/repos/georgetown-mdi/OpenMinedPSI/attestations/sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03?per_page=30&predicate_type=https%3A%2F%2Fslsa.dev%2Fprovenance%2Fv1)
`,
};

// The conclusion an operator must not read for an outage: it is a claim about
// the vendored bytes, and only a completed lookup earns it.
const TAMPERING_SHAPED =
  /carry no attestation|does not match the recorded identity/;

// Fails the test if the verifier is reached; every case that must not consult
// GitHub uses it, so "never called" is asserted rather than assumed.
const unreachableVerifier = () => {
  throw new Error("the verifier must not be reached");
};

function check(overrides = {}) {
  const {
    marker = DISARMED,
    digest = ARMED.sha256,
    tarballPath = TARBALL_PATH,
    runVerifier = unreachableVerifier,
    markerSource = marker === undefined ? undefined : JSON.stringify(marker),
  } = overrides;
  return checkProvenance({ tarballPath, digest, markerSource, runVerifier });
}

describe("resolveTarballName", () => {
  it("resolves the single vendored tarball", () => {
    expect(
      resolveTarballName([
        "openmined-psi.js-2.0.6-seclink.3.tgz",
        "openmined-psi.js-2.0.6-seclink.3.tgz.sha256",
        "openmined-psi.js-2.0.6-seclink.3.tgz.provenance.json",
      ]),
    ).toEqual({ name: "openmined-psi.js-2.0.6-seclink.3.tgz" });
  });

  it("refuses an empty lib/ rather than passing with nothing checked", () => {
    expect(resolveTarballName([]).problem).toMatch(/no vendored prebuild/);
  });

  it("refuses two tarballs rather than picking one", () => {
    const { problem } = resolveTarballName([
      "openmined-psi.js-1.tgz",
      "openmined-psi.js-2.tgz",
    ]);
    expect(problem).toMatch(/found 2/);
  });

  // The name reaches the verifier's argv as the path being verified, so it is
  // held to the whitespace-free class the free-text marker fields are, for the
  // same reason: every marker the failure-cause recognizer holds contains a
  // space.
  it.each([
    ["openmined-psi.js-2.0.6-seclink.3.tgz"],
    ["openmined-psi.js-9.9.9.tgz"],
    ["openmined-psi.js-2.0.6_rc1.tgz"],
  ])("accepts %s as the vendored name", (name) => {
    expect(resolveTarballName([name])).toEqual({ name });
  });

  it.each([
    ["a recognizer marker", "openmined-psi.js-no route to host.tgz"],
    ["a space", "openmined-psi.js-2.0.6 seclink.3.tgz"],
    ["a tab", "openmined-psi.js-2.0.6\tHTTP 401.tgz"],
    ["a newline", "openmined-psi.js-2.0.6\ndial tcp.tgz"],
  ])("refuses a tarball name containing %s", (_, name) => {
    expect(resolveTarballName([name]).problem).toMatch(/no vendored prebuild/);
  });
});

describe("marker shape", () => {
  it("accepts the armed and disarmed shapes", () => {
    expect(markerProblems(ARMED)).toEqual([]);
    expect(markerProblems(DISARMED)).toEqual([]);
  });

  it("requires the source commit once armed", () => {
    const { source_ref, source_digest, ...withoutSource } = ARMED;
    expect(source_ref).toBeDefined();
    expect(source_digest).toBeDefined();
    const problems = markerProblems(withoutSource);
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toMatch(/source_ref/);
    expect(problems.join("\n")).toMatch(/source_digest/);
  });

  it("does not require the source commit while disarmed", () => {
    expect(markerProblems({ ...DISARMED })).toEqual([]);
  });

  it.each([
    ["attestation_expected", "yes"],
    ["sha256", "A".repeat(64)],
    ["sha256", "abc"],
    ["producer_repository", "OpenMinedPSI"],
    ["signer_workflow", "georgetown-mdi/OpenMinedPSI"],
    [
      "signer_workflow",
      "georgetown-mdi/OpenMinedPSI/.github/workflows/no route to host.yml",
    ],
    ["source_digest", "not-a-commit"],
    ["artifact", ""],
  ])("rejects a bad %s", (field, value) => {
    expect(markerProblems({ ...ARMED, [field]: value })).not.toEqual([]);
  });

  it("rejects a marker that is not an object", () => {
    expect(markerProblems([])).toEqual(["the marker is not a JSON object"]);
    expect(markerProblems(null)).toEqual(["the marker is not a JSON object"]);
  });

  // `source_ref` and `signer_workflow` are the marker fields that reach `gh`'s
  // argv as free text, and the failure-cause recognizer reads the verifier's
  // stderr by substring -- a stream `gh`'s measured 401 and 404 renderings echo
  // argv-derived values into. Constraining their syntax is what keeps the
  // marker file from choosing which cause the operator is told.
  it.each([["refs/heads/master"], ["refs/tags/v2.0.6"], ["master"], ["v1.0"]])(
    "accepts %s as a source ref",
    (source_ref) => {
      expect(markerProblems({ ...ARMED, source_ref })).toEqual([]);
    },
  );

  it.each([
    ["a recognizer marker", "refs/heads/no route to host"],
    ["a leading space", " refs/heads/master"],
    ["a newline", "refs/heads/master\ndial tcp"],
    ["a tab", "refs/heads/master\tHTTP 401"],
    ["nothing", ""],
    ["a non-string", 7],
  ])("refuses a source ref containing %s", (_, source_ref) => {
    expect(markerProblems({ ...ARMED, source_ref }).join("\n")).toMatch(
      /source_ref/,
    );
  });

  it("refuses a marker-bearing source ref before the verifier is reached", () => {
    const result = check({
      marker: { ...ARMED, source_ref: "refs/heads/no route to host" },
      runVerifier: unreachableVerifier,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/source_ref/);
  });
});

describe("arming", () => {
  it("passes without consulting the verifier while disarmed", () => {
    const result = check();
    expect(result.ok).toBe(true);
    expect(result.armed).toBe(false);
    expect(result.notes.join("\n")).toMatch(/not armed/);
  });

  it("consults the verifier once armed, and passes on a zero exit", () => {
    const calls = [];
    const result = check({
      marker: ARMED,
      runVerifier: (argv) => {
        calls.push(argv);
        return { status: 0 };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.armed).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("propagates a non-zero verifier exit as a failure", () => {
    const result = check({ marker: ARMED, runVerifier: () => ({ status: 1 }) });
    expect(result.ok).toBe(false);
    expect(result.armed).toBe(true);
    expect(result.problems.join("\n")).toMatch(/exited 1/);
  });

  it("treats an unavailable verifier as a failure, not a skip", () => {
    // An armed check must not pass because the tool it depends on is absent.
    const result = check({
      marker: ARMED,
      runVerifier: () => ({ spawnError: "spawnSync gh ENOENT" }),
    });
    expect(result.ok).toBe(false);
  });
});

describe("what a verifier failure is reported as", () => {
  const failure = (outcome) =>
    check({ marker: ARMED, runVerifier: () => outcome }).problems.join("\n");

  it("names an unrunnable verifier rather than concluding anything about the bytes", () => {
    const problem = failure({ spawnError: "spawnSync gh ENOENT" });
    expect(problem).toMatch(/could not be run: spawnSync gh ENOENT/);
    expect(problem).toMatch(/lookup never happened/);
    expect(problem).not.toMatch(TAMPERING_SHAPED);
  });

  it("names the signal a killed verifier died of", () => {
    const problem = failure({ status: null, signal: "SIGKILL", stderr: "" });
    expect(problem).toMatch(/terminated by SIGKILL/);
    expect(problem).toMatch(/nothing was verified/);
    expect(problem).not.toMatch(TAMPERING_SHAPED);
  });

  it("names the signal even when the killed run had written a completed lookup's output", () => {
    // A signal ends a run before it reaches a conclusion, whatever it wrote on
    // the way, so its output is not the lookup's answer and neither is the
    // exit status a killed run does not have.
    const problem = failure({
      status: null,
      signal: "SIGKILL",
      stderr: VERIFIER_STDERR.noAttestation,
    });
    expect(problem).toMatch(/terminated by SIGKILL/);
    expect(problem).not.toMatch(TAMPERING_SHAPED);
  });

  it("refuses a zero exit that arrived alongside a termination signal", () => {
    const result = check({
      marker: ARMED,
      runVerifier: () => ({ status: 0, signal: "SIGTERM", stderr: "" }),
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/terminated by SIGTERM/);
  });

  it("names an unreachable Sigstore blob host as a network failure", () => {
    const problem = failure({
      status: 1,
      stderr: VERIFIER_STDERR.unreachableBundleHost,
    });
    expect(problem).toMatch(/exited 1/);
    expect(problem).toMatch(/network failure/);
    expect(problem).not.toMatch(TAMPERING_SHAPED);
  });

  it("names an unreachable trust root as a network failure", () => {
    // This one is the reason the recognizer reads gh's own wording and not
    // only the Go transport strings: the fetch that fails is the TUF trust
    // root, and the message it shows contains no network words at all.
    const problem = failure({
      status: 1,
      stderr: VERIFIER_STDERR.unreachableTrustRoot,
    });
    expect(problem).toMatch(/network failure/);
    expect(problem).not.toMatch(TAMPERING_SHAPED);
  });

  it.each([
    ["missing", VERIFIER_STDERR.missingCredential, 4],
    ["rejected", VERIFIER_STDERR.rejectedCredential, 1],
  ])("names a %s credential as a credential failure", (_, stderr, status) => {
    const problem = failure({ status, stderr });
    expect(problem).toMatch(/missing or rejected GitHub credential/);
    expect(problem).not.toMatch(TAMPERING_SHAPED);
  });

  it("keeps the no-attestation conclusion for a lookup that completed", () => {
    const problem = failure({
      status: 1,
      stderr: VERIFIER_STDERR.noAttestation,
    });
    expect(problem).toMatch(TAMPERING_SHAPED);
    expect(problem).toMatch(ARMED.producer_repository);
    expect(problem).toMatch(ARMED.source_digest);
  });

  it("falls back to that conclusion for a shape it does not recognize", () => {
    // The recognizer is best effort, so this is the stated limit rather than a
    // desired outcome: an unrecognized cause is reported as the lookup's own
    // answer. The direction it fails in is what matters, asserted below.
    const problem = failure({ status: 1, stderr: "Error: something new\n" });
    expect(problem).toMatch(TAMPERING_SHAPED);
  });

  it("fails closed whatever the cause", () => {
    const outcomes = [
      { spawnError: "spawnSync gh ENOENT" },
      ...Object.values(VERIFIER_STDERR).map((stderr) => ({
        status: 1,
        stderr,
      })),
      { status: 1, stderr: "Error: something new\n" },
      { status: 1 },
      { status: null, signal: "SIGKILL", stderr: "" },
      {
        status: null,
        signal: "SIGTERM",
        stderr: VERIFIER_STDERR.noAttestation,
      },
      { status: 0, signal: "SIGTERM", stderr: "" },
      { status: 0, signal: null, stderr: "", runError: "ENOBUFS" },
      {
        status: 1,
        stderr: VERIFIER_STDERR.noAttestation,
        runError: "ENOBUFS",
      },
    ];
    for (const outcome of outcomes) {
      const result = check({ marker: ARMED, runVerifier: () => outcome });
      expect(result.ok).toBe(false);
      expect(result.armed).toBe(true);
      expect(result.problems).toHaveLength(1);
    }
  });

  it.each([
    ["a bare exit status", 0],
    ["a bare non-zero status", 1],
    ["nothing at all", undefined],
    ["an outcome containing none of the fields", {}],
    ["an outcome whose fields are all null", { status: null, signal: null }],
  ])("refuses to read %s as a verified artifact", (_, outcome) => {
    // The verifier contract is an object; a caller still returning the older
    // bare status would destructure to `status: undefined`, which is treated as a
    // clean exit unless this branch catches it first.
    const result = check({ marker: ARMED, runVerifier: () => outcome });
    expect(result.ok).toBe(false);
    expect(result.armed).toBe(true);
    expect(result.problems.join("\n")).toMatch(
      /no exit status, no termination signal, and no spawn failure/,
    );
  });

  it("quotes the marker it matched so the operator can judge the call", () => {
    expect(nonLookupFailure(VERIFIER_STDERR.unreachableBundleHost)).toContain(
      "`failed to fetch bundle`",
    );
    expect(nonLookupFailure(VERIFIER_STDERR.rejectedCredential)).toContain(
      "`HTTP 401`",
    );
    expect(nonLookupFailure(VERIFIER_STDERR.noAttestation)).toBeUndefined();
  });
});

describe("reading a spawnSync result as a verifier outcome", () => {
  // Driven against real `spawnSync` results, not hand-built ones: what the
  // runtime reports for a killed run or one that overran `maxBuffer` is its
  // behavior to state, and a fixture of it would assert a prediction. `gh`
  // itself is still out of scope here -- these stand in for any child.
  const runChild = (source, options = {}) =>
    spawnSync(process.execPath, ["-e", source], {
      encoding: "utf8",
      stdio: ["inherit", "inherit", "pipe"],
      ...options,
    });

  // Writes through fd 2 rather than `process.stderr`, whose buffered writes an
  // immediate exit would drop before the parent captures anything.
  const floodStderr = (chunks) =>
    `const { writeSync } = require("fs"); for (let i = 0; i < ${chunks}; i++) writeSync(2, "x".repeat(65536));`;

  // The same flood from a child that survives the SIGTERM spawnSync sends on an
  // overrun and swallows the EPIPE behind it, so it reaches its own exit. What
  // spawnSync reports for that is the runtime's behavior to measure, not to
  // predict: the two cases below are what it gives, over an ordinary child
  // rather than `gh`.
  const floodPastKill = (chunks, exitCode) =>
    `const { writeSync } = require("fs"); process.on("SIGTERM", () => {}); for (let i = 0; i < ${chunks}; i++) { try { writeSync(2, "x".repeat(65536)); } catch {} } process.exit(${exitCode});`;

  const outcomeOf = (run) => {
    const written = [];
    const outcome = verifierOutcome(run, (text) => written.push(text));
    return { outcome, written: written.join("") };
  };

  it("reads an absent binary as a spawn failure, with nothing to write", () => {
    const { outcome, written } = outcomeOf(
      spawnSync("gh-this-binary-is-not-installed", ["attestation", "verify"], {
        encoding: "utf8",
        stdio: ["inherit", "inherit", "pipe"],
      }),
    );
    expect(outcome.spawnError).toMatch(/ENOENT/);
    expect(written).toBe("");
  });

  it("reads a non-zero exit as that status, and writes what the run said", () => {
    const { outcome, written } = outcomeOf(
      runChild(
        'process.stderr.write("Error: HTTP 404\\n"); process.exitCode = 1',
      ),
    );
    expect(outcome.spawnError).toBeUndefined();
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toBe("Error: HTTP 404\n");
    expect(written).toBe("Error: HTTP 404\n");
  });

  it("reads a signal-killed run as its signal rather than a spawn failure", () => {
    const { outcome } = outcomeOf(
      runChild(
        'const { writeSync } = require("fs"); writeSync(2, "dying\\n"); process.kill(process.pid, "SIGKILL");',
      ),
    );
    expect(outcome.spawnError).toBeUndefined();
    expect(outcome.status).toBeNull();
    expect(outcome.signal).toBe("SIGKILL");
    expect(outcome.stderr).toBe("dying\n");
  });

  it("keeps the captured stderr of a run that overran maxBuffer", () => {
    // spawnSync reports an overrun by killing the child, so its error arrives
    // alongside a signal and with bytes already captured. Reading that error
    // as an unrunnable binary would discard every one of them and name a
    // cause -- an absent `gh` -- that is not what happened.
    const { outcome, written } = outcomeOf(
      runChild(floodStderr(8), { maxBuffer: 64 * 1024 }),
    );
    expect(outcome.spawnError).toBeUndefined();
    expect(outcome.signal).toBe("SIGTERM");
    expect(outcome.runError).toBe("ENOBUFS");
    expect(outcome.stderr.length).toBeGreaterThan(0);
    expect(written).toBe(outcome.stderr);

    const problem = check({
      marker: ARMED,
      runVerifier: () => outcome,
    }).problems.join("\n");
    expect(problem).toMatch(/ended in ENOBUFS/);
    expect(problem).not.toMatch(TAMPERING_SHAPED);
  });

  it("refuses an overrun that reached a zero exit of its own", () => {
    // The shape that makes dropping the error a hole rather than a misnaming:
    // a status of 0, no signal, and a verdict nothing read. An armed gate
    // taking this for a clean exit reports the artifact verified.
    const { outcome } = outcomeOf(
      runChild(floodPastKill(8, 0), { maxBuffer: 64 * 1024 }),
    );
    expect(outcome.spawnError).toBeUndefined();
    expect(outcome.status).toBe(0);
    expect(outcome.signal).toBeNull();
    expect(outcome.runError).toBe("ENOBUFS");

    const result = check({ marker: ARMED, runVerifier: () => outcome });
    expect(result.ok).toBe(false);
    expect(result.armed).toBe(true);
    expect(result.problems.join("\n")).toMatch(/ended in ENOBUFS/);
    expect(result.problems.join("\n")).not.toMatch(TAMPERING_SHAPED);
  });

  it("names the truncation rather than tampering for an overrun that exited non-zero", () => {
    const { outcome } = outcomeOf(
      runChild(floodPastKill(8, 1), { maxBuffer: 64 * 1024 }),
    );
    expect(outcome.status).toBe(1);
    expect(outcome.runError).toBe("ENOBUFS");

    const problem = check({
      marker: ARMED,
      runVerifier: () => outcome,
    }).problems.join("\n");
    expect(problem).toMatch(/ended in ENOBUFS/);
    expect(problem).toMatch(/stderr capture limit/);
    expect(problem).not.toMatch(TAMPERING_SHAPED);
  });

  it("holds a multi-megabyte diagnostic stream at the configured ceiling", () => {
    // The ceiling is what keeps a verbose but complete run from arriving as
    // the killed shape above: at spawnSync's own 1 MB default this stream is
    // an ENOBUFS kill.
    const { outcome } = outcomeOf(
      runChild(floodStderr(32), { maxBuffer: VERIFIER_STDERR_LIMIT }),
    );
    expect(outcome.spawnError).toBeUndefined();
    expect(outcome.signal).toBeNull();
    expect(outcome.status).toBe(0);
    expect(outcome.runError).toBeUndefined();
    expect(outcome.stderr).toHaveLength(32 * 65536);
  });

  it("hands a killed run to the decision as a named signal, not a verdict", () => {
    const outcome = verifierOutcome(
      runChild(
        'const { writeSync } = require("fs"); writeSync(2, "dying\\n"); process.kill(process.pid, "SIGKILL");',
      ),
      () => {},
    );
    const result = check({ marker: ARMED, runVerifier: () => outcome });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/terminated by SIGKILL/);
    expect(result.problems.join("\n")).not.toMatch(TAMPERING_SHAPED);
  });
});

describe("what a failing check delivers through a pipe", () => {
  // Driven as the real script against a stub `gh`, because what survives a
  // failure is a property of how the process ends and no import reaches that.
  // A CI step's stderr is a pipe, whose writer queues in the process once the
  // kernel buffer is full, so a check that exits the instant it has written
  // its report delivers part of the verifier's flood and drops the report --
  // the one part of the stream an unattended log needed.
  const CHECK = join(root, "scripts", "verify-prebuild-provenance.mjs");

  // A repeated distinctive line rather than filler bytes: the check's own
  // report contains letters filler would collide with, and the count has to be
  // exact to say how much of the verifier's stream arrived.
  const FLOOD_LINE = "psilink-verifier-flood\n";
  const FLOOD_LINES = 12_000;

  const stubDirs = [];
  afterAll(() => {
    for (const dir of stubDirs) rmSync(dir, { recursive: true, force: true });
  });

  // The stub writes fd 2 to completion and sets `process.exitCode` rather than
  // exiting, so nothing is lost on its own way out and the only delivery under
  // test is the check's.
  const runCheckAgainstStubGh = (floodLines) => {
    const dir = mkdtempSync(join(tmpdir(), "psilink-provenance-gh-"));
    stubDirs.push(dir);

    const stubSource = join(dir, "gh-stub.cjs");
    writeFileSync(
      stubSource,
      `const { writeSync } = require("node:fs");
const payload = Buffer.from(
  ${JSON.stringify(FLOOD_LINE)}.repeat(${floodLines}) +
    ${JSON.stringify(VERIFIER_STDERR.unreachableBundleHost)},
);
let written = 0;
while (written < payload.length) written += writeSync(2, payload, written);
process.exitCode = 1;
`,
    );

    const stub = join(dir, "gh");
    writeFileSync(
      stub,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stubSource)}\n`,
    );
    chmodSync(stub, 0o755);

    return spawnSync(process.execPath, [CHECK], {
      cwd: root,
      encoding: "utf8",
      stdio: ["inherit", "inherit", "pipe"],
      maxBuffer: VERIFIER_STDERR_LIMIT,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
  };

  const floodLinesIn = (stderr) => stderr.split(FLOOD_LINE).length - 1;

  it("delivers its report behind a verifier stream far past the pipe buffer", () => {
    const run = runCheckAgainstStubGh(FLOOD_LINES);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Prebuild provenance check failed");
    expect(run.stderr).toContain("`failed to fetch bundle`");
    expect(run.stderr).toMatch(/network failure/);
    // Counted, not sampled: truncation keeps the head of the stream, so a
    // substring assertion on the verifier's words passes on a stream that lost
    // everything the check itself wrote.
    expect(floodLinesIn(run.stderr)).toBe(FLOOD_LINES);
    // The verifier's own words above, the check's report below -- the order
    // the runbook and the spec state, and the direction truncation eats.
    expect(run.stderr.indexOf("failed to fetch bundle with URL")).toBeLessThan(
      run.stderr.indexOf("Prebuild provenance check failed"),
    );
  });

  it("delivers the same report for a stream that fits the pipe buffer", () => {
    const run = runCheckAgainstStubGh(4);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Prebuild provenance check failed");
    expect(run.stderr).toMatch(/network failure/);
    expect(floodLinesIn(run.stderr)).toBe(4);
  });
});

describe("the offline binding between the marker and the bytes", () => {
  it("fails on a digest mismatch while disarmed", () => {
    const result = check({ digest: "c".repeat(64) });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/hashes to c{64}/);
  });

  it("fails on a digest mismatch while armed, before reaching the verifier", () => {
    const result = check({
      marker: ARMED,
      digest: "c".repeat(64),
      runVerifier: unreachableVerifier,
    });
    expect(result.ok).toBe(false);
  });

  it("fails when the marker names a different artifact", () => {
    const result = check({ tarballPath: "lib/openmined-psi.js-8.8.8.tgz" });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/8\.8\.8/);
  });

  it("fails on a missing marker rather than falling back to sidecar-only", () => {
    // Called directly: the helper's defaults cannot express an absent marker.
    const result = checkProvenance({
      tarballPath: TARBALL_PATH,
      digest: ARMED.sha256,
      markerSource: undefined,
      runVerifier: unreachableVerifier,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/is missing/);
  });

  it("fails on a marker that is not JSON", () => {
    const result = check({ markerSource: "{ not json" });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/not valid JSON/);
  });

  it("fails on a disarmed marker with a malformed shape", () => {
    // The shape gate runs ahead of the arming branch: a disarmed marker still
    // fails on a bad field, rather than passing because attestation_expected
    // is false. Pins that ordering so a refactor moving the shape check inside
    // the armed branch goes red.
    const result = check({
      marker: { ...DISARMED, producer_repository: "OpenMinedPSI" },
    });
    expect(result.ok).toBe(false);
    expect(result.armed).toBe(false);
    expect(result.problems.join("\n")).toMatch(/producer_repository/);
  });
});

describe("reading the marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "psilink-provenance-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("returns the bytes of a marker that is there", () => {
    const path = join(dir, "present.provenance.json");
    writeFileSync(path, JSON.stringify(DISARMED));
    const { markerSource, problem } = readMarkerSource(path);
    expect(problem).toBeUndefined();
    expect(markerSource).toBe(JSON.stringify(DISARMED));
  });

  it("reports an absent marker as absence rather than a read failure", () => {
    const { markerSource, problem } = readMarkerSource(
      join(dir, "absent.provenance.json"),
    );
    expect(problem).toBeUndefined();
    expect(markerSource).toBeUndefined();
  });

  it("names the read error when a directory sits in the marker's place", () => {
    // Driven against the real filesystem rather than an injected error code, so
    // the reported cause is whatever this platform actually raises.
    const path = join(dir, "directory.provenance.json");
    mkdirSync(path);
    const { markerSource, problem } = readMarkerSource(path);
    expect(markerSource).toBeUndefined();
    expect(problem).toContain(path);
    expect(problem).toMatch(/could not be read/);
    expect(problem).not.toMatch(/is missing/);
  });

  it("does not report an unreadable marker as a missing one", () => {
    const { markerSource, problem } = readMarkerSource(
      TARBALL_PATH + ".provenance.json",
      () => {
        throw Object.assign(new Error("EACCES: permission denied, open"), {
          code: "EACCES",
        });
      },
    );
    expect(markerSource).toBeUndefined();
    expect(problem).toMatch(/EACCES: permission denied/);
    expect(problem).not.toMatch(/is missing/);
  });
});

describe("the verify argument vector", () => {
  it("pins the producer repository, signer workflow, and source commit", () => {
    const argv = verifyArgv(TARBALL_PATH, ARMED);
    expect(argv.slice(0, 3)).toEqual(["attestation", "verify", TARBALL_PATH]);
    const flag = (name) => argv[argv.indexOf(name) + 1];
    expect(flag("--repo")).toBe(ARMED.producer_repository);
    expect(flag("--signer-workflow")).toBe(ARMED.signer_workflow);
    expect(flag("--source-ref")).toBe(ARMED.source_ref);
    expect(flag("--source-digest")).toBe(ARMED.source_digest);
    expect(flag("--predicate-type")).toBe("https://slsa.dev/provenance/v1");
    expect(argv).toContain("--deny-self-hosted-runners");
  });

  it("names no flag `gh attestation verify` does not define", () => {
    // The defined set below is a second hand-written literal, not a read of
    // `gh attestation verify --help`: it catches a typo or an invented flag in
    // verifyArgv, but cannot notice gh renaming or removing a flag out from
    // under it. The real tool is what decides that, at each armed run or
    // re-vendor (docs/PREBUILD_REVENDOR.md, "First armed run").
    const defined = new Set([
      "--repo",
      "--signer-workflow",
      "--source-ref",
      "--source-digest",
      "--predicate-type",
      "--deny-self-hosted-runners",
    ]);
    for (const arg of verifyArgv(TARBALL_PATH, ARMED)) {
      if (arg.startsWith("--")) expect(defined).toContain(arg);
    }
  });
});

describe("the committed marker", () => {
  const libDir = join(root, "lib");
  const { name } = resolveTarballName(readdirSync(libDir));

  it("describes the tarball this repository actually vendors", () => {
    const digest = createHash("sha256")
      .update(readFileSync(join(libDir, name)))
      .digest("hex");
    // The committed marker is armed, so the decision reaches the verifier. It
    // is stubbed to a success exit rather than run: what belongs here is that
    // the marker's own fields build the invocation that names the fork, not a
    // second opinion on what `gh attestation verify` decides about them.
    const invocations = [];
    const result = checkProvenance({
      tarballPath: join("lib", name),
      digest,
      markerSource: readFileSync(
        join(libDir, name + ".provenance.json"),
        "utf8",
      ),
      runVerifier: (argv) => {
        invocations.push(argv);
        return { status: 0 };
      },
    });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.armed).toBe(true);
    expect(invocations).toHaveLength(1);
    const marker = JSON.parse(
      readFileSync(join(libDir, name + ".provenance.json"), "utf8"),
    );
    expect(invocations[0]).toEqual(verifyArgv(join("lib", name), marker));
  });

  it("agrees with the sha256 sidecar, which is the offline check", () => {
    const marker = JSON.parse(
      readFileSync(join(libDir, name + ".provenance.json"), "utf8"),
    );
    const sidecar = readFileSync(join(libDir, name + ".sha256"), "utf8");
    expect(sidecar.split(/\s+/)[0]).toBe(marker.sha256);
  });

  it("names the fork as producer, under the fork's native-prebuilds workflow", () => {
    const marker = JSON.parse(
      readFileSync(join(libDir, name + ".provenance.json"), "utf8"),
    );
    expect(marker.producer_repository).toBe("georgetown-mdi/OpenMinedPSI");
    expect(marker.signer_workflow).toBe(
      "georgetown-mdi/OpenMinedPSI/.github/workflows/native-prebuilds.yml",
    );
  });
});
