#!/usr/bin/env node
// Release version agreement check, run by release.yaml before the image build.
//
// Two independently produced values name the same release. The pushed git tag
// decides every tag docker/metadata-action publishes the image under, while
// apps/cli/package.json's version -- the canonical release version
// (docs/RELEASES.md) -- is what the image build bakes into the client bundle as
// VITE_PSILINK_VERSION, and that is the version the partner accept kit prints in
// every `docker run` line it hands the partner (docs/spec/SERVER_JOB_API.md).
// Their agreement rests on a release-checklist step ordering, the manifest bump
// preceding the tag push, and an ordering cannot fail: a tag pushed without the
// bump publishes an image whose kit names the release BEFORE it -- a tag that
// exists, so the partner runs a build other than the one that minted their
// invitation and nothing reports it. This check is what fails instead.
//
// Two rules, read from the tag the run was triggered by and the manifest the
// same checkout holds:
//
//   A. The tag names a release version: `vX.Y.Z`, the shape release.yaml's own
//      trigger filter admits. A tag this cannot parse names no version to
//      compare, so it fails rather than passing a comparison it never made.
//   B. That version and the manifest's are the same string, and the manifest
//      holds one at all. Each failure names both values, since which of the two
//      is the wrong one is the maintainer's call and not this check's.
//
// What this check cannot see:
//   - Whether the version the two hold is the one the release was meant to
//     publish. It holds them to each other; wrong together is agreement.
//   - Any build off the release path. It runs on a tag push, so an image built
//     from a non-release tree, or from a release branch before its tag is
//     pushed, is outside it -- the accept kit's remaining release-version limits,
//     which docs/spec/SERVER_JOB_API.md states.
//   - The shape the accept kit admits. `0.0.0` is the marker the unversioned
//     manifests hold and the kit refuses it, so a `v0.0.0` tag agreeing with a
//     `0.0.0` manifest passes here and still yields a kit naming the floating
//     tag. The release process publishes no such version.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RELEASE_MANIFEST, manifestVersion } from "./lib/releaseManifest.mjs";

export { manifestVersion };

// The release-tag shape .github/workflows/release.yaml triggers on, as a
// capture of the version it names.
const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;

/**
 * The version a release tag names, or undefined when the tag is not in the
 * shape the release workflow triggers on.
 */
export function taggedVersion(tag) {
  const match = RELEASE_TAG.exec(tag ?? "");
  return match === null ? undefined : match[1];
}

/**
 * The reasons a pushed tag and a manifest version do not name one release;
 * empty when they do.
 */
export function agreementViolations(tag, version) {
  const tagged = taggedVersion(tag);
  if (tagged === undefined) {
    return [
      `the pushed tag "${tag}" is not a release tag (vX.Y.Z), so it names no version to check against ${RELEASE_MANIFEST}, which carries ${version === undefined ? "none" : version}`,
    ];
  }
  if (version === undefined) {
    return [
      `the pushed tag "${tag}" names release ${tagged}, but ${RELEASE_MANIFEST} carries no version: the image build would bake none, and the accept kit would name the floating tag instead of ${tagged}`,
    ];
  }
  if (version !== tagged) {
    return [
      `the pushed tag "${tag}" names release ${tagged}, but ${RELEASE_MANIFEST} carries ${version}: the published image would be tagged ${tagged} while its accept kit tells the partner to run ${version}`,
    ];
  }
  return [];
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit. The tag arrives in the environment rather
// than on the command line, so the workflow hands it over without a `${{ }}`
// interpolation into the `run:` line.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const tag = process.env.PSILINK_TAG;
  if (tag === undefined || tag === "") {
    console.error(
      "usage: PSILINK_TAG=vX.Y.Z node scripts/check-release-version.mjs",
    );
    process.exit(2);
  }
  const version = manifestVersion(
    readFileSync(resolve(root, RELEASE_MANIFEST), "utf8"),
  );
  const violations = agreementViolations(tag, version);
  if (violations.length > 0) {
    console.error("Release version check failed:\n");
    for (const violation of violations) console.error("  " + violation);
    console.error(
      `\n${RELEASE_MANIFEST} is the canonical release version (docs/RELEASES.md): bump it in the release pull request, then push the tag that names it.`,
    );
    process.exit(1);
  }
  console.log(
    `Release version check passed: tag ${tag} and ${RELEASE_MANIFEST} both name release ${version}.`,
  );
}
