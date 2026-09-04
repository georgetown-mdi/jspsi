#!/usr/bin/env node
// Post-publication PROTOCOL_VERSION bump check, run by static_checks.yaml on
// every PR.
//
// docs/spec/PROTOCOL.md's "Wire-format deltas: existing frames only, and no
// version bump" states the rule in prose: a wire-format delta ships within
// PROTOCOL_VERSION 1 while psilink is pre-publication, and takes a bump from the
// first published deployment onward. A future obligation written as prose is the
// shape that rots -- the release it binds arrives long after the sentence was
// written, nothing fails when it is forgotten, and the change that should have
// taken the version decision ships past it. This is that obligation as a check.
//
// Three parts, each read from the tree alone:
//
//   A. THE RELEASE MARKER, which decides whether the rule binds yet.
//      apps/cli/package.json's version -- what docs/RELEASES.md step 2 calls the
//      canonical release version, and what check-release-version.mjs holds the
//      pushed tag to. The rule binds once that version rises above 0.1.0. It is
//      read from the tree rather than from a git tag because the checkout the
//      gate runs in has no tags: static_checks.yaml pins neither `fetch-depth`
//      nor `fetch-tags` on its checkout, and a marker absent from the checkout
//      would leave this check silently inert forever -- the one failure mode a
//      dormant check cannot afford.
//
//   B. THE WIRE-FORMAT PIN, which stands in for "the wire format changed": the
//      known-answer vectors under packages/core/test/vectors/ that pin what the
//      linkage rounds put on the wire, digested per file. Every *.json in that
//      directory is classified below -- covered by PROTOCOL_VERSION, or covered
//      by one of the neighbouring version markers docs/spec/PROTOCOL.md
//      distinguishes it from -- and a file matching neither list fails the
//      check, so coverage cannot rot behind a vectors file nobody classified.
//
//   C. THE PIN LEDGER, scripts/protocol-version-pins.json: the digests recorded
//      for each published PROTOCOL_VERSION. It is empty while the rule is
//      inert, because a pin recorded pre-publication would only go stale against
//      months of permitted deltas and then fail at publication for a reason that
//      is not the one this check exists to report. The first run after the
//      marker appears asks for the pin and prints it; every run after that holds
//      the tree to it.
//
// Once armed the ledger is append-only, and that shape is the review surface: a
// bump ADDS an entry, so a legitimate bump and an in-place rewrite of a published
// version's pin are different diffs. This check cannot tell a legitimate re-pin
// from a rewrite that dodges the bump -- the same limit the pull-request
// checklist's security-review sha has -- so an edit to an already-recorded
// entry is a reviewer's call, not this check's.
//
// What this check cannot see:
//   - A wire-format delta no vectors file pins. The pinned files cover the PSI
//     engine's bytes, the resolved association mapping, the terms-exchange
//     envelope, and single-pass message 2's frame layout -- not every frame the
//     protocol defines. The cascade's per-round mapped-element and
//     association-table frames and the count-only reply are specified in
//     docs/spec/PROTOCOL.md, and the save-bootstrap secret frame in
//     docs/SECURITY_DESIGN.md; all are pinned by no file here, so a delta
//     confined to one of them moves no digest. The pin is the
//     issue's stated proxy for a wire-format change, not a complete model of the
//     wire format.
//   - A frame shape the pinned scenarios do not drive. The terms-envelope
//     vectors capture what exchangeTerms and sendAbort EMIT on the scenarios
//     they run, so a field none of them advertises moves no digest here. That
//     gap is held shut on the suite's side rather than this one's: it reads the
//     field set each slot's schema ADMITS out of the source and fails until the
//     pinned frames' union covers it, so an added field takes a scenario, and a
//     scenario moves the digest.
//   - The difference between a wire-format change and a cosmetic one. The digest
//     is taken over the file's parsed JSON, so reformatting does not move it,
//     but re-ordering keys or editing a vector's hand-authored name does. Such a
//     change fails toward taking the version decision rather than away from it.
//   - Whether the version decision taken was the RIGHT one. It fails a moved pin
//     that has no bump; it cannot judge a bump that was not needed.
//   - A PROTOCOL_VERSION that is not a literal. It reads the `export const`
//     initializer out of the source rather than importing the built package, and
//     fails rather than guessing when that line does not read as an integer.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
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
  isPublishedRelease,
  manifestVersion,
  parseReleaseVersion,
} from "./lib/releaseManifest.mjs";

