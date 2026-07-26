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
//
// Every property turns on which package a lockfile entry IS, so the identity
// rules npm matches by are modeled here and pinned by the fixture cases at the
// bottom of the file.

const here = dirname(fileURLToPath(import.meta.url));
const readRootJson = (name) =>
  JSON.parse(readFileSync(resolve(here, "..", name), "utf8"));

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

/** The name and version predicate npm reads out of each policy key. */
function policyEntries(allowScripts) {
  return Object.entries(allowScripts ?? {}).map(([key, verdict]) => {
    const { name, spec } = splitKey(key);
    return { key, verdict, name, matchesVersion: versionPredicate(spec) };
  });
}

const NM = "node_modules/";

// npm identifies a registry package by the name and version baked into the
// lockfile's `resolved` tarball URL, and deliberately by neither of the two
// names closer to hand. Not the tarball's own package.json: its publisher
// controls that file and could claim any name there, so a verdict recorded for
// one package would cover a script belonging to another. Not the install
// directory: an aliased dependency ("h3-v2": "npm:h3@2") installs at
// node_modules/h3-v2 under a name the registry never published, so npm matches
// it only as the registered package `h3`, and an alias used as a policy key
// matches nothing at all. Aliases are not hypothetical here -- this lockfile
// installs several -- so identifying an entry by its directory would both accept
// a verdict npm ignores and reject the one it honors.
//
// A registry tarball lives at <host>/<name>/-/<name>-<version>.tgz, with the
// registry itself possibly mounted below the host's root. Requiring a path
// segment before the `/-/` is what stops a hostile URL of the form
// https://host/-/trusted-1.0.0.tgz from claiming a registered package's name.
const REGISTRY_TARBALL_URL = /^https?:\/\/[^/]+\/.+\/-\/[^/]+-\d/;

/**
 * The package name a registry tarball URL carries, or `null` when it carries
 * none. The tarball filename is delimited by the LAST `/-/` so that a registry
 * mounted below its host's root still resolves; the name is the path segment
 * before that delimiter, prefixed with the segment ahead of it when that one is
 * an `@scope`.
 */
function registryTarballName(url) {
  let pathname;
  try {
    ({ pathname } = new URL(url));
  } catch {
    return null;
  }
  const segments = pathname.slice(1).split("/-/");
  const filename = segments.pop();
  const owner = segments.pop();
  if (owner === undefined) return null;
  if (filename.includes("/") || !filename.endsWith(".tgz")) return null;
  const ownerSegments = owner.split(/\/|%2f/i);
  const project = ownerSegments.pop();
  const scope = ownerSegments.pop();
  if (!filename.startsWith(`${project}-`)) return null;
  return scope?.startsWith("@") ? `${scope}/${project}` : project;
}

/**
 * The identity npm matches one lockfile entry by. `name` is `null` for a source
 * npm matches by its resolved spec rather than by name -- a `file:` tarball or
 * directory, a git URL, a bare remote URL -- so no name-keyed policy entry
 * applies to it. `nameSource` records where the name came from, so a property
 * can hold the real lockfile to the trustworthy source.
 */
function packageIdentity(path, entry) {
  const resolved = typeof entry.resolved === "string" ? entry.resolved : null;
  // The name after the LAST "node_modules/" segment: npm nests a package whose
  // version conflicts with another consumer's at
  // node_modules/<parent>/node_modules/<name>, and reading the first segment
  // would take that entry's name as "<parent>/node_modules/<name>", which
  // matches no policy key.
  const directoryName = path.slice(path.lastIndexOf(NM) + NM.length);
  return {
    path,
    resolved,
    ...trustedName(resolved, directoryName),
    version: entry.version,
    hasInstallScript: entry.hasInstallScript === true,
  };
}

