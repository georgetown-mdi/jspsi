#!/usr/bin/env node
// Build-provenance check for the vendored @openmined/psi.js prebuild tarball,
// run by .github/actions/setup ahead of `npm ci` and by release.yaml's publish
// job ahead of the shipped image build.
//
// The tarball contains native N-API .node prebuilds that are dlopen'd with full
// process privilege into the PSI crypto pipeline, and it is built in another
// repository (the fork's native-prebuilds.yml) and copied here by hand. The
// committed `.sha256` sidecar cannot close that hop: it is written in the same
// psilink commit as the bytes it describes, so a writer who controls lib/
// controls both. It detects a truncated checkout, a corrupt download, or a
// stale re-vendor -- accident and availability -- and it is the only check that
// works with no network, no token, and no extra tooling. Tamper resistance
// across the fork boundary needs a claim made outside any psilink commit, which
// is what a GitHub artifact attestation stored against the PRODUCING repository
// is; `gh attestation verify` is how this reads it.
//
// ARMING. Enforcement arms per artifact, because attestation coverage is a
// property of the run that packed a given tarball rather than of the fork: one
// packed by a run predating the producing workflow's attest step holds
// nothing to verify. The marker file beside the tarball
// (`<tarball>.provenance.json`) holds the switch:
//
//   attestation_expected: false -> report, warn, and pass. The sidecar is then
//     the whole control.
//   attestation_expected: true  -> run `gh attestation verify` against the
//     recorded producer identity and source commit, and fail on any non-zero
//     exit.
//
// The marker is NOT optional in either state. A missing or malformed marker
// fails, and its recorded digest is held against the tarball's real bytes in
// both states, offline. So the marker cannot be deleted to disarm the check,
// and it cannot describe bytes other than the ones vendored: re-pointing it at
// substituted bytes is what makes the armed attestation lookup fail, and the
// only remaining way out is flipping the boolean back to false -- a one-line
// diff in `lib/` that a reviewer reads, rather than a silent absence.
//
// What this check does NOT establish, and the runbook
// (docs/PREBUILD_REVENDOR.md) states as the reviewer's own step: that the
// attested build is correct. An attestation binds bytes to a workflow run in the
// producer repo; whether that run built what its source says is the fork's
// problem, not this one.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = "lib";
// The vendored tarball's name reaches the verifier's argv as the path it
// verifies, so it is held to the same whitespace-free class as the free-text
// marker fields, for the reason `markerProblems` records.
const TARBALL = /^openmined-psi\.js-[\w.-]+\.tgz$/;
const MARKER_SUFFIX = ".provenance.json";

// Pinned rather than left to `gh`'s default so a change to that default cannot
// silently widen what counts as a provenance claim.
const PREDICATE_TYPE = "https://slsa.dev/provenance/v1";

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_40 = /^[0-9a-f]{40}$/;
const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
const SIGNER_WORKFLOW = /^[\w.-]+\/[\w.-]+\/[\w./-]+\.ya?ml$/;
const GIT_REF = /^[\w./-]+$/;

/**
 * How much of the verifier's stderr `spawnSync` will hold. Above its ceiling
 * spawnSync kills the run, so this sits far above the few hundred bytes the
 * measured failures write: a verbose diagnostic stream is worth reading, not
 * worth turning a completed lookup into a killed one.
 */
export const VERIFIER_STDERR_LIMIT = 16 * 1024 * 1024;

/**
 * The single vendored tarball's filename, or a problem describing why there is
 * no single one. Exactly one is the assumption every call site's glob already
 * holds; two would make `sha256sum -c lib/*.tgz.sha256` ambiguous too.
 */
export function resolveTarballName(entries) {
  const found = entries.filter((name) => TARBALL.test(name));
  if (found.length === 1) return { name: found[0] };
  return {
    problem:
      found.length === 0
        ? `no vendored prebuild tarball in ${LIB_DIR}/ (expected one file matching ${TARBALL.source})`
        : `expected exactly one vendored prebuild tarball in ${LIB_DIR}/, found ${found.length}: ${found.join(", ")}`,
  };
}

