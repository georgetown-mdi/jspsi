#!/usr/bin/env node
// The two obligations EXCHANGE_RECORD_VERSION carries, run by
// static_checks.yaml on every PR. Both read the same literal out of
// packages/core/src/exchangeRecord.ts, and both fall due long after the
// sentence stating them was written, which is the shape that rots: nothing
// fails when they are forgotten. They are one check so that one literal edit
// gets one verdict rather than two failures to be read together.
//
// The literal is read out of the source rather than imported from the built
// package because this runs before any build, and a check that silently skipped
// on a missing dist/ would be inert exactly when it is needed.
//
// RULE 1, THE BUMP. A managed web exchange keeps an accounting of disclosures:
// one stored value per exchange, holding its runs' exchange records verbatim,
// and the source an operator draws a HIPAA 164.528 accounting or a FERPA 99.32
// disclosure record from (docs/spec/MANAGED_EXCHANGE_RECORD.md, "The accounting
// of disclosures"). Every entry was admissible under the record format current
// when it was written, and the reader rejects an unrecognized version rather
// than migrating it -- so moving EXCHANGE_RECORD_VERSION invalidates, on every
// device holding one, an accounting nothing else holds a copy of. The read
// refuses the whole value, and so does the APPEND, which re-reads the accounting
// inside its own transaction: a still-scheduled exchange goes on disclosing and
// files nothing, unattended, with only a completion-screen notice nobody is
// there to see.
//
// The recovery for that is built (the stored-form export and the
// accounting-scoped reset, offered in that order from the unreadable state), but
// it rests on an assumption only the CURRENT format has been driven against:
// that a move invalidates the entries and leaves the accounting envelope
// readable, so the entries come back whole. An assumption about a format that
// does not exist yet cannot be tested ahead of the bump. So the literal is
// pinned to RECORD_VERSION_PIN below, and a move fails with a message naming
// what to re-take before the new value is recorded. Beside it, the entry points
// the recovery is built on must be declared: a tree that lost that path would
// pass the pin while deferring to nothing.
//
// RULE 2, THE RESET. EXCHANGE_RECORD_VERSION is an internal development counter.
// It has cycled freely -- through psilink-exchange-record/v1 and on up -- because
// no published artifact carries any of its literals: packages/core/src/exchangeRecord.ts
// does not exist at v0.1.0, the only release this project has tagged. First
// publication ships the counter reset to psilink-exchange-record/v1, and the
// reset is taken AT that release rather than earlier: re-using a
// previously-cycled value mid-development would let a development artifact
// written under the OLD v1 parse as the current version and fail on its field
// set, instead of taking the clean version refusal the reader is built to give.
//
// The release marker deciding when the reset is due is apps/cli/package.json's
// version, read through lib/releaseManifest.mjs -- the same marker and the same
// publication floor check-protocol-version-bump.mjs arms on, so "first
// publication" has one definition rather than two. It is read from the tree
// rather than from a git tag because the checkout the gate runs in has no tags:
// static_checks.yaml pins neither `fetch-depth` nor `fetch-tags` on its
// checkout, and a marker absent from the checkout would leave this check
// silently inert forever.
//
// Both rules record their own discharge here -- RECORD_VERSION_PIN for the bump,
// RESET_TAKEN_AT_RELEASE for the reset -- rather than in a ledger beside this
// file, so that recording one is an edit to the check itself: the diff a
// reviewer sees, and the moment the decision is taken.
//
// What this check cannot see:
//   - Whether the recovery still WORKS. It reads declarations, not behaviour. The
//     behaviour is held by apps/web/test/unit/disclosureAccounting.test.ts (the
//     envelope-parses/entries-reject split, driven against the real parsers),
//     apps/web/test/browser/managedExchangeStore.test.ts (the read's
//     classification and the reset against real IndexedDB), and
//     apps/web/test/browser/managedExchangeDetail.test.ts (both arms reachable
//     from the unreadable state, in order).
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
//   - Whether the record vectors were regenerated. That is held by `npm run
//     check:vectors`, which fails on its own once the literal moves.
//   - Whether a recorded discharge -- either one -- was recorded after the
//     decision was taken or instead of taking it. Moving a constant is a
//     one-line edit this check cannot tell from an honest one -- the same limit
//     the pull-request checklist's security-review sha carries -- so it is a
//     reviewer's call.
//   - The CLI's record files. The CLI writes a standalone record file per run and
//     accumulates no accounting store, so it holds nothing a bump could strand: a
//     version its build does not recognize is refused at the point of reading the
//     file, with the file still in the operator's hands. The recovery obligation
//     rule 1 defers is the web accounting's alone.
//   - A version literal that is not a literal. It reads the `export const`
//     initializer out of the source and fails rather than guessing when that
//     line does not read as a quoted string.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  obligationRoot,
  reportBlocked,
  reportViolations,
} from "./lib/deferredObligation.mjs";
import {
  PRE_PUBLICATION_RELEASE,
  RELEASE_MANIFEST,
  compareReleaseVersions,
  isPublishedRelease,
  manifestVersion,
} from "./lib/releaseManifest.mjs";