/** One entry's trusted name, with the source that yielded it. */
function trustedName(resolved, directoryName) {
  // Where a resolved URL yields no name, npm reads one from an incoming
  // dependency edge -- the consumer's own spec, alias-aware -- which a lockfile
  // does not expose on its own. The install directory agrees with that edge for
  // everything but an alias, which makes it a usable stand-in and an unsafe
  // one; "directory" labels the entries resting on it.
  if (resolved === null)
    return { name: directoryName, nameSource: "directory" };
  if (!REGISTRY_TARBALL_URL.test(resolved))
    return { name: null, nameSource: null };
  const fromUrl = registryTarballName(resolved);
  return fromUrl === null
    ? { name: directoryName, nameSource: "directory" }
    : { name: fromUrl, nameSource: "resolvedUrl" };
}

/**
 * The lockfile entries npm's install-script gate considers: not the project
 * root or a workspace, not a workspace link (whose lifecycle its owner runs),
 * and not a bundled dependency (npm runs no bundled install script and lets no
 * policy entry allow one, so a verdict naming it governs nothing).
 */
function installedPackages(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(
      ([path, entry]) =>
        path.includes(NM) && entry.link !== true && entry.inBundle !== true,
    )
    .map(([path, entry]) => packageIdentity(path, entry));
}

const matches = (entry, pkg) =>
  pkg.name !== null &&
  entry.name === pkg.name &&
  entry.matchesVersion?.(pkg.version) === true;

/** npm's verdict for one package: a deny beats an allow, `null` if unreviewed. */
function verdictFor(policy, pkg) {
  const applicable = policy.filter((entry) => matches(entry, pkg));
  if (applicable.some((entry) => entry.verdict === false)) return false;
  if (applicable.some((entry) => entry.verdict === true)) return true;
  return null;
}

/** Policy keys npm drops for their spec form, stated but not enforced. */
function unhonoredPolicyKeys(policy) {
  return policy
    .filter((entry) => entry.matchesVersion === null)
    .map(
      (entry) =>
        `"${entry.key}": npm honors a bare name, name@*, one exact version, or exact versions joined by "||" -- it drops a semver range or dist-tag, leaving this verdict stated but not enforced`,
    );
}

/** Policy keys matching no installed package: verdicts governing nothing. */
function deadPolicyKeys(policy, installed) {
  return policy
    .filter(
      (entry) =>
        entry.matchesVersion !== null &&
        !installed.some((pkg) => matches(entry, pkg)),
    )
    .map(
      (entry) =>
        `"${entry.key}": no package in package-lock.json matches it -- delete the entry, or pin it to a version the lockfile installs`,
    );
}

/** Install scripts npm would run or report with no verdict covering them. */
function unreviewedInstallScripts(policy, installed) {
  return installed
    .filter((pkg) => pkg.hasInstallScript && verdictFor(policy, pkg) === null)
    .map((pkg) =>
      pkg.name === null
        ? `${pkg.path} runs an install script and resolves to "${pkg.resolved}", which npm matches by that exact spec rather than by any name -- no name-keyed allowScripts entry can cover it, so record the verdict against the resolved spec and extend this check to match that form`
        : `${pkg.name}@${pkg.version} (${pkg.path}) runs an install script with no allowScripts verdict -- review what the script does, then record true to allow it or false to block it`,
    );
}

const lock = readRootJson("package-lock.json");
const policy = policyEntries(readRootJson("package.json").allowScripts);
const installed = installedPackages(lock);

describe("allowScripts install-script policy", () => {
  it("states every verdict in a spec form npm honors", () => {
    expect(unhonoredPolicyKeys(policy)).toEqual([]);
  });

  it("names only packages the committed lockfile installs", () => {
    expect(deadPolicyKeys(policy, installed)).toEqual([]);
  });

  it("records a verdict for every package with an install script", () => {
    expect(unreviewedInstallScripts(policy, installed)).toEqual([]);
  });

  it("identifies every package it considers by resolved URL, not directory", () => {
    // An install directory carries an alias name npm refuses to match, and the
    // dependency edge npm falls back to instead is invisible from a lockfile,
    // so a package landing on the directory stand-in is a package this check
    // could name wrongly. None does while every entry resolves to a URL naming
    // it; an entry that stopped (a lockfile written with
    // omit-lockfile-registry-resolved, a registry whose tarball filenames
    // disagree with their paths) has to be identified some other way.
    const namedByDirectory = installed
      .filter((pkg) => pkg.nameSource === "directory")
      .map((pkg) => pkg.path);
    expect(namedByDirectory).toEqual([]);
  });
});