/**
 * Shape violations in a parsed marker, as reader-facing lines. Every field is
 * checked in both arming states so a marker cannot be left half-written while
 * disarmed and then armed by a one-word edit that nothing re-reads.
 */
export function markerProblems(marker) {
  const problems = [];
  if (marker === null || typeof marker !== "object" || Array.isArray(marker)) {
    return ["the marker is not a JSON object"];
  }

  if (typeof marker.attestation_expected !== "boolean") {
    problems.push("`attestation_expected` must be present and a boolean");
  }
  if (typeof marker.artifact !== "string" || marker.artifact === "") {
    problems.push("`artifact` must be the vendored tarball's filename");
  }
  if (typeof marker.sha256 !== "string" || !HEX_64.test(marker.sha256)) {
    problems.push("`sha256` must be 64 lowercase hex characters");
  }
  if (
    typeof marker.producer_repository !== "string" ||
    !OWNER_REPO.test(marker.producer_repository)
  ) {
    problems.push("`producer_repository` must be in `<owner>/<repo>` form");
  }
  if (
    typeof marker.signer_workflow !== "string" ||
    !SIGNER_WORKFLOW.test(marker.signer_workflow)
  ) {
    problems.push(
      "`signer_workflow` must be `<owner>/<repo>/<path>/<to>/<workflow>.yml`",
    );
  }

  // `source_ref` reaches the verifier's argv as free text, and the
  // failure-cause recognizer reads the verifier's stderr by substring, so a
  // ref containing a recognizer marker (`refs/heads/no route to host`) would
  // rename an identity mismatch as an outage on any failure path that echoes
  // the ref back. Whether `gh` echoes this field on any such path is
  // unmeasured from here: driven with sentinel values, 2.98.0's 401 and 404
  // renderings echo the repository, the artifact digest, and the predicate
  // type, and none of the free-text fields. Holding the field to git-ref
  // characters is cheap fail-closed hygiene over a value `lib/` supplies,
  // not a measured exploit closure. Its syntax is checked wherever the field
  // appears; only arming requires it.
  if (
    marker.source_ref !== undefined &&
    (typeof marker.source_ref !== "string" || !GIT_REF.test(marker.source_ref))
  ) {
    problems.push(
      "`source_ref` must be a git ref written in `[A-Za-z0-9_./-]` characters, with no whitespace",
    );
  }

  // The source commit is what binds the attested build to reviewable fork
  // source, so arming without it is refused rather than silently verifying a
  // weaker identity than the docs claim.
  if (marker.attestation_expected === true) {
    if (marker.source_ref === undefined) {
      problems.push(
        "`source_ref` is required once `attestation_expected` is true (the fork ref the prebuild run built from)",
      );
    }
    if (
      typeof marker.source_digest !== "string" ||
      !HEX_40.test(marker.source_digest)
    ) {
      problems.push(
        "`source_digest` is required once `attestation_expected` is true, as the fork commit's 40 hex characters",
      );
    }
  }

  return problems;
}

/**
 * The `gh attestation verify` argument vector for an armed marker. Built here
 * rather than inline in a workflow so the identity the check enforces is one
 * reviewable value and is covered by a test.
 */
export function verifyArgv(tarballPath, marker) {
  return [
    "attestation",
    "verify",
    tarballPath,
    "--repo",
    marker.producer_repository,
    "--signer-workflow",
    marker.signer_workflow,
    "--source-ref",
    marker.source_ref,
    "--source-digest",
    marker.source_digest,
    "--predicate-type",
    PREDICATE_TYPE,
    // The fork builds every leg on GitHub-hosted runners, so an attestation
    // minted on a self-hosted one is not a build this repository expects.
    "--deny-self-hosted-runners",
  ];
}

