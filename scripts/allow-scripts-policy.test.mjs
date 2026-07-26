import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The root package.json's `allowScripts` map is npm's own install-script policy
// field (npm 11.17 and later, maintained with `npm approve-scripts`), read from
// the prefix package.json on every install: a `false` verdict blocks that
// package's install script, and a package with no verdict draws a warning npm
// says a future release will turn into a refusal. Two ways the map rots with no
// diagnostic at all. An entry naming a package the tree no longer installs
// matches nothing, so it reads as a live verdict while governing nothing. An
// entry whose spec npm refuses to honor is dropped from the policy entirely --
// npm logs one warning and continues -- so the verdict it appears to state is
// not in force. The third property below is npm's own `--strict-allow-scripts`
// preflight, held green here so the repo could adopt that flag without an audit.
// Reasoning and the posture: docs/spec/DEPENDENCY_PINS.md.

const here = dirname(fileURLToPath(import.meta.url));
const readRootJson = (name) =>
  JSON.parse(readFileSync(resolve(here, "..", name), "utf8"));

const lock = readRootJson("package-lock.json");
const policy = Object.entries(readRootJson("package.json").allowScripts ?? {});

// semver.org's own grammar for a single version, which is what npm requires of
// each part of a policy key: a comparator (^, ~, >=, <) or a dist-tag is not one.
const EXACT_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

// Build metadata does not participate in semver comparison, so npm's matcher
// ignores it on both sides.
const comparable = (version) => String(version).replace(/\+.*$/, "");

/** Split a policy key into its package name and version spec, scope-aware. */
function splitKey(key) {
  const separator = key.indexOf("@", key.startsWith("@") ? 1 : 0);
  return separator === -1
    ? { name: key, spec: "" }
    : { name: key.slice(0, separator), spec: key.slice(separator + 1) };
}

/**
 * The version predicate npm derives from a key's spec, or `null` when npm would
 * drop the key: a bare name or `*` covers every version, and the only other
 * honored forms are one exact version and exact versions joined by `||`.
 */
function versionPredicate(spec) {
  const trimmed = spec.trim();
  if (trimmed === "" || trimmed === "*") return () => true;
  const versions = trimmed.split("||").map((part) => part.trim());
  if (!versions.every((version) => EXACT_VERSION.test(version))) return null;
  const comparableVersions = versions.map(comparable);
  return (version) => comparableVersions.includes(comparable(version));
}

const entries = policy.map(([key, verdict]) => {
  const { name, spec } = splitKey(key);
  return { key, verdict, name, matchesVersion: versionPredicate(spec) };
});

// Read the name after the LAST "node_modules/" segment: npm nests a package
// whose version conflicts with another consumer's at
// node_modules/<parent>/node_modules/<name>, and this lockfile installs a second
// fsevents that way. Reading the first segment instead would take the nested
// entry's name as "<parent>/node_modules/<name>", which matches no policy key,
// so its install script would read as uncovered whatever verdict the map records.
const NM = "node_modules/";
const installed = Object.entries(lock.packages)
  .filter(([path]) => path.includes(NM))
  .map(([path, entry]) => ({
    path,
    name: path.slice(path.lastIndexOf(NM) + NM.length),
    version: entry.version,
    hasInstallScript: entry.hasInstallScript === true,
  }));

const matches = (entry, pkg) =>
  entry.name === pkg.name && entry.matchesVersion?.(pkg.version) === true;

/** npm's verdict for one package: a deny beats an allow, `null` if unreviewed. */
function verdictFor(pkg) {
  const applicable = entries.filter((entry) => matches(entry, pkg));
  if (applicable.some((entry) => entry.verdict === false)) return false;
  if (applicable.some((entry) => entry.verdict === true)) return true;
  return null;
}

describe("allowScripts install-script policy", () => {
  it("states every verdict in a spec form npm honors", () => {
    const dropped = entries
      .filter((entry) => entry.matchesVersion === null)
      .map(
        (entry) =>
          `"${entry.key}": npm honors a bare name, name@*, one exact version, or exact versions joined by "||" -- it drops a semver range or dist-tag, leaving this verdict stated but not enforced`,
      );
    expect(dropped).toEqual([]);
  });

  it("names only packages the committed lockfile installs", () => {
    const unmatched = entries
      .filter(
        (entry) =>
          entry.matchesVersion !== null &&
          !installed.some((pkg) => matches(entry, pkg)),
      )
      .map(
        (entry) =>
          `"${entry.key}": no package in package-lock.json matches it -- delete the entry, or pin it to a version the lockfile installs`,
      );
    expect(unmatched).toEqual([]);
  });

  it("records a verdict for every package with an install script", () => {
    const unreviewed = installed
      .filter((pkg) => pkg.hasInstallScript && verdictFor(pkg) === null)
      .map(
        (pkg) =>
          `${pkg.name}@${pkg.version} (${pkg.path}) runs an install script with no allowScripts verdict -- review what the script does, then record true to allow it or false to block it`,
      );
    expect(unreviewed).toEqual([]);
  });
});
