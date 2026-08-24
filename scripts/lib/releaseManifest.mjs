// The canonical release version and where it is read from, shared by the two
// checks that read it: check-release-version.mjs holds a pushed release tag to
// it, and check-protocol-version-bump.mjs reads it as the marker deciding
// whether the wire-format pin binds yet. One manifest path and one reader, so
// the two cannot come to disagree about which file carries the release version
// or what counts as carrying one.

/** The manifest carrying the canonical release version (docs/RELEASES.md). */
export const RELEASE_MANIFEST = "apps/cli/package.json";

/**
 * The release version a package manifest's source carries, or undefined when it
 * carries none -- an absent `version` key and an empty one alike, since the
 * image build bakes either as nothing.
 */
export function manifestVersion(manifestSource) {
  const { version } = JSON.parse(manifestSource);
  return typeof version === "string" && version !== "" ? version : undefined;
}