// Verifier failures that are not the lookup's own answer, recognized by what
// the run wrote to stderr. Substrings rather than a parse: the point is to stop
// naming a tampering-shaped conclusion for an outage, not to reproduce `gh`'s
// error taxonomy.
//
// Each marker below was produced by driving `gh attestation verify` 2.98.0 and
// reading its stderr, except the four Go transport strings noted inline, which
// are the sibling errno and timeout renderings of the same `net/http` path the
// measured `dial tcp` line comes from. The list is a best-effort recognizer,
// not a partition: a shape it does not include falls through to the wording
// below, and every one of these branches fails the check either way.
const NON_LOOKUP_FAILURES = [
  {
    // A missing credential exits 4 with the login prompt; a rejected one comes
    // back as the API's own 401.
    markers: ["gh auth login", "HTTP 401"],
    describe: (marker) =>
      `before it could complete the attestation lookup: its output names a missing or rejected GitHub credential (\`${marker}\`). Authenticate \`gh\` or set \`GH_TOKEN\`, then re-run.`,
  },
  {
    markers: [
      // The trust root is fetched from the TUF CDN before any lookup runs, and
      // a host fenced from it gets no network wording at all. This is the
      // measured rendering of that failure and not its only one: `gh` renders
      // it more than one way, and the others fall through to the fallback.
      "no valid Sigstore verifiers could be initialized",
      // The Sigstore bundle is fetched from a blob host that is neither
      // api.github.com nor the TUF CDN.
      "failed to fetch bundle",
      "dial tcp",
      "no route to host",
      // Go transport renderings the measured `dial tcp` line does not include.
      "no such host",
      "i/o timeout",
      "TLS handshake timeout",
      "context deadline exceeded",
    ],
    describe: (marker) =>
      `before it could complete the attestation lookup: its output names a network failure (\`${marker}\`). Verification reaches api.github.com, the Sigstore bundle's blob host, and the TUF CDN, so a host fenced from any of them fails here whatever the attestation says. Re-run where that egress exists, or read CI's own run of this check (docs/PREBUILD_REVENDOR.md).`,
  },
];

/**
 * How a failing verifier run says the attestation lookup never completed, or
 * `undefined` when nothing in its output says so and the exit is read as the
 * lookup's own answer. Recognition is best effort: see `NON_LOOKUP_FAILURES`.
 */
export function nonLookupFailure(stderr) {
  for (const { markers, describe } of NON_LOOKUP_FAILURES) {
    const marker = markers.find((candidate) => stderr.includes(candidate));
    if (marker !== undefined) return describe(marker);
  }
  return undefined;
}

/**
 * The marker's bytes when it is there, `{ markerSource: undefined }` when it is
 * absent, and a problem when it exists but cannot be read. An unreadable marker
 * -- a permission error, a directory in its place -- is reported as itself
 * rather than folded into the missing-marker report, which would name the wrong
 * cause; both still fail the check. `readFile` is what a test replaces.
 */