describe("the identity npm matches a lockfile entry by", () => {
  it("takes an aliased package's name from its resolved URL, not its directory", () => {
    expect(
      packageIdentity(
        "node_modules/@tanstack/start-server-core/node_modules/h3-v2",
        {
          name: "h3",
          version: "2.0.1-rc.20",
          resolved: "https://registry.npmjs.org/h3/-/h3-2.0.1-rc.20.tgz",
        },
      ),
    ).toMatchObject({ name: "h3", version: "2.0.1-rc.20" });
  });

  it("keeps a scoped package's scope, which the tarball filename drops", () => {
    expect(
      packageIdentity("node_modules/@parcel/watcher", {
        version: "2.5.6",
        resolved:
          "https://registry.npmjs.org/@parcel/watcher/-/watcher-2.5.6.tgz",
      }),
    ).toMatchObject({ name: "@parcel/watcher" });
  });

  it("reads a name from a registry mounted below its host's root", () => {
    expect(
      packageIdentity("node_modules/@scope/pkg", {
        version: "1.0.0",
        resolved:
          "https://artifacts.example.test/nexus/repository/npm-proxy/@scope/pkg/-/pkg-1.0.0.tgz",
      }),
    ).toMatchObject({ name: "@scope/pkg" });
  });

  it("refuses a name to a URL carrying no package path before its /-/", () => {
    expect(
      packageIdentity("node_modules/h3", {
        version: "2.0.1-rc.20",
        resolved: "https://downloads.example.test/-/h3-2.0.1-rc.20.tgz",
      }),
    ).toMatchObject({ name: null });
  });

  it("marks a name taken from the directory when the URL yields none", () => {
    expect(
      packageIdentity("node_modules/h3", {
        version: "2.0.1-rc.20",
        resolved: "https://registry.npmjs.org/h3/-/impostor-2.0.1-rc.20.tgz",
      }),
    ).toMatchObject({ name: "h3", nameSource: "directory" });
  });

  it("gives a nested duplicate the same name as the copy above it", () => {
    expect([
      packageIdentity("node_modules/fsevents", {
        version: "2.3.3",
        resolved: "https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz",
      }),
      packageIdentity("node_modules/playwright/node_modules/fsevents", {
        version: "2.3.2",
        resolved: "https://registry.npmjs.org/fsevents/-/fsevents-2.3.2.tgz",
      }),
    ]).toMatchObject([
      { name: "fsevents", version: "2.3.3" },
      { name: "fsevents", version: "2.3.2" },
    ]);
  });

  it("falls back to the last directory segment with no resolved recorded", () => {
    expect(
      packageIdentity(
        "node_modules/@parcel/watcher-wasm/node_modules/napi-wasm",
        { version: "1.1.0" },
      ),
    ).toMatchObject({ name: "napi-wasm", nameSource: "directory" });
  });

  it("leaves a file: tarball nameless, matched by its resolved spec", () => {
    expect(
      packageIdentity("node_modules/@openmined/psi.js", {
        version: "2.0.6-seclink.3",
        resolved: "file:lib/openmined-psi.js-2.0.6-seclink.3.tgz",
      }),
    ).toMatchObject({
      name: null,
      resolved: "file:lib/openmined-psi.js-2.0.6-seclink.3.tgz",
    });
  });

  it("leaves a git dependency nameless, matched by its resolved spec", () => {
    expect(
      packageIdentity("node_modules/tool", {
        version: "1.0.0",
        resolved:
          "git+ssh://git@github.com/example/tool.git#0123456789abcdef0123456789abcdef01234567",
      }),
    ).toMatchObject({ name: null });
  });
});