export { PRE_PUBLICATION_RELEASE, RELEASE_MANIFEST };

/** Where the record version literal is declared. */
export const RECORD_VERSION_SOURCE = "packages/core/src/exchangeRecord.ts";

/** This file, named by every failure that asks for an edit to it. */
export const CHECK_SOURCE = "scripts/check-exchange-record-version.mjs";

/** The exchange-record version the recovery path has been driven against. Moving
 * it here is how the bump decision this check defers is recorded as taken. */
export const RECORD_VERSION_PIN = "psilink-exchange-record/v6";

/** The entry points the recovery from a version-invalidated accounting is built
 * on, per file. Named functions rather than a surface description: a declaration
 * is a fact this check can read, where "the affordance is reachable" is not. */
export const RECOVERY_ENTRY_POINTS = {
  "apps/web/src/psi/disclosureAccounting.ts": [
    "parseStoredDisclosureAccounting",
  ],
  "apps/web/src/psi/disclosureAccountingStore.ts": [
    "readDisclosureAccounting",
    "resetDisclosureAccounting",
  ],
};

/** The record format literal first publication ships. */
export const RESET_RECORD_VERSION = "psilink-exchange-record/v1";

/** The Release Checklist heading carrying the obligations this check cannot
 * read: the artifacts to clear, and the order the reset is taken in. */
export const CHECKLIST_HEADING =
  "Reset the exchange-record format at first publication";

/** That heading as every failure names it. */
export const CHECKLIST_STEP = `docs/RELEASES.md, "${CHECKLIST_HEADING}"`;

/**
 * The release the reset was taken at, or undefined while it has not been taken.
 * Recording it here discharges the obligation and retires the reset rule.
 */
export const RESET_TAKEN_AT_RELEASE = undefined;

/**
 * The exchange-record version literal declared in the given source, or
 * `undefined` when the declaration is not a quoted string this can read.
 */
export function declaredRecordVersion(source) {
  const match = /export const EXCHANGE_RECORD_VERSION\s*=\s*"([^"]*)"/.exec(
    source,
  );
  return match === null ? undefined : match[1];
}

/**
 * The recovery entry points a source does not declare, as `{file, name}` pairs;
 * empty when every one of them is exported from the file that should carry it.
 */
export function missingRecoveryEntryPoints(sources) {
  const missing = [];
  for (const [file, names] of Object.entries(RECOVERY_ENTRY_POINTS)) {
    const source = sources[file] ?? "";
    for (const name of names) {
      const declared = new RegExp(
        `export\\s+(?:async\\s+)?function\\s+${name}\\b`,
      );
      if (!declared.test(source)) missing.push({ file, name });
    }
  }
  return missing;
}

