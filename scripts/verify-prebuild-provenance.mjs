#!/usr/bin/env node
// Build-provenance check for the vendored @openmined/psi.js prebuild tarball,
// run by .github/actions/setup ahead of `npm ci` and by release.yaml's publish
// job ahead of the shipped image build.
//
// The tarball carries native N-API .node prebuilds that are dlopen'd with full
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
// ARMING. The fork does not attest the tarball yet, so a check that always
// demanded an attestation would redden CI the moment it landed. The marker file
// beside the tarball (`<tarball>.provenance.json`) carries the switch:
//
//   attestation_expected: false -> report, warn, and pass. The sidecar remains
//     the whole control, exactly as before this check existed.
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
// (docs/PREBUILD_REVENDOR.md) carries as the reviewer's own step: that the
// attested build is honest. An attestation binds bytes to a workflow run in the
// producer repo; whether that run built what its source says is the fork's
// problem, not this one.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = "lib";
const TARBALL = /^openmined-psi\.js-.+\.tgz$/;
const MARKER_SUFFIX = ".provenance.json";

// Pinned rather than left to `gh`'s default so a change to that default cannot
// silently widen what counts as a provenance claim.
const PREDICATE_TYPE = "https://slsa.dev/provenance/v1";

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_40 = /^[0-9a-f]{40}$/;
const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
const SIGNER_WORKFLOW = /^[\w.-]+\/[\w.-]+\/.+\.ya?ml$/;

/**
 * The single vendored tarball's filename, or a problem describing why there is
 * no single one. Exactly one is the premise every call site's glob already
 * carries; two would make `sha256sum -c lib/*.tgz.sha256` ambiguous too.
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

  // The source commit is what binds the attested build to reviewable fork
  // source, so arming without it is refused rather than silently verifying a
  // weaker identity than the docs claim.
  if (marker.attestation_expected === true) {
    if (typeof marker.source_ref !== "string" || marker.source_ref === "") {
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

/**
 * The marker's bytes when it is there, `{ markerSource: undefined }` when it is
 * absent, and a problem when it exists but cannot be read. An unreadable marker
 * -- a permission error, a directory in its place -- is reported as itself
 * rather than folded into the missing-marker report, which would name the wrong
 * cause; both still fail the check. `readFile` is the test seam.
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
 * The whole decision, with the bytes and the verifier handed in so a test can
 * drive every branch without a 16 MB fixture or a live GitHub lookup.
 *
 * `runVerifier(argv)` returns the verifier's exit status, or a falsy status for
 * success; it is only called once the offline checks have all passed.
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
  const status = runVerifier(argv);
  if (status) {
    return {
      ok: false,
      armed: true,
      problems: [
        `\`gh ${argv.join(" ")}\` exited ${status}. The vendored bytes carry no attestation from ${marker.producer_repository} at ${marker.source_digest}, or the attestation does not match the recorded identity.`,
      ],
      notes: [],
    };
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

// CLI entry: only when invoked directly, so the test imports the decision
// functions without the process.exit and without touching the network.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const libDir = join(root, LIB_DIR);

  const resolved = resolveTarballName(readdirSync(libDir));
  if (resolved.problem !== undefined) {
    console.error(`Prebuild provenance check failed:\n\n  ${resolved.problem}`);
    process.exit(1);
  }

  const tarballPath = join(LIB_DIR, resolved.name);
  const absolute = join(libDir, resolved.name);
  const digest = createHash("sha256")
    .update(readFileSync(absolute))
    .digest("hex");

  const marker = readMarkerSource(absolute + MARKER_SUFFIX);
  if (marker.problem !== undefined) {
    console.error(`Prebuild provenance check failed:\n\n  ${marker.problem}`);
    process.exit(1);
  }

  const result = checkProvenance({
    tarballPath,
    digest,
    markerSource: marker.markerSource,
    // An absent or failing `gh` is a failed verification, not a skipped one:
    // reaching here means the marker asked for enforcement.
    runVerifier: (argv) => {
      const run = spawnSync("gh", argv, { cwd: root, stdio: "inherit" });
      if (run.error !== undefined) {
        console.error(`  could not run \`gh\`: ${run.error.message}`);
        return 127;
      }
      return run.status ?? 1;
    },
  });

  if (!result.ok) {
    console.error("Prebuild provenance check failed:\n");
    for (const problem of result.problems) console.error(`  ${problem}`);
    process.exit(1);
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