describe("the verdict npm reaches for a lockfile entry", () => {
  // `h3` installed twice: once under its own name, once as the alias `h3-v2`,
  // which is the shape this repo's lockfile carries.
  const aliasedH3 = {
    packages: {
      "node_modules/h3": {
        version: "1.15.11",
        resolved: "https://registry.npmjs.org/h3/-/h3-1.15.11.tgz",
        hasInstallScript: true,
      },
      "node_modules/@tanstack/start-server-core/node_modules/h3-v2": {
        name: "h3",
        version: "2.0.1-rc.20",
        resolved: "https://registry.npmjs.org/h3/-/h3-2.0.1-rc.20.tgz",
        hasInstallScript: true,
      },
    },
  };

  it("leaves an install script unreviewed under an alias-named verdict", () => {
    const unreviewed = unreviewedInstallScripts(
      policyEntries({ "h3-v2": false }),
      installedPackages(aliasedH3),
    );
    expect(unreviewed).toHaveLength(2);
    expect(unreviewed.join("\n")).toContain(
      "h3@2.0.1-rc.20 (node_modules/@tanstack/start-server-core/node_modules/h3-v2)",
    );
  });

  it("reads an alias-named verdict as governing nothing", () => {
    expect(
      deadPolicyKeys(
        policyEntries({ "h3-v2": false }),
        installedPackages(aliasedH3),
      ),
    ).toHaveLength(1);
  });

  it("covers both installs from one verdict on the registered name", () => {
    const registeredName = policyEntries({
      "h3@1.15.11 || 2.0.1-rc.20": false,
    });
    expect(
      unreviewedInstallScripts(registeredName, installedPackages(aliasedH3)),
    ).toEqual([]);
    expect(
      deadPolicyKeys(registeredName, installedPackages(aliasedH3)),
    ).toEqual([]);
  });

  it("covers a nested duplicate only at the version it installs", () => {
    const bothVersions = {
      packages: {
        "node_modules/fsevents": {
          version: "2.3.3",
          resolved: "https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz",
          hasInstallScript: true,
        },
        "node_modules/playwright/node_modules/fsevents": {
          version: "2.3.2",
          resolved: "https://registry.npmjs.org/fsevents/-/fsevents-2.3.2.tgz",
          hasInstallScript: true,
        },
      },
    };
    const unreviewed = unreviewedInstallScripts(
      policyEntries({ "fsevents@2.3.3": false }),
      installedPackages(bothVersions),
    );
    expect(unreviewed).toHaveLength(1);
    expect(unreviewed[0]).toContain(
      "fsevents@2.3.2 (node_modules/playwright/node_modules/fsevents)",
    );
  });

  it("takes no name-keyed verdict for a non-registry source", () => {
    const vendored = {
      packages: {
        "node_modules/@openmined/psi.js": {
          version: "2.0.6-seclink.3",
          resolved: "file:lib/openmined-psi.js-2.0.6-seclink.3.tgz",
          hasInstallScript: true,
        },
      },
    };
    const unreviewed = unreviewedInstallScripts(
      policyEntries({ "@openmined/psi.js": true }),
      installedPackages(vendored),
    );
    expect(unreviewed).toHaveLength(1);
    expect(unreviewed[0]).toContain(
      'resolves to "file:lib/openmined-psi.js-2.0.6-seclink.3.tgz"',
    );
    expect(unreviewed[0]).toContain("against the resolved spec");
  });

  it("considers no bundled dependency, whose install script never runs", () => {
    const bundled = {
      packages: {
        "node_modules/@parcel/watcher-wasm/node_modules/napi-wasm": {
          version: "1.1.0",
          inBundle: true,
          hasInstallScript: true,
        },
      },
    };
    expect(
      unreviewedInstallScripts(policyEntries({}), installedPackages(bundled)),
    ).toEqual([]);
    expect(
      deadPolicyKeys(
        policyEntries({ "napi-wasm": false }),
        installedPackages(bundled),
      ),
    ).toHaveLength(1);
  });

  it("considers neither a workspace nor its link, whose owner runs both", () => {
    const workspace = {
      packages: {
        "apps/cli": {
          name: "psilink",
          version: "0.1.0",
          hasInstallScript: true,
        },
        "node_modules/psilink": { resolved: "apps/cli", link: true },
      },
    };
    expect(
      unreviewedInstallScripts(policyEntries({}), installedPackages(workspace)),
    ).toEqual([]);
    expect(
      deadPolicyKeys(
        policyEntries({ psilink: false }),
        installedPackages(workspace),
      ),
    ).toHaveLength(1);
  });
});