/**
 * The reasons the tree does not stand where rule 1 pins it, as
 * `{kind, message}`; empty when the record version is where the recovery was
 * driven against it and the recovery is still there to defer to. `declared` is
 * the literal read from the tree, which `inspect` blocks on when it is
 * unreadable. `kind` is `moved` (the literal is off the pin) or `recovery` (an
 * entry point the deferral points at is gone). Each reason names the obligation
 * rather than only the mismatch, since the point of the failure is the
 * decision, not the diff.
 */
export function bumpViolations(declared, sources) {
  const violations = [];
  if (declared !== RECORD_VERSION_PIN) {
    violations.push({
      kind: "moved",
      message: [
        `${RECORD_VERSION_SOURCE}: EXCHANGE_RECORD_VERSION moved from "${RECORD_VERSION_PIN}" to "${declared}".`,
        "",
        "A move invalidates every accounting of disclosures already at rest in a browser: the accounting's read refuses the whole value, and so does the append inside it, so a scheduled exchange goes on disclosing and files nothing. The recovery offered for that state is the stored-form export and the accounting-scoped reset, and its export arm exists only while a move leaves the accounting ENVELOPE readable with the stored entries returned verbatim.",
        "",
        "That assumption has been driven against the pinned version and no other. Before recording the new one:",
        "  - re-drive the split against the moved format (apps/web/test/unit/disclosureAccounting.test.ts), so the export arm is known to still have entries to hand over;",
        "  - re-check that both arms are reachable from the unreadable state, in order (apps/web/test/browser/managedExchangeDetail.test.ts);",
        "  - state what the bump does to a stored accounting in docs/spec/MANAGED_EXCHANGE_RECORD.md and docs/MANAGED_EXCHANGE.md if the answer changed;",
        `  - then set RECORD_VERSION_PIN in ${CHECK_SOURCE} to "${declared}".`,
      ].join("\n"),
    });
  }
  violations.push(...recoveryViolations(sources));
  return violations;
}

/**
 * The reasons there is nothing left for rule 1 to defer to, as
 * `{kind, message}`; empty when every entry point is exported from the file
 * that should carry it. It reads the recovery sources and nothing else, so an
 * input the other rules cannot read does not withhold it: a tree that lost both
 * reports both.
 */
export function recoveryViolations(sources) {
  return missingRecoveryEntryPoints(sources).map(({ file, name }) => ({
    kind: "recovery",
    message: `${file}: "${name}" is no longer exported. This check defers a version-bump decision to the recovery path from a version-invalidated accounting of disclosures; without that entry point there is nothing to defer to, and a bump would strand every stored accounting with no way out. Restore it, or retire this rule along with the obligation it carries.`,
  }));
}