export {
  PRE_PUBLICATION_RELEASE,
  RELEASE_MANIFEST,
  isPublishedRelease,
  manifestVersion,
  parseReleaseVersion,
};

/** The source the build's PROTOCOL_VERSION literal is read from. */
export const PROTOCOL_VERSION_SOURCE = "packages/core/src/protocolSetup.ts";

/** The vectors directory the wire-format pin is taken over. */
export const VECTORS_DIRECTORY = "packages/core/test/vectors";

/** The recorded pin per published PROTOCOL_VERSION. */
export const PINS_FILE = "scripts/protocol-version-pins.json";

/** This file, named by the usage line its command line prints. */
export const CHECK_SOURCE = "scripts/check-protocol-version-bump.mjs";

/** The paragraph stating the rule, named by every failure this check reports. */
export const SPEC_PARAGRAPH =
  'docs/spec/PROTOCOL.md, "Wire-format deltas: existing frames only, and no version bump"';

/**
 * The vectors files pinning what PROTOCOL_VERSION covers: the content of the
 * frames the linkage rounds exchange.
 */
export const COVERED_VECTORS = [
  {
    vectors: "index-table-vectors.json",
    reason:
      "the wire layout of single-pass message 2 -- the four-part frame's boundaries and the distinct-value index table in both the layouts a sender ships (fixed-width and ragged), which a partner reads from session state with no wire flag.",
  },
  {
    vectors: "psi-engine-wire-vectors.json",
    reason:
      "the byte-for-byte output of the four PSI engine operations, which is what the linkage rounds' setup, request, and response frames carry; a peer on another build reads these bytes.",
  },
  {
    vectors: "psi-intersection-vectors.json",
    reason:
      "the resolved intersection membership and the association/permutation mapping back to input rows -- what message 3's association table states and what both parties must resolve identically.",
  },
  {
    vectors: "terms-envelope-vectors.json",
    reason:
      "the field set, field order, and values each terms-exchange frame slot carries beside `linkageTerms` -- the record count, the protocol version, the save intent, the payload-intent flag, and the observed host key -- which a partner reads by name on the one round-trip every exchange performs.",
  },
];

/**
 * The vectors files PROTOCOL_VERSION does not cover, each with the version
 * marker that does. The three neighbouring identifiers are the ones
 * docs/spec/PROTOCOL.md distinguishes PROTOCOL_VERSION from under
 * "Protocol-version reconcile at the terms exchange".
 */
export const UNCOVERED_VECTORS = [
  {
    vectors: "aead-envelope-vectors.json",
    versionedBy:
      "the channel AEAD envelope's own leading version byte (docs/spec/CHANNEL_SECURITY.md), a transport-layer format beneath the terms layer PROTOCOL_VERSION marks.",
  },
  {
    vectors: "canonical-vectors.json",
    versionedBy:
      "RFC 8785 itself: a conformance corpus transcribed from docs/spec/CANONICAL_ENCODING.md rather than a psilink frame layout, so the external standard carries its versioning.",
  },
  {
    vectors: "exchange-record-vectors.json",
    versionedBy:
      "the record document's own `psilink-exchange-record/v6` discriminant (docs/spec/EXCHANGE_RECORD.md). The record is written locally and never sent to the partner.",
  },
  {
    vectors: "kex-vectors.json",
    versionedBy:
      "the KEX protocol-name tag hashed into the handshake transcript (`psilink-kex-v2`), which docs/spec/PROTOCOL.md names as a marker distinct from this one.",
  },
  {
    vectors: "psi-prebuild-manifest.json",
    versionedBy:
      "the vendored lib/*.tgz it re-derives: a build-input manifest, not a wire artifact.",
  },
  {
    vectors: "signed-receipt-vectors.json",
    versionedBy:
      "the receipt and certificate formats, which move with the signing suite (docs/spec/EXCHANGE_RECORD.md) rather than with the linkage frames.",
  },
  {
    vectors: "signing-cert-vectors.json",
    versionedBy:
      "the signing identity and certificate formats, which move with the signing suite (docs/spec/EXCHANGE_RECORD.md).",
  },
  {
    vectors: "transform-regex-divergent-vectors.json",
    versionedBy:
      "the operator-authored linkage-terms `version`, which is what the transform dialect is compared under between two parties.",
  },
  {
    vectors: "transform-regex-vectors.json",
    versionedBy:
      "the operator-authored linkage-terms `version`, which is what the transform dialect is compared under between two parties.",
  },
  {
    vectors: "webrtc-interop-vectors.json",
    versionedBy:
      "the invitation-token `version` (docs/spec/FILE_SYNC.md), which covers the invitation encoding and the rendezvous derivation these pin.",
  },
];

