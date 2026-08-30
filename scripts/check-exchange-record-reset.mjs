#!/usr/bin/env node
// First-publication exchange-record format reset check, run by
// static_checks.yaml on every PR.
//
// EXCHANGE_RECORD_VERSION is an internal development counter. It has cycled
// freely -- through psilink-exchange-record/v1 and on up -- because no published
// artifact carries any of its literals: packages/core/src/exchangeRecord.ts does
// not exist at v0.1.0, the only release this project has tagged. First
// publication ships the counter reset to psilink-exchange-record/v1, and the
// reset is taken AT that release rather than earlier: re-using a
// previously-cycled value mid-development would let a development artifact
// written under the OLD v1 parse as the current version and fail on its field
// set, instead of taking the clean version refusal the reader is built to give.
//
// Both halves fall due at a release long after the sentence stating them was
// written, which is the shape that rots: nothing fails when they are forgotten,
// and the release ships past them. This is that obligation as a check.
//
// Three parts, each read from the tree alone:
//
//   A. THE RELEASE MARKER, which decides when the reset is due:
//      apps/cli/package.json's version, read through lib/releaseManifest.mjs --
//      the same marker and the same publication floor
//      check-protocol-version-bump.mjs arms on, so "first publication" has one
//      definition rather than two. It is read from the tree rather than from a
//      git tag because the checkout the gate runs in has no tags:
//      static_checks.yaml pins neither `fetch-depth` nor `fetch-tags` on its
//      checkout, and a marker absent from the checkout would leave this check
//      silently inert forever.
//
//   B. THE RECORD FORMAT LITERAL, read through lib/exchangeRecordVersion.mjs.
//      Below the marker it must NOT be the reset value; at and above it, it must
//      be.
//
//   C. THE DISCHARGE, RESET_TAKEN_AT_RELEASE below: the release the reset was
//      taken at, or undefined while it has not been taken. Recording it is what
//      retires this rule, so an ordinary forward bump after the reset is not
//      held to v1 forever. It lives in this file rather than a ledger beside it
//      so that recording it is an edit to the check itself -- the diff a
//      reviewer sees, and the moment the decision is taken.
//
// What this check cannot see:
//   - The artifact side of the reset. A development artifact already at rest --
//     a browser-stored accounting of disclosures, a record file on an operator's
//     disk -- is outside this tree, and a leftover entry numbered above the
//     reset value is worse than unreadable: the managed accounting's direction
//     split orders entry literals ordinally, so it classifies as stale-page,
//     whose remedy is a reload that cannot help and which withholds the
//     export-then-reset arms (docs/spec/MANAGED_EXCHANGE_RECORD.md, "What an
//     exchange-record version bump does to a stored accounting"). That
//     confirm-or-wipe obligation is carried by the Release Checklist step this
//     check's failures name.
//   - Whether the record vectors were regenerated or RECORD_VERSION_PIN
//     re-recorded. Those are held by `npm run check:vectors` and
//     check-disclosure-recovery.mjs, each of which fails on its own once the
//     literal moves.
//   - Whether a recorded discharge was recorded after the reset was taken or
//     instead of taking it. Moving a constant is a one-line edit this check
//     cannot tell from an honest one -- the same limit the pull-request
//     checklist's security-review sha carries -- so it is a reviewer's call.
//   - A version literal that is not a literal. It reads the `export const`
//     initializer out of the source and fails rather than guessing when that
//     line does not read as a quoted string.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RECORD_VERSION_SOURCE,
  declaredRecordVersion,
} from "./lib/exchangeRecordVersion.mjs";
import {
  PRE_PUBLICATION_RELEASE,
  RELEASE_MANIFEST,
  compareReleaseVersions,
  isPublishedRelease,
  manifestVersion,
} from "./lib/releaseManifest.mjs";

export { PRE_PUBLICATION_RELEASE, RECORD_VERSION_SOURCE, RELEASE_MANIFEST };

/** The record format literal first publication ships. */
export const RESET_RECORD_VERSION = "psilink-exchange-record/v1";

/** This file, named by every failure that asks for an edit to it. */
export const RESET_SOURCE = "scripts/check-exchange-record-reset.mjs";