export function readMarkerSource(markerPath, readFile = readFileSync) {
  try {
    return { markerSource: readFile(markerPath, "utf8") };
  } catch (error) {
    if (error?.code === "ENOENT") return { markerSource: undefined };
    return {
      problem: `${markerPath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * A `spawnSync` result read as a verifier outcome, and the captured stderr
 * written back out so the operator still reads the verifier's own words.
 *
 * A `spawnSync` error is only a spawn failure when the process never ran, which
 * is an error that has neither an exit status nor a termination signal.
 * Reporting any other error as an absent `gh` would name the wrong cause and
 * discard what the run said. An error alongside a status or a signal describes
 * a run that DID happen and was cut short, so it is kept as `runError`
 * for the decision to refuse rather than dropped: an overrun of `maxBuffer`
 * comes back as `ENOBUFS`, under the `SIGTERM` `spawnSync` sends for it, or --
 * measured against a child that survives that signal and swallows the `EPIPE`
 * behind it -- under an exit status of the child's own, zero included.
 * `writeStderr` is what a test replaces.
 */
export function verifierOutcome(run, writeStderr) {
  const stderr = typeof run.stderr === "string" ? run.stderr : "";
  if (stderr !== "") writeStderr(stderr);

  const ran = typeof run.status === "number" || typeof run.signal === "string";
  if (run.error !== undefined && !ran) {
    return { spawnError: run.error.message };
  }
  return {
    status: run.status,
    signal: run.signal,
    stderr,
    runError:
      run.error === undefined
        ? undefined
        : (run.error.code ?? run.error.message),
  };
}

/**
 * The whole decision, with the bytes and the verifier handed in so a test can
 * drive every branch without a 16 MB fixture or a live GitHub lookup.
 *
 * `runVerifier(argv)` returns `{ status, signal, stderr, runError }` -- the
 * verifier's exit status, falsy for success, the signal that terminated it if
 * one did, whatever it wrote to stderr, and the error a run cut short ended in
 * -- or `{ spawnError }` when the verifier could not be started at all. It is
 * only called once the offline checks have all passed.
 *
 * Returns `{ ok, armed, problems, notes }`.
 */
export function checkProvenance({
  tarballPath,
  digest,
  markerSource,
  runVerifier,
}) {
  const markerPath = tarballPath + MARKER_SUFFIX;
  const fail = (...problems) => ({
    ok: false,
    armed: false,
    problems,
    notes: [],
  });

  if (markerSource === undefined) {
    return fail(
      `${markerPath} is missing. Every vendored prebuild carries a provenance marker, disarmed or armed; see docs/PREBUILD_REVENDOR.md.`,
    );
  }

  let marker;
  try {
    marker = JSON.parse(markerSource);
  } catch (error) {
    return fail(
      `${markerPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const shape = markerProblems(marker);
  if (shape.length > 0) {
    return fail(...shape.map((problem) => `${markerPath}: ${problem}`));
  }

  const problems = [];
  const artifact = basename(tarballPath);
  if (marker.artifact !== artifact) {
    problems.push(
      `${markerPath} describes \`${marker.artifact}\` but the vendored tarball is \`${artifact}\`.`,
    );
  }
  // The offline half of the tamper check, and the reason the marker cannot be
  // re-pointed at substituted bytes without saying so.
  if (marker.sha256 !== digest) {
    problems.push(
      `${markerPath} records sha256 ${marker.sha256} but ${artifact} hashes to ${digest}.`,
    );
  }
  if (problems.length > 0) {
    return {
      ok: false,
      armed: marker.attestation_expected,
      problems,
      notes: [],
    };
  }

  if (marker.attestation_expected !== true) {
    return {
      ok: true,
      armed: false,
      problems: [],
      notes: [
        `Provenance verification is not armed: ${markerPath} sets \`attestation_expected: false\`, so ${artifact} is covered by its sha256 sidecar alone. Arm it at the next re-vendor (docs/PREBUILD_REVENDOR.md).`,
      ],
    };
  }

  const argv = verifyArgv(tarballPath, marker);
  const invocation = `\`gh ${argv.join(" ")}\``;
  const outcome = runVerifier(argv) ?? {};
  const { status, signal, spawnError, runError } = outcome;
  const stderr = typeof outcome.stderr === "string" ? outcome.stderr : "";
  const unverified = (problem) => ({
    ok: false,
    armed: true,
    problems: [problem],
    notes: [],
  });

  // Ahead of every branch that reads a status, a signal, or the run's output:
  // an error is the run being cut short, so what it exited with and what it
  // wrote are both fragments of a lookup that never reached its verdict.
  if (runError !== undefined) {
    return unverified(
      `${invocation} ended in ${runError} before its verdict could be read, so nothing was verified about ${artifact}. Neither its exit nor its output is the lookup's answer; \`ENOBUFS\` in particular is its output overrunning this check's stderr capture limit. Whatever it wrote before it ended is above. Re-run where it can finish, or read CI's own run of this check (docs/PREBUILD_REVENDOR.md).`,
    );
  }

  // Success is a reported zero, never an unreported anything: a verifier
  // handing back a bare status leaves `status` undefined here, which would
  // otherwise be indistinguishable from a clean exit.
  if (
    spawnError === undefined &&
    typeof status !== "number" &&
    typeof signal !== "string"
  ) {
    return unverified(
      `${invocation} reported no exit status, no termination signal, and no spawn failure, so nothing was verified about ${artifact}.`,
    );
  }

  // A cause that is not the lookup's own answer is named as itself. The
  // no-attestation conclusion below is a claim about the bytes, and reporting
  // it for an unrunnable `gh`, a killed run, a run cut short, or a fenced host
  // treats an outage as tampering.
  if (spawnError !== undefined) {
    return unverified(
      `${invocation} could not be run: ${spawnError}. The attestation lookup never happened, so this is an absent or unrunnable \`gh\` rather than anything about ${artifact}. Install \`gh\` and re-run, or read CI's own run of this check (docs/PREBUILD_REVENDOR.md).`,
    );
  }
  // Ahead of the status branch, and reached whatever the exit status says: a
  // run that a signal ended never reached a conclusion to report, so its
  // status is not the lookup's answer.
  if (typeof signal === "string") {
    return unverified(
      `${invocation} was terminated by ${signal} before it could complete the attestation lookup, so nothing was verified about ${artifact}. Whatever the run wrote before it died is above. Re-run where it can finish, or read CI's own run of this check (docs/PREBUILD_REVENDOR.md).`,
    );
  }
  if (status) {
    const nonLookup = nonLookupFailure(stderr);
    return unverified(
      nonLookup === undefined
        ? `${invocation} exited ${status}. The vendored bytes carry no attestation from ${marker.producer_repository} at ${marker.source_digest}, or the attestation does not match the recorded identity.`
        : `${invocation} exited ${status} ${nonLookup}`,
    );
  }

  return {
    ok: true,
    armed: true,
    problems: [],
    notes: [
      `${artifact} verified against an attestation from ${marker.signer_workflow} at ${marker.source_digest}.`,
    ],
  };
}

// The check as the CLI runs it. Every failure sets `process.exitCode` and
// returns rather than calling `process.exit`, which abandons whatever stderr
// has not drained yet: past a pipe's buffer -- and a CI step is a pipe -- what
// it abandons is the verifier's stderr AND the report below it, leaving an
// unattended run with a red status and none of the cause this check exists to
// name. The piped-delivery test beside this file is what holds it.
function runCheck() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const libDir = join(root, LIB_DIR);

  const resolved = resolveTarballName(readdirSync(libDir));
  if (resolved.problem !== undefined) {
    console.error(`Prebuild provenance check failed:\n\n  ${resolved.problem}`);
    process.exitCode = 1;
    return;
  }

  const tarballPath = join(LIB_DIR, resolved.name);
  const absolute = join(libDir, resolved.name);
  const digest = createHash("sha256")
    .update(readFileSync(absolute))
    .digest("hex");

  const marker = readMarkerSource(absolute + MARKER_SUFFIX);
  if (marker.problem !== undefined) {
    console.error(`Prebuild provenance check failed:\n\n  ${marker.problem}`);
    process.exitCode = 1;
    return;
  }

  const result = checkProvenance({
    tarballPath,
    digest,
    markerSource: marker.markerSource,
    // An absent or failing `gh` is a failed verification, not a skipped one:
    // reaching here means the marker asked for enforcement. stderr is piped
    // rather than inherited so the failure cause can be named from what the
    // run said; `verifierOutcome` writes it back out.
    runVerifier: (argv) =>
      verifierOutcome(
        spawnSync("gh", argv, {
          cwd: root,
          encoding: "utf8",
          stdio: ["inherit", "inherit", "pipe"],
          maxBuffer: VERIFIER_STDERR_LIMIT,
        }),
        (text) => process.stderr.write(text),
      ),
  });

  if (!result.ok) {
    console.error("Prebuild provenance check failed:\n");
    for (const problem of result.problems) console.error(`  ${problem}`);
    process.exitCode = 1;
    return;
  }

  for (const note of result.notes) {
    // A disarmed check is reported as a warning annotation rather than a plain
    // line, so a repository sitting on the sidecar-only baseline says so on
    // every run instead of looking indistinguishable from a verified one.
    if (!result.armed && process.env.GITHUB_ACTIONS === "true") {
      console.log(`::warning title=Prebuild provenance not armed::${note}`);
    } else {
      console.log(note);
    }
  }
}

// Only when invoked directly, so the test imports the decision functions
// without running the check and without touching the network.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCheck();
}