/**
 * The reasons the tree does not stand where rule 2 holds it, as
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
        message: `${CHECK_SOURCE} records the reset as taken at "${takenAtRelease}", which is not a release above the pre-publication ${PRE_PUBLICATION_RELEASE}. The discharge names the release that shipped the reset, so a value that names no such release retires this rule without anything having met it.`,
      });
    } else {
      const compared = compareReleaseVersions(takenAtRelease, releaseVersion);
      if (compared === undefined || compared > 0) {
        violations.push({
          kind: "discharge",
          message: `${CHECK_SOURCE} records the reset as taken at "${takenAtRelease}", ahead of the ${releaseVersion === undefined ? "version-less" : `"${releaseVersion}"`} ${RELEASE_MANIFEST} names. A discharge names a release that shipped, so nothing should be recorded ahead of the marker.`,
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
        `  - re-take the recovery obligations rule 1 names and re-record RECORD_VERSION_PIN in ${CHECK_SOURCE}, which fails on its own once the literal moves;`,
        "  - clear the development artifacts the checklist step enumerates, which a downward move leaves misread rather than refused;",
        `  - record the discharge here: RESET_TAKEN_AT_RELEASE = "${releaseVersion}" in ${CHECK_SOURCE}.`,
      ].join("\n"),
    });
    return violations;
  }

  violations.push({
    kind: "record",
    message: [
      `${RECORD_VERSION_SOURCE} declares EXCHANGE_RECORD_VERSION "${RESET_RECORD_VERSION}" and ${RELEASE_MANIFEST} names published release ${releaseVersion}, but ${CHECK_SOURCE} records no discharge.`,
      "",
      `The reset is taken once. With the rest of the checklist step met -- the vectors regenerated, RECORD_VERSION_PIN re-recorded, and the development artifacts cleared -- set RESET_TAKEN_AT_RELEASE to "${releaseVersion}" in ${CHECK_SOURCE}, which retires this rule so an ordinary forward bump after this release is not held to "${RESET_RECORD_VERSION}" forever (${CHECKLIST_STEP}).`,
    ].join("\n"),
  });
  return violations;
}

/**
 * Read the tree at `root` and report what both rules hold there, as
 * `{published, releaseVersion, declared, takenAtRelease, violations, blocked}`.
 * `blocked` carries the reasons an input could not be read at all, which fail
 * rather than passing as inert. A blocked run still reports the recovery
 * violations, which rest on no input it is blocked on.
 */
export function inspect(root) {
  const read = (relative) => readFileSync(resolve(root, relative), "utf8");
  // A recovery source that is gone entirely is the loudest form of the failure
  // rule 1 reports, so it reads as no declarations rather than as an ENOENT: the
  // throw would exit non-zero with the diagnostic lost, which is exactly the
  // tree where naming the missing entry point matters most.
  const readIfPresent = (relative) => {
    try {
      return read(relative);
    } catch {
      return "";
    }
  };
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
      `${RECORD_VERSION_SOURCE}: EXCHANGE_RECORD_VERSION's declaration did not read as a quoted string literal -- the extraction pattern rotted; fix ${CHECK_SOURCE} rather than dropping the check.`,
    );
  }

  const sources = Object.fromEntries(
    Object.keys(RECOVERY_ENTRY_POINTS).map((file) => [
      file,
      readIfPresent(file),
    ]),
  );

  const violations =
    blocked.length === 0
      ? [
          ...bumpViolations(declared, sources),
          ...resetViolations({
            published,
            releaseVersion,
            declared,
            takenAtRelease: RESET_TAKEN_AT_RELEASE,
          }),
        ]
      : recoveryViolations(sources);

  return {
    published,
    releaseVersion,
    declared,
    takenAtRelease: RESET_TAKEN_AT_RELEASE,
    violations,
    blocked,
  };
}

/** This check as its reports name it. */
const LABEL = "Exchange record version check";

// CLI entry: only runs when invoked directly, so the tests can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = inspect(obligationRoot(process.argv.slice(2), CHECK_SOURCE));
  const blocked = reportBlocked(LABEL, report.blocked);
  const failed = reportViolations(LABEL, report.violations);
  if (blocked || failed) process.exit(1);

  console.log(
    `check-exchange-record-version: EXCHANGE_RECORD_VERSION stands at "${RECORD_VERSION_PIN}", and the recovery path from a version-invalidated accounting is in place.`,
  );
  console.log(
    report.takenAtRelease !== undefined
      ? `check-exchange-record-version: the reset to "${RESET_RECORD_VERSION}" was taken at release ${report.takenAtRelease}, so EXCHANGE_RECORD_VERSION moves under its own rules from here.`
      : `check-exchange-record-version: ${RELEASE_MANIFEST} names ${report.releaseVersion}, at or below the pre-publication ${PRE_PUBLICATION_RELEASE}, so EXCHANGE_RECORD_VERSION "${report.declared}" is still a development counter. First publication ships "${RESET_RECORD_VERSION}" (${CHECKLIST_STEP}).`,
  );
}