/** The Release Checklist heading carrying the obligations this check cannot
 * read: the artifacts to clear, and the order the reset is taken in. */
export const CHECKLIST_HEADING =
  "Reset the exchange-record format at first publication";

/** That heading as every failure names it. */
export const CHECKLIST_STEP = `docs/RELEASES.md, "${CHECKLIST_HEADING}"`;

/**
 * The release the reset was taken at, or undefined while it has not been taken.
 * Recording it here discharges the obligation and retires the rule.
 */
export const RESET_TAKEN_AT_RELEASE = undefined;

/**
 * The reasons the tree does not stand where this rule holds it, as
 * `{kind, message}`; empty when it does. `kind` is `discharge` (the recorded
 * discharge is not a release this can hold anything to), `early` (the reset
 * landed before the release that publishes it), `due` (the reset is due and the
 * literal is elsewhere), or `record` (the reset landed and is not recorded).
 */
export function resetViolations({
  published,
  releaseVersion,
  declared,
  takenAtRelease,
}) {
  const violations = [];

  if (takenAtRelease !== undefined) {
    if (isPublishedRelease(takenAtRelease) !== true) {
      violations.push({
        kind: "discharge",
        message: `${RESET_SOURCE} records the reset as taken at "${takenAtRelease}", which is not a release above the pre-publication ${PRE_PUBLICATION_RELEASE}. The discharge names the release that shipped the reset, so a value that names no such release retires this rule without anything having met it.`,
      });
    } else {
      const compared = compareReleaseVersions(takenAtRelease, releaseVersion);
      if (compared === undefined || compared > 0) {
        violations.push({
          kind: "discharge",
          message: `${RESET_SOURCE} records the reset as taken at "${takenAtRelease}", ahead of the ${releaseVersion === undefined ? "version-less" : `"${releaseVersion}"`} ${RELEASE_MANIFEST} names. A discharge names a release that shipped, so nothing should be recorded ahead of the marker.`,
        });
      }
    }
    return violations;
  }

  if (!published) {
    if (declared === RESET_RECORD_VERSION) {
      violations.push({
        kind: "early",
        message: [
          `${RECORD_VERSION_SOURCE}: EXCHANGE_RECORD_VERSION is already "${RESET_RECORD_VERSION}" while ${RELEASE_MANIFEST} names ${releaseVersion}, at or below the pre-publication ${PRE_PUBLICATION_RELEASE}.`,
          "",
          "The counter has been through that value once already, so a development artifact written under the old one parses as the current version and then fails on its field set, instead of taking the clean version refusal the reader is built to give.",
          "",
          `The reset belongs to the release that publishes it: move the literal forward on the development counter, and set it to "${RESET_RECORD_VERSION}" in the release branch that takes ${RELEASE_MANIFEST} above ${PRE_PUBLICATION_RELEASE} (${CHECKLIST_STEP}).`,
        ].join("\n"),
      });
    }
    return violations;
  }

  if (declared !== RESET_RECORD_VERSION) {
    violations.push({
      kind: "due",
      message: [
        `${RELEASE_MANIFEST} names ${releaseVersion}, a release above the pre-publication ${PRE_PUBLICATION_RELEASE}, and ${RECORD_VERSION_SOURCE} declares EXCHANGE_RECORD_VERSION "${declared}".`,
        "",
        `First publication ships the record format at "${RESET_RECORD_VERSION}": the counter cycled freely while no published artifact carried any of its literals, and this release is what ends that.`,
        "",
        `Take the reset as one piece (${CHECKLIST_STEP}):`,
        `  - set EXCHANGE_RECORD_VERSION to "${RESET_RECORD_VERSION}" in ${RECORD_VERSION_SOURCE};`,
        "  - regenerate the record vectors through their generator, which `npm run check:vectors` holds them to;",
        "  - re-record RECORD_VERSION_PIN and discharge the obligations scripts/check-disclosure-recovery.mjs names, which fail on their own once the literal moves;",
        "  - clear the development artifacts the checklist step enumerates, which a downward move leaves misread rather than refused;",
        `  - record the discharge here: RESET_TAKEN_AT_RELEASE = "${releaseVersion}" in ${RESET_SOURCE}.`,
      ].join("\n"),
    });
    return violations;
  }

  violations.push({
    kind: "record",
    message: [
      `${RECORD_VERSION_SOURCE} declares EXCHANGE_RECORD_VERSION "${RESET_RECORD_VERSION}" and ${RELEASE_MANIFEST} names published release ${releaseVersion}, but ${RESET_SOURCE} records no discharge.`,
      "",
      `The reset is taken once. With the rest of the checklist step met -- the vectors regenerated, RECORD_VERSION_PIN re-recorded, and the development artifacts cleared -- set RESET_TAKEN_AT_RELEASE to "${releaseVersion}" in ${RESET_SOURCE}, which retires this rule so an ordinary forward bump after this release is not held to "${RESET_RECORD_VERSION}" forever (${CHECKLIST_STEP}).`,
    ].join("\n"),
  });
  return violations;
}

