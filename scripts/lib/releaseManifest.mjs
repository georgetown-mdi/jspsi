// The canonical release version, where it is read from, and what counts as a
// published one, shared by the checks that read it: check-release-version.mjs
// holds a pushed release tag to it, check-protocol-version-bump.mjs reads it as
// the marker deciding whether the wire-format pin binds yet, and
// check-exchange-record-version.mjs as the marker the record-format reset is
// dated by. One manifest path, one reader, and one publication floor, so no two of
// them can come to disagree about which file carries the release version, what
// counts as carrying one, or when first publication happens.

/** The manifest carrying the canonical release version (docs/RELEASES.md). */
export const RELEASE_MANIFEST = "apps/cli/package.json";

// The release below which nothing has been published. The v0.1.0 tag and the
// CHANGELOG heading beside it name a proof-of-concept whose tree predates the
// current protocol outright -- no packages/core, no PROTOCOL_VERSION, no
// exchange record, no CHANGELOG -- so it deployed no peer a version reconcile
// can meet and shipped no artifact carrying either format literal. The next
// release of any number is the first that can, so the floor is that release
// rather than a 1.0 milestone: a marker that waits for 1.0 would read a
// published 0.2.0 as pre-publication, which is the silent miss rather than the
// loud false alarm. Moving this floor moves every rule dated by it.
export const PRE_PUBLICATION_RELEASE = "0.1.0";

/**
 * The release version a package manifest's source carries, or undefined when it
 * carries none -- an absent `version` key and an empty one alike, since the
 * image build bakes either as nothing.
 */
export function manifestVersion(manifestSource) {
  const { version } = JSON.parse(manifestSource);
  return typeof version === "string" && version !== "" ? version : undefined;
}

/**
 * The `major.minor.patch` triple a release version names, or undefined when the
 * value is not in that shape. A prerelease or build suffix is read as the
 * release it qualifies: a published `0.2.0-rc.1` deploys peers exactly as
 * `0.2.0` does.
 */
export function parseReleaseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(
    typeof version === "string" ? version : "",
  );
  return match === null
    ? undefined
    : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * How two release versions order, as -1, 0, or 1, or undefined when either is
 * not in a shape this can read. Undefined is not "equal": a caller that cannot
 * read one of them fails rather than treating the comparison as settled.
 */
export function compareReleaseVersions(left, right) {
  const first = parseReleaseVersion(left);
  const second = parseReleaseVersion(right);
  if (first === undefined || second === undefined) return undefined;
  for (let i = 0; i < first.length; i += 1) {
    if (first[i] !== second[i]) return first[i] > second[i] ? 1 : -1;
  }
  return 0;
}

/**
 * Whether the release version names a published deployment, or undefined when
 * the version is not in a shape this can read. Undefined is not "no": a caller
 * that cannot read the marker fails rather than treating the rule as inert.
 */
export function isPublishedRelease(version) {
  const compared = compareReleaseVersions(version, PRE_PUBLICATION_RELEASE);
  return compared === undefined ? undefined : compared > 0;
}