/**
 * The PROTOCOL_VERSION a source file declares, or undefined when its `export
 * const` initializer is not an integer literal.
 */
export function protocolVersionFrom(source) {
  const match = /^export const PROTOCOL_VERSION = (\d+);$/m.exec(source);
  return match === null ? undefined : Number(match[1]);
}

/**
 * The pin a vectors file's source holds: sha256 over its parsed-and-
 * reserialized JSON, so whitespace and the repo's formatter do not move it while
 * every value, key, and ordering does.
 */
export function wireFormatDigest(vectorsSource) {
  const canonical = JSON.stringify(JSON.parse(vectorsSource));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Vectors files the two manifests above do not account for, and manifest entries
 * the directory does not hold, as `{unclassified, missing}`. Only `*.json` is in
 * scope here; the generators beside them are classified by
 * check-vectors-generators.mjs.
 */
export function classifyVectorsDirectory(entries) {
  const present = entries.filter((entry) => entry.endsWith(".json"));
  const classified = [...COVERED_VECTORS, ...UNCOVERED_VECTORS].map(
    (entry) => entry.vectors,
  );
  return {
    unclassified: present.filter((entry) => !classified.includes(entry)).sort(),
    missing: classified.filter((entry) => !present.includes(entry)).sort(),
  };
}

/** The ledger the tree implies, with `digests` recorded under `version`. */
export function suggestedLedger(pins, version, digests) {
  return `${JSON.stringify({ pins: { ...pins, [version]: digests } }, null, 2)}\n`;
}

// The shape a ledger key has: the PROTOCOL_VERSION integer written out, and
// nothing else. JSON object keys are text, so every lookup here is by exactly
// `String(protocolVersion)` -- a key in any other shape ("abc", "1.0", "01") is
// one this check never looks up and never compares, so it fails rather than
// sitting in the ledger holding a pin nothing is held to.
const LEDGER_VERSION_KEY = /^[1-9][0-9]*$/;

/**
 * The reasons the recorded pin and the tree do not agree, as `{kind, message}`;
 * empty when they agree, and empty while the rule is inert. `digests` is the
 * covered files' current pins by file name, `pins` the ledger's recorded entries
 * by version. `kind` is `record` (a pin is missing and printing one is the
 * remedy), `moved` (a published pin has moved), or `ledger` (the ledger's own
 * shape is wrong, which no printed pin repairs).
 */
export function pinViolations({ published, protocolVersion, digests, pins }) {
  if (!published) return [];
  const violations = [];

  const keys = Object.keys(pins);
  const malformed = keys.filter((key) => !LEDGER_VERSION_KEY.test(key));
  for (const key of malformed) {
    violations.push({
      kind: "ledger",
      message: `${PINS_FILE} records a pin under "${key}", which is not a PROTOCOL_VERSION. A ledger key is the version's integer written out ("1", "2"), and a pin is looked up by exactly that string, so a key in any other shape records a wire format nothing is ever held to.`,
    });
  }
  const recorded = keys
    .filter((key) => LEDGER_VERSION_KEY.test(key))
    .map((version) => Number(version))
    .sort((a, b) => a - b);

  for (const version of recorded) {
    if (version > protocolVersion) {
      violations.push({
        kind: "ledger",
        message: `${PINS_FILE} records a pin for PROTOCOL_VERSION ${version}, above the ${protocolVersion} this build advertises: a pin names a version that shipped, so nothing should be recorded ahead of ${PROTOCOL_VERSION_SOURCE}.`,
      });
    }
  }

  const entry = pins[String(protocolVersion)];
  if (entry === undefined) {
    violations.push({
      kind: "record",
      message:
        recorded.length === 0
          ? `${RELEASE_MANIFEST} names a published release, so the wire-format pin binds from here on, and ${PINS_FILE} records none for PROTOCOL_VERSION ${protocolVersion} yet. Record the pin below; it is the wire format this release publishes, and every later change to it takes a bump (${SPEC_PARAGRAPH}).`
          : `${PINS_FILE} records no pin for PROTOCOL_VERSION ${protocolVersion}. A bump records the wire format it ships beside it -- record the pin below (${SPEC_PARAGRAPH}).`,
    });
  } else {
    for (const { vectors } of COVERED_VECTORS) {
      const pinned = entry[vectors];
      if (pinned === undefined) {
        violations.push({
          kind: "ledger",
          message: `${PINS_FILE}'s PROTOCOL_VERSION ${protocolVersion} entry pins nothing for ${VECTORS_DIRECTORY}/${vectors}, which this check covers: a covered file with no recorded pin is a wire format nothing holds.`,
        });
      } else if (pinned !== digests[vectors]) {
        violations.push({
          kind: "moved",
          message: `${VECTORS_DIRECTORY}/${vectors} has moved under published PROTOCOL_VERSION ${protocolVersion} (recorded ${pinned}, tree ${digests[vectors]}). A wire-format delta takes a bump from the first published deployment onward: raise PROTOCOL_VERSION in ${PROTOCOL_VERSION_SOURCE} and record the new pin beside it, or leave the wire format where it is (${SPEC_PARAGRAPH}).`,
        });
      }
    }
    for (const vectors of Object.keys(entry).sort()) {
      if (!COVERED_VECTORS.some((covered) => covered.vectors === vectors)) {
        violations.push({
          kind: "ledger",
          message: `${PINS_FILE}'s PROTOCOL_VERSION ${protocolVersion} entry pins ${vectors}, which this check does not cover: a pin over a file whose version marker is elsewhere fails a change that took the right decision under the wrong marker.`,
        });
      }
    }
  }

  const lowest = recorded[0] ?? protocolVersion;
  for (let version = lowest; version < protocolVersion; version += 1) {
    if (pins[String(version)] === undefined) {
      violations.push({
        kind: "ledger",
        message: `${PINS_FILE} records pins for ${recorded.join(", ")} but none for ${version}, which sits between them and this build's ${protocolVersion}. The ledger is append-only: a dropped entry erases the record of what that version published.`,
      });
    }
  }

  return violations;
}

/**
 * Read the tree at `root` and report what the rule holds there, as
 * `{published, releaseVersion, protocolVersion, digests, pins, coverage,
 * violations, blocked}`. `violations` are `{kind, message}`, `kind` also
 * holding `coverage` for a vectors file neither manifest classifies. `blocked`
 * holds the reasons the check could not read an input at all, which fail
 * rather than passing as inert.
 */
export function inspect(root) {
  const read = (relative) => readFileSync(resolve(root, relative), "utf8");
  const blocked = [];

  const releaseVersion = manifestVersion(read(RELEASE_MANIFEST));
  const published = isPublishedRelease(releaseVersion);
  if (published === undefined) {
    blocked.push(
      `${RELEASE_MANIFEST} carries ${releaseVersion === undefined ? "no version" : `"${releaseVersion}"`}, which is not a release version this can compare against ${PRE_PUBLICATION_RELEASE}. A marker it cannot read leaves the rule neither armed nor knowably inert.`,
    );
  }

  const protocolVersion = protocolVersionFrom(read(PROTOCOL_VERSION_SOURCE));
  if (protocolVersion === undefined) {
    blocked.push(
      `${PROTOCOL_VERSION_SOURCE} declares no \`export const PROTOCOL_VERSION = <integer>;\` this can read, so there is no version to hold a pin against.`,
    );
  }

  const entries = readdirSync(resolve(root, VECTORS_DIRECTORY));
  const coverage = classifyVectorsDirectory(entries);

  const digests = {};
  for (const { vectors } of COVERED_VECTORS) {
    if (!entries.includes(vectors)) continue;
    digests[vectors] = wireFormatDigest(
      read(`${VECTORS_DIRECTORY}/${vectors}`),
    );
  }

  const { pins } = JSON.parse(read(PINS_FILE));
  if (pins === null || typeof pins !== "object" || Array.isArray(pins)) {
    blocked.push(
      `${PINS_FILE} carries no \`pins\` object, so there is no ledger to hold the tree to.`,
    );
  }

  const violations = [];
  for (const vectors of coverage.unclassified) {
    violations.push({
      kind: "coverage",
      message: `${VECTORS_DIRECTORY}/${vectors} is classified by neither manifest in this check. Add it to COVERED_VECTORS if it pins what the linkage rounds put on the wire, or to UNCOVERED_VECTORS naming the version marker that does cover it.`,
    });
  }
  for (const vectors of coverage.missing) {
    violations.push({
      kind: "coverage",
      message: `${VECTORS_DIRECTORY}/${vectors} is classified by this check but is not in that directory. Drop its entry, or restore the file.`,
    });
  }
  if (blocked.length === 0) {
    violations.push(
      ...pinViolations({ published, protocolVersion, digests, pins }),
    );
  }

  return {
    published,
    releaseVersion,
    protocolVersion,
    digests,
    pins: pins ?? {},
    coverage,
    violations,
    blocked,
  };
}

/**
 * One line per classified vectors file: what the pin covers, and for everything
 * else the version marker that covers it instead. Reported on every passing run
 * so a classification that has gone wrong is read rather than inferred -- the
 * whole check rests on it, and nothing else displays it.
 */
export function classificationReport() {
  return [
    ...COVERED_VECTORS.map(
      ({ vectors, reason }) => `  pinned     ${vectors} -- ${reason}`,
    ),
    ...UNCOVERED_VECTORS.map(
      ({ vectors, versionedBy }) =>
        `  elsewhere  ${vectors} -- versioned by ${versionedBy}`,
    ),
  ];
}

/**
 * The version a suggested ledger should record under: the current one when it
 * holds no entry, the next one when its entry has moved -- so the printed block
 * is never the in-place rewrite of a published pin.
 */
export function ledgerSuggestionVersion(pins, protocolVersion) {
  return pins[String(protocolVersion)] === undefined
    ? protocolVersion
    : protocolVersion + 1;
}

/** This check as its reports name it. */
const LABEL = "Protocol version bump check";

// CLI entry: only runs when invoked directly, so the tests can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = inspect(obligationRoot(process.argv.slice(2), CHECK_SOURCE));
  if (reportBlocked(LABEL, report.blocked)) process.exit(1);

  if (reportViolations(LABEL, report.violations)) {
    if (
      report.violations.some(
        ({ kind }) => kind === "record" || kind === "moved",
      )
    ) {
      const version = ledgerSuggestionVersion(
        report.pins,
        report.protocolVersion,
      );
      console.error(
        `\nThe pin ${PINS_FILE} would carry for PROTOCOL_VERSION ${version}:\n`,
      );
      console.error(suggestedLedger(report.pins, version, report.digests));
      console.error(
        `Write it, run \`npm run format\`, and leave every already-recorded entry as it stands: ${SPEC_PARAGRAPH} is the rule, and an entry rewritten in place records a version that never shipped that wire format.`,
      );
    }
    process.exit(1);
  }

  for (const line of classificationReport()) console.log(line);
  console.log(
    report.published
      ? `\nProtocol version bump check passed: ${RELEASE_MANIFEST} names published release ${report.releaseVersion}, and every pinned file matches what ${PINS_FILE} records for PROTOCOL_VERSION ${report.protocolVersion}.`
      : `\nProtocol version bump check passed: ${RELEASE_MANIFEST} names ${report.releaseVersion}, at or below the pre-publication ${PRE_PUBLICATION_RELEASE}, so a wire-format delta still ships within PROTOCOL_VERSION ${report.protocolVersion} (${SPEC_PARAGRAPH}). The pinned files bind once a release above ${PRE_PUBLICATION_RELEASE} lands.`,
  );
}