/**
 * Read the tree at `root` and report what the rule holds there, as
 * `{published, releaseVersion, declared, takenAtRelease, violations, blocked}`.
 * `blocked` carries the reasons an input could not be read at all, which fail
 * rather than passing as inert.
 */
export function inspect(root) {
  const read = (relative) => readFileSync(resolve(root, relative), "utf8");
  const blocked = [];

  const releaseVersion = manifestVersion(read(RELEASE_MANIFEST));
  const published = isPublishedRelease(releaseVersion);
  if (published === undefined) {
    blocked.push(
      `${RELEASE_MANIFEST} carries ${releaseVersion === undefined ? "no version" : `"${releaseVersion}"`}, which is not a release version this can compare against ${PRE_PUBLICATION_RELEASE}. A marker it cannot read leaves the reset neither due nor knowably not due.`,
    );
  }

  const declared = declaredRecordVersion(read(RECORD_VERSION_SOURCE));
  if (declared === undefined) {
    blocked.push(
      `${RECORD_VERSION_SOURCE}: EXCHANGE_RECORD_VERSION's declaration did not read as a quoted string literal -- the extraction pattern rotted; fix scripts/lib/exchangeRecordVersion.mjs rather than dropping the check.`,
    );
  }

  const violations =
    blocked.length === 0
      ? resetViolations({
          published,
          releaseVersion,
          declared,
          takenAtRelease: RESET_TAKEN_AT_RELEASE,
        })
      : [];

  return {
    published,
    releaseVersion,
    declared,
    takenAtRelease: RESET_TAKEN_AT_RELEASE,
    violations,
    blocked,
  };
}

// CLI entry: only runs when invoked directly, so the tests can import the pure
// functions without the process.exit. `--root` points the run at another tree,
// which is how the tests drive the states this repository has not reached.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf("--root");
  if (rootFlag !== -1 && args[rootFlag + 1] === undefined) {
    console.error(`usage: node ${RESET_SOURCE} [--root <tree>]`);
    process.exit(2);
  }
  const root =
    rootFlag === -1
      ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
      : resolve(args[rootFlag + 1]);

  const report = inspect(root);
  if (report.blocked.length > 0) {
    console.error("Exchange record reset check could not run:\n");
    for (const reason of report.blocked) console.error("  " + reason);
    process.exit(1);
  }

  if (report.violations.length > 0) {
    console.error("Exchange record reset check failed:\n");
    for (const { message } of report.violations) console.error(message + "\n");
    process.exit(1);
  }

  if (report.takenAtRelease !== undefined) {
    console.log(
      `check-exchange-record-reset: the reset to "${RESET_RECORD_VERSION}" was taken at release ${report.takenAtRelease}, so EXCHANGE_RECORD_VERSION moves under its own rules from here.`,
    );
  } else {
    console.log(
      `check-exchange-record-reset: ${RELEASE_MANIFEST} names ${report.releaseVersion}, at or below the pre-publication ${PRE_PUBLICATION_RELEASE}, so EXCHANGE_RECORD_VERSION "${report.declared}" is still a development counter. First publication ships "${RESET_RECORD_VERSION}" (${CHECKLIST_STEP}).`,
    );
  }
}
